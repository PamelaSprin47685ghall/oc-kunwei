import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { extractSessionText } from '../utils/session';

const EXPLORER_SYSTEM_PROMPT =
  'You are a code exploration agent. Given a search query, use semble_search to find relevant code in the workspace. ' +
  'Read the relevant files and provide a detailed summary of what you found, including file paths and key code sections. ' +
  'You have access to basher for read-only exploration commands (e.g., listing files, checking git status). ' +
  'Do NOT use basher to modify files — if you need to make changes, stop and report back.';

export function createExplorerTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Search the codebase using semantic search. ' +
      'Provide a natural-language query describing what code you are looking for. ' +
      'The explorer agent uses semble for semantic code search and can read files to provide detailed context.',

    args: {
      query: tool.schema
        .string()
        .describe('Natural-language search query describing the code to find.'),
    },

    async execute(args) {
      const createResult = await client.session.create();
      const childID = createResult.data?.id;
      if (!childID) return 'Failed to create child session';

      await client.session.prompt({
        path: { id: childID },
        body: {
          agent: 'explorer',
          parts: [{ type: 'text', text: args.query }],
        },
      });

      return (await extractSessionText(client, childID)) || '(no output)';
    },
  });
}

export function getExplorerConfig() {
  return {
    agents: {
      explorer: {
        prompt: EXPLORER_SYSTEM_PROMPT,
        mode: 'subagent' as const,
        tools: { basher: true },
        permission: { '*': 'deny', read: 'allow' } as Record<string, unknown>,
        mcps: ['semble'],
      },
    },
  };
}
