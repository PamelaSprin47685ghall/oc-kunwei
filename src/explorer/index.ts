import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { extractToolContext, runSubagent } from '../utils/session';

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

    async execute(args, context) {
      const { directory, sessionID, abortSignal } = extractToolContext(
        context,
        ctx.directory,
      );

      return runSubagent(client, {
        agent: 'explorer',
        title: 'Explorer',
        parts: [{ type: 'text', text: args.query }],
        directory,
        sessionID,
        abortSignal,
      });
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
        permission: { read: 'allow', basher: 'allow', bash: 'deny', edit: 'deny', write: 'deny', glob: 'allow', grep: 'deny', task: 'deny', editor: 'deny', explorer: 'deny', reverie: 'deny', submit_review: 'deny', submit_review_result: 'deny' } as Record<string, unknown>,
        mcps: ['semble'],
      },
    },
  };
}
