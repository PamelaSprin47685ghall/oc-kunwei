import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import {
  createAbortSuppressor,
  isAbortError,
  isAbortErrorName,
} from 'engine/util';
import {
  LOOP_NUDGE_PROMPT,
  REVIEW_INSTRUCTIONS,
  REVIEWER_NUDGE_PROMPT,
  type ReviewResult,
  activateReview,
  addChild,
  clearReviewSessions,
  deactivateReview,
  getReviewTask,
  isReviewActive,
  resolvePendingReview,
  setPendingReview,
  tryLockReview,
  unlockReview,
} from 'engine/review';
import {
  asMessageArray,
  asTodoArray,
  extractSessionText,
  extractToolContext,
  promptWithAbort,
} from '../utils/session';

const COMMAND_NAME = 'loop';

const MAX_REVIEWER_NUDGES = 3;

const REVIEWER_GRACE_MS = 1500;
const GRACE_TIMEOUT = Symbol('grace_timeout');

const SUPPRESS_AFTER_ABORT_MS = 5_000;

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  private _isResolved = false;

  constructor() {
    this.promise = new Promise<T>((r) => {
      this.resolve = (val: T) => {
        if (this._isResolved) return;
        this._isResolved = true;
        r(val);
      };
    });
  }
}

class ReviewSessionManager {
  activate(sessionID: string, task: string): void {
    activateReview(sessionID, task);
  }

  addChild(parentID: string, childID: string): void {
    addChild(parentID, childID);
  }

  deactivate(sessionID: string): void {
    deactivateReview(sessionID);
  }

  isActive(sessionID: string): boolean {
    return isReviewActive(sessionID);
  }

  unlock(sessionID: string): void {
    unlockReview(sessionID);
  }

  tryLock(sessionID: string): boolean {
    return tryLockReview(sessionID);
  }

  setPending(sessionID: string, deferred: Deferred<ReviewResult>): void {
    setPendingReview(sessionID, (result) => deferred.resolve(result));
  }

  resolvePending(sessionID: string, result: ReviewResult): boolean {
    return resolvePendingReview(sessionID, result);
  }

  getTask(sessionID: string): string | undefined {
    return getReviewTask(sessionID);
  }

  delete(sessionID: string): void {
    deactivateReview(sessionID);
  }

  clear(): void {
    clearReviewSessions();
  }
}

const reviewSessions = new ReviewSessionManager();

export function createLoopCommandManager(_ctx: PluginInput) {
  function registerCommand(opencodeConfig: Record<string, unknown>): void {
    const configCommand = opencodeConfig.command as
      | Record<string, unknown>
      | undefined;
    if (!configCommand?.[COMMAND_NAME]) {
      if (!opencodeConfig.command) {
        opencodeConfig.command = {};
      }
      (opencodeConfig.command as Record<string, unknown>)[COMMAND_NAME] = {
        template: 'Enable loop mode.',
        description:
          'Enable loop mode — the next submission must pass through a reviewer before being accepted',
      };
    }
  }

  async function handleCommandExecuteBefore(
    input: {
      command: string;
      sessionID: string;
      arguments: string;
    },
    output: { parts: Array<{ type: string; text?: string }> },
  ): Promise<void> {
    if (input.command !== COMMAND_NAME) return;

    output.parts.length = 0;

    const task = input.arguments.trim();
    if (!task) {
      const sid = input.sessionID;
      reviewSessions.deactivate(sid);
      output.parts.push({ type: 'text', text: 'loop mode cancelled.' });
      return;
    }

    const sessionID = input.sessionID;

    if (reviewSessions.isActive(sessionID)) {
      output.parts.push({
        type: 'text',
        text: 'loop mode is already active. Submit your work via submit_review.',
      });
      return;
    }

    reviewSessions.activate(sessionID, task);

    output.parts.push({
      type: 'text',
      text:
        `Task (loop): ${task}\n\n` +
        'loop mode is active. Complete the task above, then call submit_review with:\n' +
        '- report: a detailed description of what you did and why\n' +
        '- affectedFiles: list of every file you modified or created\n\n' +
        'A reviewer will examine your submission. If accepted, you are done. If rejected, you will receive specific feedback to address.',
    });
  }

  return { registerCommand, handleCommandExecuteBefore };
}

