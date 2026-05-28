import type { PluginInput } from '@opencode-ai/plugin';
import {
  createAbortSuppressor,
  isAbortErrorName,
} from '../utils/abort-suppress';
import { asMessageArray, asTodoArray } from '../utils/session';

const NUDGE_PROMPT =
  'There are still incomplete todos. Continue working through the remaining items. If stuck or blocked, explain the situation and ask for guidance. If you want to skip this check, respond with <skip-todo-check />';

const TERMINAL_STATUSES = ['completed', 'cancelled'];
const SUPPRESS_AFTER_ABORT_MS = 5_000;

export function createNudgeTodoHook(ctx: PluginInput) {
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

        let todos: ReturnType<typeof asTodoArray>;
        try {
          const result = await ctx.client.session.todo({
            path: { id: sessionID },
          });
          todos = asTodoArray(result.data);
        } catch {
          return;
        }

        const open = todos.filter((t) => !TERMINAL_STATUSES.includes(t.status));
        if (open.length === 0) return;

        try {
          const messagesResult = await ctx.client.session.messages({
            path: { id: sessionID },
          });
          const messages = asMessageArray(messagesResult.data);
          const lastAssistant = [...messages]
            .reverse()
            .find((m) => m.info?.role === 'assistant');
          if (lastAssistant) {
            const fullText = (lastAssistant.parts ?? [])
              .filter((p) => p.type === 'text' && p.text)
              .map((p) => p.text ?? '')
              .join('');
            if (fullText.includes('<skip-todo-check />')) return;
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
        if (isAbortErrorName(error?.name)) {
          suppressor.suppress();
        }
      }
    },
  };
}
