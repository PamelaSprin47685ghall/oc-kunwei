import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { GREPER_SYSTEM_PROMPT } from 'engine/subagent';
import { extractToolContext, runSubagent } from '../utils/session';

export { GREPER_SYSTEM_PROMPT };

export function createGreperTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      "Receive a natural-language intent for code search and delegate to the search agent. IMPORTANT: Do NOT assume the search agent knows the project background, design documents, or any specific domain knowledge. You must provide all necessary context explicitly in your intent. Failure to do so will cause severe confusion.",

    args: {
      intent: tool.schema
        .string()
        .describe('A natural-language intent describing the code to find. Must include all relevant background, design rationale, and specific requirements. Do not assume the agent knows anything about the project context.'),
    },

    async execute(args, context) {
      const { directory, sessionID, abortSignal } = extractToolContext(
        context,
        ctx.directory,
      );

      return runSubagent(client, {
        agent: 'greper',
        title: 'Greper',
        parts: [{ type: 'text', text: args.intent }],
        directory,
        sessionID,
        abortSignal,
      });
    },
  });
}

export function getGreperConfig() {
  return {
    agents: {
      greper: {
        prompt: GREPER_SYSTEM_PROMPT,
        mode: 'subagent' as const,
        mcps: [],
        permission: { read: 'allow', glob: 'allow', bash: 'deny', edit: 'deny', write: 'deny', grep: 'deny', fuzzy_find: 'allow', fuzzy_grep: 'allow', task: 'deny' } as Record<string, unknown>,
      },
    },
  };
}
