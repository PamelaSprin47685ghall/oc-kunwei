import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { REVERIE_SYSTEM_PROMPT } from 'engine/subagent';
import { extractToolContext, runSubagent } from '../utils/session';

export { REVERIE_SYSTEM_PROMPT };

const MAX_REVERIE_FILE_BYTES = 1_048_576;

function isWithinDirectory(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function createReverieTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Receive a natural-language intent or question for deep reasoning and delegate to the reverie agent. IMPORTANT: Do NOT assume the reverie agent knows the project background, design documents, or any specific domain knowledge. You must provide all necessary context explicitly in your intent and files. Failure to do so will cause severe confusion.',

    args: {
      intent: tool.schema
        .string()
        .describe(
          'A natural-language intent or question to contemplate. Must include all relevant background, design rationale, and specific requirements. Do not assume the agent knows anything about the project context.',
        ),
      files: tool.schema
        .array(tool.schema.string())
        .describe(
          'File paths to provide as context for the contemplation. Must resolve inside the project directory. Include any design docs, relevant code, or background material the agent needs to understand the question.',
        ),
    },

    async execute(args, context) {
      const { directory, sessionID, abortSignal } = extractToolContext(
        context,
        ctx.directory,
      );

      const parts: Array<{ type: 'text'; text: string }> = [];

      for (const file of args.files) {
        const fullPath = path.resolve(directory, file);
        if (!isWithinDirectory(fullPath, directory)) {
          parts.push({
            type: 'text',
            text: `=== ${file} ===\n\n(outside project directory — skipped)`,
          });
          continue;
        }
        try {
          const stat = await fs.stat(fullPath);
          if (!stat.isFile() || stat.size > MAX_REVERIE_FILE_BYTES) {
            parts.push({
              type: 'text',
              text: `=== ${file} ===\n\n(skipped: too large or not a regular file)`,
            });
            continue;
          }
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
        permission: {
          bash: 'deny',
          edit: 'deny',
          write: 'deny',
          glob: 'deny',
          grep: 'deny',
          fuzzy_find: 'deny',
          fuzzy_grep: 'deny',
          task: 'deny',
          read: 'deny',
        } as Record<string, unknown>,
        mcps: [],
      },
    },
  };
}
