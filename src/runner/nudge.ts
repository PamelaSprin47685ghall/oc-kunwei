import type { PluginInput } from '@opencode-ai/plugin';
import { getActiveJobs, cleanupJob } from './tools.js';

const RUNNER_NUDGE_PROMPT =
  '⚠️ [System Error] The task is still running in the background.\n' +
  'You are strictly forbidden from returning a final summary while a task is still running.\n\n' +
  'You must resolve this now:\n' +
  '1. Call wait(ms) to check if the task has completed and collect its remaining output.\n' +
  '2. If you believe the task is hung, call abort() immediately to clean up the workspace.\n\n' +
  'Do not write your final report yet. Choose wait or abort now.';

export function createRunnerNudgeHook(ctx: PluginInput) {
  return {
    handleEvent: async (input: {
      event: { type: string; properties?: Record<string, unknown> };
    }): Promise<void> => {
      const { event } = input;
      const props = event.properties ?? {};
      const sessionID = props.sessionID as string | undefined;
      if (!sessionID) return;

      if (
        event.type === 'session.delete' ||
        event.type === 'session.close' ||
        event.type === 'session.remove'
      ) {
        cleanupJob(sessionID);
        return;
      }

      if (event.type === 'session.idle') {
        const job = getActiveJobs().get(sessionID);
        if (job && job.status === 'running') {
          try {
            await ctx.client.session.prompt({
              path: { id: sessionID },
              body: { parts: [{ type: 'text', text: RUNNER_NUDGE_PROMPT }] },
            });
          } catch {}
        }
        return;
      }
    },
  };
}