export function createSubmitReviewResultTool(): ToolDefinition {
  return tool({
    description:
      'Submit your review verdict.\n' +
      '\n' +
      'null feedback = accept. Non-null feedback = reject with specific feedback.',

    args: {
      feedback: tool.schema
        .string()
        .nullable()
        .describe(
          'null = accept. Non-null = reject with specific actionable feedback.',
        ),
    },

    async execute(args, context) {
      const feedback =
        args.feedback == null
          ? null
          : args.feedback.trim().length === 0
            ? null
            : args.feedback;

      const resolved = reviewSessions.resolvePending(context.sessionID, {
        feedback,
      });
      if (!resolved) {
        return 'Error: No pending review to resolve.';
      }

      return feedback == null
        ? 'Review submitted: accepted.'
        : 'Review submitted: rejected with feedback.';
    },
  });
}

async function runReviewerWithNudge(
  client: PluginInput['client'],
  childID: string,
  parts: Array<{ type: 'text'; text: string }>,
  directory?: string,
  abortSignal?: AbortSignal,
): Promise<ReviewResult> {
  if (abortSignal?.aborted) {
    reviewSessions.delete(childID);
    return { feedback: 'Review aborted.', terminated: true };
  }

  const deferred = new Deferred<ReviewResult>();
  reviewSessions.setPending(childID, deferred);

  let nudgeCount = 0;

  while (true) {
    if (abortSignal?.aborted) {
      reviewSessions.delete(childID);
      return { feedback: 'Review aborted.', terminated: true };
    }

    const iterAbort = new AbortController();
    const onOuterAbort = () => iterAbort.abort();
    abortSignal?.addEventListener('abort', onOuterAbort);

    const promptPromise = promptWithAbort(
      client,
      {
        path: { id: childID },
        body: {
          agent: 'reviewer',
          parts:
            nudgeCount === 0
              ? parts
              : [{ type: 'text', text: REVIEWER_NUDGE_PROMPT }],
          tools: { submit_review_result: true },
        },
      },
      iterAbort.signal,
    )
      .then(() => ({ type: 'prompt_done' as const }))
      .catch((error) => ({ type: 'error' as const, error }));

    const result = await Promise.race([
      deferred.promise.then((r) => ({ type: 'result' as const, result: r })),
      promptPromise,
    ]);

    abortSignal?.removeEventListener('abort', onOuterAbort);
    iterAbort.abort();

    if (result.type === 'result') {
      reviewSessions.delete(childID);
      return result.result;
    }

    if (result.type === 'error') {
      reviewSessions.delete(childID);
      if (isAbortError(result.error)) {
        return { feedback: 'Review aborted.', terminated: true };
      }
      return {
        feedback:
          result.error instanceof Error
            ? result.error.message
            : String(result.error),
        terminated: true,
      };
    }

    const graceResult = await Promise.race([
      deferred.promise,
      new Promise<typeof GRACE_TIMEOUT>((resolve) =>
        setTimeout(() => resolve(GRACE_TIMEOUT), REVIEWER_GRACE_MS),
      ),
    ]);

    if (graceResult !== GRACE_TIMEOUT) {
      reviewSessions.delete(childID);
      return graceResult;
    }

    nudgeCount++;
    if (nudgeCount >= MAX_REVIEWER_NUDGES) {
      reviewSessions.delete(childID);
      const text = await extractSessionText(client, childID, directory);
      return {
        feedback:
          text || 'Reviewer failed to complete review after multiple attempts.',
        terminated: true,
      };
    }
  }
}

