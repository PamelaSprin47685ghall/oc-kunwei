import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import {
  isAbortError,
  extractSessionText,
  promptWithAbort,
  extractToolContext,
} from '../utils/session';
import {
  execute as executeCommand,
  cleanupJob,
  type ExecuteResult,
} from './tools.js';

const RUNNER_SYSTEM_PROMPT = `You are a command output summarizer. The command has already been started by the system automatically. You only have two tools: runner_wait and runner_abort.

## Rules
- For quick tasks (when you see "Task completed"), directly summarize the complete output
- For long-running tasks (when you see "任务已转入后台"), you must use runner_wait to poll for updates, or runner_abort to stop the task
- Summarize the command output clearly and concisely
- Focus on what was requested in "What to summarize"
- Include any errors, warnings, or failures explicitly
- Do not fabricate information not present in the output
- Keep the summary focused and relevant
- If the output is empty or contains only system messages, state that clearly`;

function buildRunnerPrompt(
  language: string,
  program: string,
  dependencies: string[] | undefined,
  whatToSummarize: string,
  executeResult: ExecuteResult,
): string {
  if (!executeResult.background) {
    return `The following ${language} program has been executed.

Task completed.

Program:
${program}

${language === 'python' && dependencies?.length ? `Dependencies: ${dependencies.join(', ')}` : ''}

What to summarize:
${whatToSummarize}

Execution output:
${executeResult.output}${executeResult.message ? '\n\n' + executeResult.message : ''}`;
  }

  return `The following ${language} program is running in background.

任务已转入后台。

Program:
${program}

${language === 'python' && dependencies?.length ? `Dependencies: ${dependencies.join(', ')}` : ''}

What to summarize:
${whatToSummarize}

Initial output (first 5 seconds):
${executeResult.output}${executeResult.message ? '\n\n' + executeResult.message : ''}

You must use runner_wait to poll for more output, or runner_abort to stop the task.`;
}

export function createRunnerTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Executes a shell command or Python code and returns a natural-language summary. ' +
      'Supports both quick synchronous execution and long-running background tasks. ' +
      'Automatically handles timeout management and provides incremental output monitoring.',

    args: {
      language: tool.schema
        .enum(['shell', 'python'])
        .default('shell')
        .describe('Execution language'),
      program: tool.schema
        .string()
        .describe('The program to execute. Can be a shell command or Python code depending on language'),
      dependencies: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe('Python dependencies to install (only for python language)'),
      what_to_summarize: tool.schema
        .string()
        .describe('What to look for in the output. Be specific.'),
    },

    async execute(args, context) {
      const { directory, sessionID, abortSignal } = extractToolContext(
        context,
        ctx.directory,
      );

      const createResult = await client.session.create({
        query: { directory },
        body: {
          parentID: sessionID,
          title: 'Runner',
        },
      });
      const childID = createResult.data?.id;
      if (!childID) return 'Failed to create child session';

      try {
        const language = args.language ?? 'shell';

        const execResult: ExecuteResult = await executeCommand({
          sessionId: childID,
          program: args.program,
          language,
          dependencies: args.dependencies,
        });

        const prompt = buildRunnerPrompt(
          language,
          args.program,
          args.dependencies,
          args.what_to_summarize,
          execResult,
        );

        await promptWithAbort(
          client,
          {
            path: { id: childID },
            body: {
              agent: 'runner',
              parts: [{ type: 'text', text: prompt }],
            },
          },
          abortSignal,
        );

        const summary = await extractSessionText(client, childID, directory);
        return summary || '(no output)';
      } catch (err) {
        if (isAbortError(err)) {
          try {
            client.session.abort({ path: { id: childID } });
          } catch (_) {}
          cleanupJob(childID);
          const text = await extractSessionText(client, childID, directory);
          return text ? `(aborted) ${text}` : '(aborted)';
        }
        cleanupJob(childID);
        throw err;
      }
    },
  });
}

export function getRunnerConfig() {
  return {
    agents: {
      runner: {
        prompt: RUNNER_SYSTEM_PROMPT,
        mode: 'subagent' as const,
        mcps: [],
        permission: {
          edit: 'deny',
          write: 'deny',
          glob: 'deny',
          grep: 'deny',
          task: 'deny',
          read: 'deny',
          runner_wait: 'allow',
          runner_abort: 'allow',
        } as Record<string, unknown>,
      },
    },
  };
}
