import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { extractToolContext, runSubagent } from '../utils/session';

const REVERIE_SYSTEM_PROMPT =
  'You are in a quiet room with the texts and the question.\n' +
  'No tools, no distractions — just you and the problem.\n' +
  '\n' +
  'Read carefully. Turn it over in your mind.\n' +
  'When you are ready, answer with clarity and depth.';

export function createReverieTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Receive a natural-language intent or question for deep reasoning and delegate to the reverie agent.',

    args: {
      intent: tool.schema
        .string()
        .describe('A natural-language intent or question to contemplate.'),
      files: tool.schema
        .array(tool.schema.string())
        .describe('File paths to provide as context for the contemplation.'),
    },

    async execute(args, context) {
      const { directory, sessionID, abortSignal } = extractToolContext(
        context,
        ctx.directory,
      );

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
      parts.push({ type: 'text', text: `Question:\n${args.intent}` });

      return runSubagent(client, {
        agent: 'reverie',
        title: 'Reverie',
        parts,
        directory,
        sessionID,
        abortSignal,
      });
    },
  });
}

export function getReverieConfig() {
  return {
    agents: {
      reverie: {
        prompt: REVERIE_SYSTEM_PROMPT,
        mode: 'subagent' as const,
        permission: { bash: 'deny', edit: 'deny', write: 'deny', glob: 'deny', grep: 'deny', task: 'deny', read: 'deny' } as Record<string, unknown>,
      },
    },
  };
}
