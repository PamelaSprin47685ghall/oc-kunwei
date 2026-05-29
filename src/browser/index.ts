import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { extractToolContext, runSubagent } from '../utils/session.js';

const BROWSER_SYSTEM_PROMPT =
  'You are a browser automation agent. Given a natural-language intent describing a web task, use stealth-browser-mcp tools to interact with web pages. ' +
  'You can navigate to URLs, query DOM elements, click elements, type text, extract page content, take screenshots, manage cookies, and handle network requests. ' +
  'Execute the task step by step and return the results clearly.';

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
        permission: {
          read: 'allow',
          'stealth_browser_mcp_*': 'allow',
          bash: 'deny',
          write: 'deny',
          edit: 'deny',
          glob: 'deny',
          grep: 'deny',
          task: 'deny',
        } as Record<string, unknown>,
      },
    },
  };
}
