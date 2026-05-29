import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { extractToolContext, runSubagent } from '../utils/session';

const EDITOR_SYSTEM_PROMPT =
  'You are a code editing assistant. Given a task description, implement the necessary code changes in the workspace. ' +
  'You can read files, edit files, write new files, and run commands via basher. ' +
  'When done, describe what you changed and why.';

export function createEditorTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Receive a natural-language intent for code changes and delegate to the editor agent.',

    args: {
      intent: tool.schema
        .string()
        .describe('A natural-language intent describing the desired code changes.'),
    },

    async execute(args, context) {
      const { directory, sessionID, abortSignal } = extractToolContext(
        context,
        ctx.directory,
      );

      return runSubagent(client, {
        agent: 'editor',
        title: 'Editor',
        parts: [{ type: 'text', text: args.intent }],
        directory,
        sessionID,
        abortSignal,
      });
    },
  });
}

export function getEditorConfig() {
  return {
    agents: {
      editor: {
        prompt: EDITOR_SYSTEM_PROMPT,
        mode: 'subagent' as const,
        permission: {
          read: 'allow',
          write: 'allow',
          edit: 'allow',
          bash: 'deny',
          glob: 'deny',
          grep: 'deny',
          task: 'deny',
        } as Record<string, unknown>,
      },
    },
  };
}
