import type { PluginInput } from '@opencode-ai/plugin';
import { buildRunnerNudgePrompt, hasActiveJob } from 'engine/runner';
import { cleanupJob, getActiveJobs } from './tools.js';

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
        if (!hasActiveJob(getActiveJobs, sessionID)) return;
        try {
          await ctx.client.session.prompt({
            path: { id: sessionID },
            body: { parts: [{ type: 'text', text: buildRunnerNudgePrompt() }] },
          });
        } catch {}
        return;
      }
    },
  };
}
