import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';
import { extractToolContext, runSubagent } from '../utils/session';
import {
  execute as executeCommand,
  wait as waitForOutput,
  abort as abortCommand,
  getSessionId,
  type ExecuteResult,
  type WaitResult,
} from './tools.js';

const RUNNER_SYSTEM_PROMPT = `You are a command execution specialist. Your job is to:
1. Execute commands using the provided tools
2. Monitor their progress
3. Provide concise summaries of results

You have three tools:
- execute: Start a command (auto-redirects to background after 5s)
- wait: Wait for output from a running command
- abort: Forcefully terminate a running command

## Workflow
1. Call execute with your command
2. If it runs quickly (≤5s), you'll get full output immediately
3. If it runs longer, you'll get initial output and it moves to background
4. Use wait() to poll for more output
5. When done, summarize the results

## Critical Rules
- NEVER attempt to run commands directly with bash - only use the execute tool
- NEVER return a summary while a task is still running (the system will block you)
- If a task seems stuck, use abort() and try a different approach
- Keep summaries concise and focused on what was requested

## Nudge System
The system will provide guidance when:
- A task moves to background (告诉你如何决策)
- No new output appears during wait (警告可能卡死)
- You try to return while task is running (拦截并要求终止)

Follow these prompts carefully. They exist to prevent infinite waiting on stuck tasks.`;

function buildRunnerPrompt(
  command: string | undefined,
  language: string,
  code: string | undefined,
  dependencies: string[] | undefined,
  whatToSummarize: string,
): string {
  const executionCode = language === 'python' ? code : command;
  return `Execute the following ${language} code/command and summarize the results.

Code:
${executionCode || '(no code provided)'}

${language === 'python' && dependencies?.length ? `Dependencies: ${dependencies.join(', ')}` : ''}

What to summarize:
${whatToSummarize}`;
}

export function createRunnerTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Executes a shell command or Python code and returns a natural-language summary. ' +
      'Supports both quick synchronous execution and long-running background tasks. ' +
      'Automatically handles timeout management and provides incremental output monitoring.',

    args: {
      command: tool.schema
        .string()
        .optional()
        .describe('Shell command to execute (when language is "shell")'),
      language: tool.schema
        .enum(['shell', 'python'])
        .default('shell')
        .describe('Execution language'),
      code: tool.schema
        .string()
        .optional()
        .describe('Python code to execute (when language is "python")'),
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

      const prompt = buildRunnerPrompt(
        args.command,
        args.language,
        args.code,
        args.dependencies,
        args.what_to_summarize,
      );

      return runSubagent(client, {
        agent: 'runner',
        title: 'Runner',
        parts: [{ type: 'text', text: prompt }],
        directory,
        sessionID,
        abortSignal,
      });
    },
  });
}

export function createRunnerExecuteTool(ctx: PluginInput): ToolDefinition {
  return tool({
    description:
      'Starts executing a command. If it completes within 5 seconds, returns full output. ' +
      'Otherwise, moves to background and returns initial output. Use wait() to check progress.',
    args: {
      code: tool.schema.string().describe('Command or code to execute'),
      language: tool.schema
        .enum(['shell', 'python'])
        .default('shell')
        .describe('Execution language'),
      dependencies: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe('Python dependencies (only for python language)'),
    },
    async execute(args, context) {
      const sessionId = getSessionId(context);
      const result: ExecuteResult = await executeCommand({
        sessionId,
        code: args.code,
        language: args.language,
        dependencies: args.dependencies,
      });

      let output = result.output;
      if (result.message) {
        output += '\n\n' + result.message;
      }

      return {
        title: result.background ? 'Running in Background' : 'Execution Complete',
        output,
      };
    },
  });
}

export function createRunnerWaitTool(ctx: PluginInput): ToolDefinition {
  return tool({
    description:
      'Waits for output from a background task. Returns any new output since last call. ' +
      'Max wait time is 30 seconds.',
    args: {
      ms: tool.schema
        .number()
        .min(100)
        .max(30000)
        .default(5000)
        .describe('Milliseconds to wait (max 30000)'),
    },
    async execute(args, context) {
      const sessionId = getSessionId(context);
      const result: WaitResult = await waitForOutput({
        sessionId,
        ms: args.ms,
      });

      let output = result.output || '(no new output)';
      if (result.message) {
        output += '\n\n' + result.message;
      }

      return {
        title: result.completed ? 'Task Completed' : 'Still Running',
        output,
      };
    },
  });
}

export function createRunnerAbortTool(ctx: PluginInput): ToolDefinition {
  return tool({
    description: 'Forcefully terminates the current background task.',
    args: {},
    async execute(_args, context) {
      const sessionId = getSessionId(context);
      const result = abortCommand(sessionId);
      return {
        title: 'Task Terminated',
        output: result,
      };
    },
  });
}

export function getRunnerConfig() {
  return {
    agents: {
      runner: {
        prompt: RUNNER_SYSTEM_PROMPT,
        mode: 'subagent' as const,
        permission: {
          bash: 'deny',
          edit: 'deny',
          write: 'deny',
          glob: 'deny',
          grep: 'deny',
          task: 'deny',
          read: 'deny',
          runner_execute: 'allow',
          runner_wait: 'allow',
          runner_abort: 'allow',
        } as Record<string, unknown>,
      },
    },
  };
}
