import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import {
  extractSessionText,
  extractToolContext,
  promptWithAbort,
} from '../utils/session';

const COMMAND_NAME = 'loop';

const REVIEW_CRITERIA = `# Evaluation Criteria

1. Does the implementation make full use of language features? Are the correct algorithms and data structures used?
2. Is the implementation no more complex than necessary? If the implementation complexity exceeds the Kolmogorov complexity of the problem — if there is a simpler way to express the same logic with fewer moving parts, fewer abstractions, fewer lines — you must propose it. Every line of code is a liability. Prefer the simplest correct solution.
3. Is the program structure elegant — higher-order functions, no redundancy, clear separation of concerns?
4. Are there no oversized files, overly long functions, ball-of-mud architecture, or spaghetti code?
5. Are there necessary unit tests? Are integration tests needed?
6. Are there design flaws, mathematical errors, logical contradictions, architecture issues, or violations of best practices?
7. From the user/caller perspective: can they use it naturally? Is the API intuitive? Is it elegant?
8. Does it fully satisfy the requirements? Is it cutting corners? Is it using "good enough for now" as an excuse to avoid work?`;

const REVIEW_INSTRUCTIONS = `You are a code reviewer performing a rigorous review of submitted work.

${REVIEW_CRITERIA}

Based on the original task, change report, and affected files above, read and inspect the actual file contents before making your judgment. The original task is the authoritative requirement — verify that the implementation satisfies it, not just that it matches the self-reported change report.

# Submitting Your Verdict

submit_review_result({ "feedback": null })          // Accept — pass with no feedback
submit_review_result({ "feedback": "specific..." }) // Reject — provide detailed, actionable feedback

IMPORTANT: If you accept, feedback MUST be null. Do not write praise or any other text — it will be misinterpreted as rejection feedback.

You MUST call submit_review_result before finishing. Do not end the conversation without submitting your verdict.`;

const REVIEWER_NUDGE_PROMPT =
  'You have not submitted your review verdict yet.\n\n' +
  'You must call submit_review_result to submit your verdict:\n' +
  '  submit_review_result({ "feedback": null })          // Accept\n' +
  '  submit_review_result({ "feedback": "details..." })  // Reject\n\n' +
  'Do not explain what you plan to do — call the tool immediately.';

const MAX_REVIEWER_NUDGES = 3;

const NUDGE_PROMPT =
  'You are in loop mode. You must call the submit_review tool to\n' +
  'submit your detailed report and list of modified files for review\n' +
  'before finishing. Do not end the conversation without calling submit_review.';

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

interface ReviewResult {
  feedback: string | null;
}

interface ReviewSessionEntry {
  active: boolean;
  pendingResult?: Deferred<ReviewResult>;
  originalTask?: string;
}

const reviewSessions = new Map<string, ReviewSessionEntry>();

function isReviewSession(sessionID: string): boolean {
  return reviewSessions.get(sessionID)?.active === true;
}

