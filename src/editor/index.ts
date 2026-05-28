import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import {
  getAbortSignal,
  runSubagent,
} from '../utils/session';

const EDITOR_SYSTEM_PROMPT =
  'You are a code editing assistant. Given a task description, implement the necessary code changes in the workspace. ' +
  'You can read files, edit files, write new files, and run commands via basher. ' +
  'When done, describe what you changed and why.';

export function createEditorTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Delegates code editing to a dedicated editor agent. ' +
      'Provide a task description stating only WHAT to change (the intent/purpose). ' +
      'Do NOT include old or new file contents — just describe the intent of the change. ' +
      'The editor agent can read, edit, and write files, and run commands via basher.',

    args: {
      task: tool.schema
        .string()
        .describe(
          'Describe only WHAT to change and why. ' +
            'State the intent of the edit (e.g., "change the button color to red", "add a null check before the call"). ' +
            'Do NOT include old code or new code — just describe the desired change.',
        ),
    },

    async execute(args, context) {
      const directory =
        context && typeof context === 'object' && 'directory' in context
          ? (context as { directory: string }).directory
          : ctx.directory;
      const sessionID =
        context && typeof context === 'object' && 'sessionID' in context
          ? (context as { sessionID: string }).sessionID
          : undefined;
      const abortSignal = getAbortSignal(context);

      return runSubagent(client, {
        agent: 'editor',
        title: 'Editor',
        parts: [{ type: 'text', text: args.task }],
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
        tools: { basher: true },
        permission: { '*': 'deny', read: 'allow', write: 'allow', edit: 'allow' } as Record<string, unknown>,
      },
    },
  };
}
