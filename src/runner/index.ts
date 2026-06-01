import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { buildRunnerPrompt, RUNNER_SYSTEM_PROMPT } from 'engine/runner';
import {
  extractSessionText,
  extractToolContext,
  isAbortError,
  promptWithAbort,
} from '../utils/session';
import {
  abort,
  cleanupJob,
  type ExecuteResult,
  execute as executeCommand,
  wait,
} from './tools.js';

export { RUNNER_SYSTEM_PROMPT };

export function createRunnerTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Executes a shell command, Python code, or JavaScript/TypeScript program and returns a natural-language summary. ' +
      'Supports both quick synchronous execution and long-running background tasks. ' +
      'Automatically handles timeout management and provides incremental output monitoring. ' +
      'IMPORTANT: If executing Python (language="python") or JavaScript (language="javascript") code, you must specify all necessary third-party package dependencies (e.g. numpy, pandas, requests for Python; lodash, axios for JavaScript) in the "dependencies" argument so they can be installed and resolved before execution.',

    args: {
      language: tool.schema
        .enum(['shell', 'python', 'javascript'])
        .default('shell')
        .describe('Execution language: shell, python, or javascript'),
      program: tool.schema
        .string()
        .describe(
          'The program to execute. Can be a shell command, Python code, or JavaScript/TypeScript code depending on language',
        ),
      dependencies: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe(
          'Dependencies to install (for python or javascript language). For Python or JavaScript programs, explicitly specify all third-party libraries used in the code so they can be available.',
        ),
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
          parentSessionId: sessionID,
          program: args.program,
          language,
          dependencies: args.dependencies,
          cwd: directory,
        });

        const prompt = buildRunnerPrompt(
          language,
          args.program,
          args.dependencies,
          args.what_to_summarize,
          execResult.output,
          execResult.background,
          execResult.message,
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

export function createRunnerWaitTool(): ToolDefinition {
  return tool({
    description:
      'Wait for the background task to produce more output or finish.',
    args: {
      ms: tool.schema
        .number()
        .int()
        .min(100)
        .max(30000)
        .default(2000)
        .describe('Time to wait in milliseconds'),
    },
    async execute(args, context) {
      try {
        const result = await wait({
          sessionId: context.sessionID,
          ms: args.ms,
        });
        let output = result.output;
        if (result.message) {
          output = `${output}\n\n${result.message}`;
        }
        return output || '(no new output)';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
  });
}

export function createRunnerAbortTool(): ToolDefinition {
  return tool({
    description: 'Forcefully terminate the currently running background task.',
    args: {},
    async execute(_args, context) {
      try {
        return abort(context.sessionID);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
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
          fuzzy_find: 'deny',
          fuzzy_grep: 'deny',
          task: 'deny',
          read: 'deny',
          runner_wait: 'allow',
          runner_abort: 'allow',
        } as Record<string, unknown>,
      },
    },
  };
}
