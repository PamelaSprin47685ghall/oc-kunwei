import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { BROWSER_SYSTEM_PROMPT } from 'engine/subagent';
import { extractToolContext, runSubagent } from '../utils/session.js';

export { BROWSER_SYSTEM_PROMPT };

export function createBrowserTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Receive a natural-language intent for a web task and delegate to the browser agent. IMPORTANT: Do NOT assume the browser agent knows the project background, design documents, or any specific domain knowledge. You must provide all necessary context explicitly in your intent. Failure to do so will cause severe confusion.',

    args: {
      intent: tool.schema
        .string()
        .describe('A natural-language intent describing the desired web task. Must include all relevant background, design rationale, URLs, and specific requirements. Do not assume the agent knows anything about the project context.'),
    },

    async execute(args, context) {
      const { directory, sessionID, abortSignal } = extractToolContext(
        context,
        ctx.directory,
      );

      return runSubagent(client, {
        agent: 'browser',
        title: 'Browser',
        parts: [{ type: 'text', text: args.intent }],
        directory,
        sessionID,
        abortSignal,
      });
    },
  });
}

export function getBrowserConfig() {
  return {
    agents: {
      browser: {
        prompt: BROWSER_SYSTEM_PROMPT,
        mode: 'subagent' as const,
        mcps: ['stealth-browser-mcp'],
        permission: {
          read: 'allow',
          'stealth-browser-mcp_*': 'allow',
          bash: 'deny',
          write: 'deny',
          edit: 'deny',
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
