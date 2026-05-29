import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { extractToolContext, runSubagent } from '../utils/session';

const GREPER_SYSTEM_PROMPT =
  'You are a code exploration agent. Given a search query, use semble_search to find relevant code in the workspace. ' +
  'Read the relevant files and provide a detailed summary of what you found, including file paths and key code sections. ' +
  'You have access to basher for read-only exploration commands (e.g., listing files, checking git status). ' +
  'Do NOT use basher to modify files — if you need to make changes, stop and report back.';

export function createGreperTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Receive a natural-language intent for code search and delegate to the search agent.',

    args: {
      intent: tool.schema
        .string()
        .describe('A natural-language intent describing the code to find.'),
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
        permission: { read: 'allow', glob: 'allow', bash: 'deny', edit: 'deny', write: 'deny', grep: 'deny', task: 'deny' } as Record<string, unknown>,
        mcps: ['semble'],
      },
    },
  };
}
