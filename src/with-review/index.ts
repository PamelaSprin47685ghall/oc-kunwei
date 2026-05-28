import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { extractSessionText } from '../utils/session';

const COMMAND_NAME = 'with-review';
const INTERNAL_MARKER = '<!-- CAPS_INTERNAL_INITIATOR -->';

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

Based on the change report and affected files above, read and inspect the actual file contents before making your judgment.

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
  'You are in with-review mode. You must call the submit_review tool to\n' +
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
}

const reviewSessions = new Map<string, ReviewSessionEntry>();

function isReviewSession(sessionID: string): boolean {
  return reviewSessions.get(sessionID)?.active === true;
}

function setReviewSession(sessionID: string, active: boolean): void {
  const entry = reviewSessions.get(sessionID);
  if (entry) {
    entry.active = active;
  } else {
    reviewSessions.set(sessionID, { active });
  }
}

function createInternalAgentTextPart(text: string): {
  type: 'text';
  text: string;
} {
  return { type: 'text', text: `${text}\n${INTERNAL_MARKER}` };
}

export function createWithReviewCommandManager(_ctx: PluginInput) {
  function registerCommand(opencodeConfig: Record<string, unknown>): void {
    const configCommand = opencodeConfig.command as
      | Record<string, unknown>
      | undefined;
    if (!configCommand?.[COMMAND_NAME]) {
      if (!opencodeConfig.command) {
        opencodeConfig.command = {};
      }
      (opencodeConfig.command as Record<string, unknown>)[COMMAND_NAME] = {
        template: 'Enable with-review mode.',
        description:
          'Enable with-review mode — the next submission must pass through a reviewer before being accepted',
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
    if (!task) return;

    const sessionID = input.sessionID;

    if (isReviewSession(sessionID)) {
      output.parts.push(
        createInternalAgentTextPart(
          'with-review mode is already active. Submit your work via submit_review.',
        ),
      );
      return;
    }

    setReviewSession(sessionID, true);

    output.parts.push(
      createInternalAgentTextPart(
        `Task (with-review): ${task}\n\n` +
          'with-review mode is active. Complete the task above, then call submit_review with:\n' +
          '- report: a detailed description of what you did and why\n' +
          '- affectedFiles: list of every file you modified or created\n\n' +
          'A reviewer will examine your submission. If accepted, you are done. If rejected, you will receive specific feedback to address.',
      ),
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
    const promptPromise = client.session
      .prompt({
        path: { id: childID },
        body: {
          agent: 'explorer',
          parts:
            nudgeCount === 0
              ? parts
              : [{ type: 'text', text: REVIEWER_NUDGE_PROMPT }],
          tools: { submit_review_result: true },
        },
      })
      .then(() => ({ type: 'prompt_done' as const }))
      .catch(() => ({ type: 'prompt_done' as const }));

    const result = await Promise.race([
      deferred.promise.then((r) => ({ type: 'result' as const, result: r })),
      promptPromise,
    ]);

    if (result.type === 'result') {
      return result.result;
    }

    nudgeCount++;
    if (nudgeCount >= MAX_REVIEWER_NUDGES) {
      const text = await extractSessionText(client, childID);
      return { feedback: text || null };
    }
  }
}

export function createSubmitReviewTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Submit work for review. Only available during with-review mode (activated by /with-review).',

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
      if (!isReviewSession(context.sessionID)) {
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

      const createResult = await client.session.create();
      const childID = createResult.data?.id;
      if (!childID) return 'Failed to create reviewer session';

      const result = await runReviewerWithNudge(client, childID, parts);

      setReviewSession(context.sessionID, false);

      if (result.feedback == null) {
        return 'Review passed. Your changes have been accepted. with-review mode has ended.';
      }

      return `Review feedback:\n\n${result.feedback}\n\nAddress the feedback above. with-review mode has ended — you may continue normally.`;
    },
  });
}

export function createWithReviewNudgeHook(ctx: PluginInput) {
  let suppressUntil = 0;

  return {
    handleEvent: async (input: {
      event: { type: string; properties?: Record<string, unknown> };
    }): Promise<void> => {
      const { event } = input;
      const props = event.properties ?? {};
      const sessionID = props.sessionID as string | undefined;
      if (!sessionID) return;

      if (
        event.type === 'session.idle' ||
        (event.type === 'session.status' &&
          (props.status as { type?: string })?.type === 'idle')
      ) {
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
          todos = [];
        }

        const open = todos.filter(
          (t) => !['completed', 'cancelled'].includes(t.status),
        );
        if (open.length > 0) return;

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

export {
  isReviewSession,
  setReviewSession,
  reviewSessions,
  Deferred,
  ReviewResult,
};
