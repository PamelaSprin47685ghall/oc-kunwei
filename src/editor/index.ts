import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';

const EDITOR_SYSTEM_PROMPT =
  'You are a code editing assistant. Given a task description, implement the necessary code changes in the workspace. ' +
  'You can read files, edit files, write new files, and run commands via basher. ' +
  'When done, describe what you changed and why.';

async function extractSessionText(
  client: PluginInput['client'],
  sessionId: string,
): Promise<string> {
  const result = await client.session.messages({ path: { id: sessionId } });
  const messages = (result.data ?? []) as Array<{
    info?: { role?: string };
    parts?: Array<{ type?: string; text?: string }>;
  }>;
  const texts: string[] = [];
  for (const m of messages) {
    if (m.info?.role !== 'assistant') continue;
    for (const p of m.parts ?? []) {
      if (p.type === 'text' && p.text) texts.push(p.text);
    }
  }
  return texts.join('\n\n');
}

export function createEditorTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Delegates code editing to a dedicated editor agent. ' +
      'Provide a detailed task description specifying what files to change and how. ' +
      'The editor agent can read, edit, and write files, and run commands via basher.',

    args: {
      task: tool.schema
        .string()
        .describe(
          'Detailed description of the editing task. ' +
            'Include file paths, specific changes, and any relevant context.',
        ),
    },

    async execute(args) {
      const createResult = await client.session.create();
      const childID = createResult.data?.id;
      if (!childID) return 'Failed to create child session';

      await client.session.prompt({
        path: { id: childID },
        body: {
          agent: 'editor',
          parts: [{ type: 'text', text: args.task }],
        },
      });

      return (await extractSessionText(client, childID)) || '(no output)';
    },
  });
}

export function getEditorConfig() {
  return {
    agents: {
      editor: {
        prompt: EDITOR_SYSTEM_PROMPT,
        mode: 'subagent' as const,
        tools: { read: true, write: true, edit: true, basher: true },
      },
    },
    orchestratorTools: {
      edit: false,
      write: false,
    },
  };
}
