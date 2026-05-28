import { randomBytes } from 'node:crypto';

import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { getAbortSignal, runSubagent } from '../utils/session';

const HEAD_TAIL_PIPE_RE =
  /\s*\|\s*(head|tail)\s+(?:-n\s*|-)\d+(?=\s*(?:[;&\n#]|$))/g;

export interface StripResult {
  script: string;
  stripped: Array<{ pipe: string; name: string; count: number }>;
}

export function stripHeadTailPipes(script: string): StripResult {
  const stripped: Array<{ pipe: string; name: string; count: number }> = [];
  let current = script;
  while (true) {
    let replaced = false;
    const next = current.replace(HEAD_TAIL_PIPE_RE, (match, name: string) => {
      const count = parseInt(/\d+/.exec(match)?.[0] ?? '0', 10);
      stripped.unshift({ pipe: match.trim(), name, count });
      replaced = true;
      return '';
    });
    if (!replaced) break;
    current = next;
  }
  return { script: current, stripped };
}

export function enforceTimeout(command: string): string {
  const delimiter = randomBytes(8).toString('hex');
  return `timeout 5 bash -s << 'EOF_${delimiter}'\n${command}\nEOF_${delimiter}`;
}

const BASHER_SYSTEM_PROMPT = `You are an expert at analyzing the output of a terminal command.

Your job is to:
1. Review the terminal command and its output
2. Analyze the output based on what the user requested
3. Provide a clear, concise description of the relevant information

When describing command output:
- Use excerpts from the actual output when possible (especially for errors, key values, or specific data)
- Focus on the information the user requested
- Be concise but thorough
- If the output is very long, summarize the key points rather than reproducing everything
- Don't include any follow up recommendations, suggestions, or offers to help`;

function buildPrompt(command: string, what: string): string {
  return `Command:
${command}

What to look for:
${what}`;
}

export function createBasherTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Executes a bash command and returns a natural-language summary. ' +
      'MUST provide "command" and "what_to_summarize". ' +
      'The bash command has a 5-second timeout enforced by timeout(1). ' +
      'Do NOT wrap the command with timeout(1) manually — it is added automatically. ' +
      'For longer-running commands, use tmux to run them asynchronously.',

    args: {
      command: tool.schema.string().describe('The bash command to execute'),
      what_to_summarize: tool.schema
        .string()
        .describe('What to look for in the output. Be specific.'),
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

      const { script } = stripHeadTailPipes(args.command);

      return runSubagent(client, {
        agent: 'basher',
        title: 'Basher',
        parts: [
          {
            type: 'text',
            text: buildPrompt(script, args.what_to_summarize),
          },
        ],
        directory,
        sessionID,
        abortSignal,
      });
    },
  });
}

export function getBasherConfig() {
  return {
    agents: {
      basher: {
        prompt: BASHER_SYSTEM_PROMPT,
        mode: 'subagent' as const,
        permission: { '*': 'deny', bash: 'allow' } as Record<string, unknown>,
      },
    },
  };
}