function setReviewSession(sessionID: string, active: boolean): void {
  if (!active) {
    reviewSessions.delete(sessionID);
    return;
  }
  const entry = reviewSessions.get(sessionID);
  if (entry) {
    entry.active = active;
  } else {
    reviewSessions.set(sessionID, { active });
  }
}

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
      setReviewSession(sid, false);
      output.parts.push({ type: 'text', text: 'loop mode cancelled.' });
      return;
    }

    const sessionID = input.sessionID;

    if (isReviewSession(sessionID)) {
      output.parts.push(
        { type: 'text', text: 'loop mode is already active. Submit your work via submit_review.' },
      );
      return;
    }

    setReviewSession(sessionID, true);
    const entry = reviewSessions.get(sessionID);
    if (entry) entry.originalTask = task;

    output.parts.push(
      { type: 'text', text:
        `Task (loop): ${task}\n\n` +
          'loop mode is active. Complete the task above, then call submit_review with:\n' +
          '- report: a detailed description of what you did and why\n' +
          '- affectedFiles: list of every file you modified or created\n\n' +
          'A reviewer will examine your submission. If accepted, you are done. If rejected, you will receive specific feedback to address.' },
    );
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
      const reviewSession = reviewSessions.get(context.sessionID);
      if (!reviewSession?.pendingResult) {
        return 'Error: No pending review to resolve.';
      }

      const feedback =
        args.feedback == null
          ? null
          : args.feedback.trim().length === 0
            ? null
            : args.feedback;

      reviewSession.pendingResult.resolve({ feedback });
      reviewSession.pendingResult = undefined;

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
  const deferred = new Deferred<ReviewResult>();
  const entry = reviewSessions.get(childID);
  if (entry) {
    entry.pendingResult = deferred;
  } else {
    reviewSessions.set(childID, {
      active: false,
      pendingResult: deferred,
    });
  }

  let nudgeCount = 0;

  while (true) {
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
      abortSignal,
    )
      .then(() => ({ type: 'prompt_done' as const }))
      .catch((error) => ({ type: 'error' as const, error }));

    const result = await Promise.race([
      deferred.promise.then((r) => ({ type: 'result' as const, result: r })),
      promptPromise,
    ]);

    if (result.type === 'result') {
      reviewSessions.delete(childID);
      return result.result;
    }

    if (result.type === 'error') {
      reviewSessions.delete(childID);
      if (result.error instanceof DOMException && result.error.name === 'AbortError') {
        return { feedback: 'Review aborted.' };
      }
      return { feedback: result.error instanceof Error ? result.error.message : String(result.error) };
    }

    nudgeCount++;
    if (nudgeCount >= MAX_REVIEWER_NUDGES) {
      reviewSessions.delete(childID);
      const text = await extractSessionText(client, childID, directory);
      return { feedback: text || 'Reviewer failed to complete review after multiple attempts.' };
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
      const { directory, sessionID, abortSignal } = extractToolContext(context, ctx.directory);

      if (!sessionID || !isReviewSession(sessionID)) {
        return 'You do not need review. Just continue with your work.';
      }

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

      const entry = reviewSessions.get(sessionID);
      if (entry?.originalTask) {
        parts.push({ type: 'text', text: '=== Original Task ===\n\n' + entry.originalTask });
      }

      const createResult = await client.session.create({
        query: { directory },
        body: {
          parentID: sessionID,
          title: 'Reviewer',
        },
      });
      const childID = createResult.data?.id;
      if (!childID) return 'Failed to create reviewer session';

      const result = await runReviewerWithNudge(client, childID, parts, directory, abortSignal);

      if (result.feedback == null) {
        setReviewSession(sessionID!, false);
        return 'Review passed. Your changes have been accepted. loop mode has ended.';
      }

      return `Review feedback:\n\n${result.feedback}\n\nAddress the feedback above. loop mode is still active — fix the issues and call submit_review again.`;
    },
  });
}

export function createLoopNudgeHook(ctx: PluginInput) {
  let suppressUntil = 0;

  return {
    handleEvent: async (input: {
      event: { type: string; properties?: Record<string, unknown> };
    }): Promise<void> => {
      const { event } = input;
      const props = event.properties ?? {};
      const sessionID = props.sessionID as string | undefined;
      if (!sessionID) return;

      if (event.type === 'session.idle') {
        if (Date.now() < suppressUntil) return;
        if (!isReviewSession(sessionID)) return;

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
          todos = result.data as typeof todos;
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
          const messages = (msgResult.data ?? []) as Array<{
            info?: { role?: string };
            parts?: Array<{ type?: string; text?: string }>;
          }>;
          const lastAssistant = [...messages].reverse().find((m) => m.info?.role === 'assistant');
          if (lastAssistant) {
            const fullText = (lastAssistant.parts ?? [])
              .filter((p) => p.type === 'text' && p.text)
              .map((p) => p.text!)
              .join('\n');
            if (fullText.includes('<skip-loop-check />')) return;
          }
        } catch {
          // best-effort
        }

        try {
          await ctx.client.session.prompt({
            path: { id: sessionID },
            body: { parts: [{ type: 'text', text: NUDGE_PROMPT }] },
          });
        } catch {
          // best-effort
        }
        return;
      }

      if (event.type === 'session.error') {
        const error = props.error as { name?: string } | undefined;
        if (
          error?.name === 'MessageAbortedError' ||
          error?.name === 'AbortError'
        ) {
          suppressUntil = Date.now() + SUPPRESS_AFTER_ABORT_MS;
        }
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
        permission: {
          '*': 'deny',
          read: 'allow',
          bash: 'allow',
        } as Record<string, unknown>,
      },
    },
  };
}

export {
  isReviewSession,
  setReviewSession,
  reviewSessions,
  Deferred,
  ReviewResult,
};
