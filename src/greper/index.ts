import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { extractToolContext, runSubagent } from '../utils/session';

const GREPER_SYSTEM_PROMPT =
  'You are a code exploration agent. Given a search query, explore the codebase to find relevant code in the workspace. ' +
  'Use the `fuzzy_find` tool for fuzzy file discovery and the built-in `glob` tool when you need strict path-pattern filtering. ' +
  'Use the `fuzzy_grep` tool to search file contents for keywords, patterns, or code snippets. ' +
  'After locating relevant files, use the `read` tool to read their contents. ' +
  'Provide a detailed summary of what you found, including file paths and key code sections. ' +
  'You have access to basher for read-only exploration commands (e.g., listing files, checking git status). ' +
  'Do NOT use basher to modify files — if you need to make changes, stop and report back.';

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
