import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { extractToolContext, runSubagent } from '../utils/session';

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
- Don't include any follow up recommendations, suggestions, or offers to help

## Execution Strategy

### Time Estimation
Before running a command, estimate its execution time:
- Fast (<10s): simple queries, file reads, quick computations
- Slow (≥10s): git clone/pull/push, npm install, build pipelines, test suites, long computations

### Fast Commands
Run directly and return output inline.

### Slow Commands (tmux Async Execution)
Run asynchronously via tmux using the send-keys pattern with a random-bounded heredoc. This avoids escaping/quoting issues and temp file cleanup.

**Step 1 — Start/obtain a detached tmux session:**
\`\`\`bash
tmux new-session -d -s "build-packages" -c "/home/user/project"
\`\`\`

**Step 2 — Pass the command into send-keys using a random-bounded heredoc:**
\`\`\`bash
tmux send-keys -t "build-packages" -l "$(cat <<'EOF_BUILD_PACKAGES'
npm install
EOF_BUILD_PACKAGES
)"
\`\`\`

**Step 3 — Trigger execution by sending the Enter key:**
\`\`\`bash
tmux send-keys -t "build-packages" Enter
\`\`\`

**Step 4 — Return immediately.** Do NOT block, wait, or poll for output/completion. After sending Enter, immediately report the tmux session name and confirmation. The Orchestrator will retrieve logs separately when needed.

**View logs (called separately by Orchestrator):**
\`\`\`bash
tmux capture-pane -p -t "build-packages"
\`\`\`

### Session and Heredoc Naming Requirements

You **MUST** choose descriptive, meaningful, and unique names for both the session name and the heredoc boundary identifier. This ensures session isolation and prevents execution conflicts.

**Session name:** Use a name related to the task (e.g., \`build-npm-install\`, \`test-suite-run\`, \`git-clone-repo\`, \`compile-typescript\`). Avoid generic names like \`session\` or \`temp\`.

**Heredoc boundary identifier:** Use a descriptive identifier related to the task (e.g., \`EOF_BUILD_17\`, \`EOF_TEST_SUITE\`, \`EOF_COMPILE_STEP\`, \`EOF_INSTALL_DEPS\`). Avoid generic placeholders like \`EOF\` or random strings that don't convey purpose.

### Output Summary
- For sync tasks: provide a clear summary of the output
- For async tasks: immediately return the tmux session name and confirmation after sending the command. Do NOT wait for, block on, or poll for completion. The Orchestrator retrieves logs separately when ready.`;

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
      'Supports quick sync commands (fast, returns output inline) and long-running async background execution via tmux. ' +
      'The Orchestrator can request running via tmux for slow commands (git clone/pull/push, npm install, build, test, etc.) and will report the session name and log path for later log retrieval.',

    args: {
      command: tool.schema.string().describe('The bash command to execute'),
      what_to_summarize: tool.schema
        .string()
        .describe('What to look for in the output. Be specific.'),
    },

    async execute(args, context) {
      const { directory, sessionID, abortSignal } = extractToolContext(
        context,
        ctx.directory,
      );

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
        permission: { bash: 'allow', edit: 'deny', write: 'deny', glob: 'deny', grep: 'deny', task: 'deny', read: 'deny', basher: 'deny', editor: 'deny', greper: 'deny', reverie: 'deny', submit_review: 'deny', submit_review_result: 'deny' } as Record<string, unknown>,
      },
    },
  };
}
