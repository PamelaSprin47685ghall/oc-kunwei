import type { PluginInput } from '@opencode-ai/plugin';

const NUDGE_PROMPT =
  'There are still incomplete todos. Continue working through the remaining items. If stuck or blocked, explain the situation and ask for guidance.';

const TERMINAL_STATUSES = ['completed', 'cancelled'];
const SUPPRESS_AFTER_ABORT_MS = 5_000;

export function createNudgeTodoHook(ctx: PluginInput) {
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

        const open = todos.filter((t) => !TERMINAL_STATUSES.includes(t.status));
        if (open.length === 0) return;

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
