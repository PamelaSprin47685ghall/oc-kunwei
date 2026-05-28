import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { extractSessionText } from '../utils/session';

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
  const escaped = command.replace(/'/g, "'\\''");
  return `timeout 1 bash -c '${escaped}'`;
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
      'The bash command has a 1-second timeout enforced by timeout(1). ' +
      'For longer-running commands, use tmux to run them asynchronously.',

    args: {
      command: tool.schema.string().describe('The bash command to execute'),
      what_to_summarize: tool.schema
        .string()
        .describe('What to look for in the output. Be specific.'),
    },

    async execute(args) {
      const { script } = stripHeadTailPipes(args.command);

      const createResult = await client.session.create();
      const childID = createResult.data?.id;
      if (!childID) return 'Failed to create child session';

      await client.session.prompt({
        path: { id: childID },
        body: {
          agent: 'basher',
          parts: [
            {
              type: 'text',
              text: buildPrompt(script, args.what_to_summarize),
            },
          ],
        },
      });

      return (await extractSessionText(client, childID)) || '(no output)';
    },
  });
}

export function getBasherConfig() {
  return {
    agents: {
      basher: {
        prompt: BASHER_SYSTEM_PROMPT,
        mode: 'subagent' as const,
      },
    },
  };
}