export function createSubmitReviewTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Submit work for review. Only available during loop mode (activated by /loop).',

    args: {
      report: tool.schema
        .string()
        .min(1)
        .describe('Detailed report of what was done'),
      affectedFiles: tool.schema
        .array(tool.schema.string())
        .describe('List of file paths that were modified or created'),
    },

    async execute(args, context) {
      const { directory, sessionID, abortSignal } = extractToolContext(
        context,
        ctx.directory,
      );

      if (!sessionID || !reviewSessions.isActive(sessionID)) {
        return 'You do not need review. Just continue with your work.';
      }

      if (!reviewSessions.tryLock(sessionID)) {
        return 'A review is already in progress. Wait for it to finish.';
      }

      try {
        const parts: Array<{ type: 'text'; text: string }> = [];

        parts.push({
          type: 'text',
          text: REVIEW_INSTRUCTIONS,
        });

        parts.push({
          type: 'text',
          text: `=== Change Report ===\n\n${args.report}`,
        });

        parts.push({
          type: 'text',
          text: `=== Affected Files ===\n\n${args.affectedFiles.join('\n')}`,
        });

        const task = reviewSessions.getTask(sessionID);
        if (task) {
          parts.push({
            type: 'text',
            text: `=== Original Task ===\n\n${task}`,
          });
        }

        const createResult = await client.session.create({
          query: { directory },
          body: {
            parentID: sessionID,
            title: 'Reviewer',
          },
        });
        const childID = createResult.data?.id;
        if (!childID) {
          return 'Failed to create reviewer session';
        }
        reviewSessions.addChild(sessionID, childID);

        const result = await runReviewerWithNudge(
          client,
          childID,
          parts,
          directory,
          abortSignal,
        );

        if (result.feedback == null) {
          reviewSessions.deactivate(sessionID);
          return 'Review passed. Your changes have been accepted. loop mode has ended.';
        }

        if (result.terminated) {
          reviewSessions.deactivate(sessionID);
          return `Review terminated: ${result.feedback}`;
        }

        return `Review feedback:\n\n${result.feedback}\n\nAddress the feedback above. loop mode is still active — fix the issues and call submit_review again.`;
      } finally {
        reviewSessions.unlock(sessionID);
      }
    },
  });
}

export function createLoopNudgeHook(ctx: PluginInput) {
  const suppressor = createAbortSuppressor(SUPPRESS_AFTER_ABORT_MS);

  return {
    handleEvent: async (input: {
      event: { type: string; properties?: Record<string, unknown> };
    }): Promise<void> => {
      const { event } = input;
      const props = event.properties ?? {};
      const sessionID = props.sessionID as string | undefined;
      if (!sessionID) return;

      if (event.type === 'session.idle') {
        if (suppressor.isSuppressed()) return;
        if (!reviewSessions.isActive(sessionID)) return;

        let todos: Array<{
          id: string;
          content: string;
          status: string;
          priority: string;
        }>;
        try {
          const result = await ctx.client.session.todo({
            path: { id: sessionID },
          });
          todos = asTodoArray(result.data);
        } catch {
          return;
        }

        const open = todos.filter(
          (t) => !['completed', 'cancelled'].includes(t.status),
        );
        if (open.length > 0) return;

        // If the last assistant message contains <skip-loop-check />, suppress the nudge
        try {
          const msgResult = await ctx.client.session.messages({
            path: { id: sessionID },
          });
          const messages = asMessageArray(msgResult.data);
          const lastAssistant = [...messages]
            .reverse()
            .find((m) => m.info?.role === 'assistant');
          if (lastAssistant) {
            const fullText = (lastAssistant.parts ?? [])
              .filter((p) => p.type === 'text' && p.text)
              .map((p) => p.text ?? '')
              .join('\n');
            if (fullText.includes('<skip-loop-check />')) return;
          }
        } catch {
          // best-effort
        }

        try {
          await ctx.client.session.prompt({
            path: { id: sessionID },
            body: { parts: [{ type: 'text', text: LOOP_NUDGE_PROMPT }] },
          });
        } catch {
          // best-effort
        }
        return;
      }

      if (event.type === 'session.error') {
        const error = props.error as { name?: string } | undefined;
        if (isAbortErrorName(error?.name)) {
          suppressor.suppress();
        }
      }

      if (
        event.type === 'session.delete' ||
        event.type === 'session.close' ||
        event.type === 'session.remove'
      ) {
        reviewSessions.deactivate(sessionID);
      }
    },
  };
}

export function getReviewerConfig() {
  return {
    agents: {
      reviewer: {
        prompt: 'You are a code reviewer...',
        mode: 'subagent' as const,
        mcps: [],
        permission: {
          read: 'allow',
          bash: 'deny',
          edit: 'deny',
          write: 'deny',
          glob: 'deny',
          grep: 'deny',
          fuzzy_find: 'deny',
          fuzzy_grep: 'deny',
          task: 'deny',
        } as Record<string, unknown>,
      },
    },
  };
}

export { Deferred, type ReviewResult, reviewSessions };
