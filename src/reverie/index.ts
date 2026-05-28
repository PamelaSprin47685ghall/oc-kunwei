import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { extractSessionText } from '../utils/session';

const REVERIE_SYSTEM_PROMPT =
  'You are in a quiet room with the texts and the question.\n' +
  'No tools, no distractions — just you and the problem.\n' +
  '\n' +
  'Read carefully. Turn it over in your mind.\n' +
  'When you are ready, answer with clarity and depth.';

export function createReverieTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;
  const directory = ctx.directory;

  return tool({
    description:
      'Close the door. There is only the question and the texts before you.\n' +
      'No tools. No commands. No escape. Just the silence and the thinking.\n' +
      '\n' +
      'Use this whenever a question deserves more than a glance.\n' +
      'When you are curious about a design. When a piece of code\n' +
      'puzzles you. When you need to understand a system before\n' +
      'touching it. When a decision wants weighing, not rushing.\n' +
      '\n' +
      'Reverie is not a last resort — it is a practice.\n' +
      'The strongest builders step back to think, every day.\n' +
      '\n' +
      'Give it any question worth asking. Give it the files\n' +
      'that frame it. Close the door. Think.\n' +
      '\n' +
      'A must-try whenever a question arises.',

    args: {
      question: tool.schema
        .string()
        .describe('The question to contemplate. The harder, the better.'),
      files: tool.schema
        .array(tool.schema.string())
        .describe('File paths to provide as context for the contemplation.'),
    },

    async execute(args) {
      const parts: Array<{ type: 'text'; text: string }> = [];

      for (const file of args.files) {
        const fullPath = path.resolve(directory, file);
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          parts.push({
            type: 'text',
            text: `=== ${file} ===\n\n${content}`,
          });
        } catch {
          parts.push({
            type: 'text',
            text: `=== ${file} ===\n\n(unable to read)`,
          });
        }
      }

      if (parts.length > 0) {
        parts.push({ type: 'text', text: '' });
      }
      parts.push({ type: 'text', text: `Question:\n${args.question}` });

      const createResult = await client.session.create();
      const childID = createResult.data?.id;
      if (!childID) return 'Failed to create child session';

      await client.session.prompt({
        path: { id: childID },
        body: {
          agent: 'reverie',
          parts,
        },
      });

      return (await extractSessionText(client, childID)) || '(no output)';
    },
  });
}

export function getReverieConfig() {
  return {
    agents: {
      reverie: {
        prompt: REVERIE_SYSTEM_PROMPT,
        mode: 'subagent' as const,
        tools: {},
      },
    },
  };
}
