import type { Plugin } from '@opencode-ai/plugin';
import { createEditorTool, getEditorConfig } from './editor/index.js';
import { createGreperTool, getGreperConfig } from './greper/index.js';
import { createCapitalsContextHook } from './inject-caps/index.js';
import {
  createLoopCommandManager,
  createLoopNudgeHook,
  createSubmitReviewResultTool,
  createSubmitReviewTool,
  getReviewerConfig,
} from './loop/index.js';
import { createNudgeTodoHook } from './nudge-todo/index.js';
import {
  createOllamaWebFetchTool,
  createOllamaWebSearchTool,
} from './ollama-web/index.js';
import {
  createRunnerTool,
  createRunnerExecuteTool,
  createRunnerWaitTool,
  createRunnerAbortTool,
  getRunnerConfig,
} from './runner/index.js';
import { createRunnerNudgeHook } from './runner/nudge.js';
import { createReverieTool, getReverieConfig } from './reverie/index.js';

const { agents: editorAgents } = getEditorConfig();
const { agents: runnerAgents } = getRunnerConfig();
const { agents: reverieAgents } = getReverieConfig();
const { agents: reviewerAgents } = getReviewerConfig();

const AGENT_TOOLS_MAP: Record<string, Record<string, boolean>> = {
  orchestrator: {
    editor: true,
    greper: true,
    reverie: true,
    submit_review: true,
    webfetch: true,
    websearch: true,
    runner: true,
    submit_review_result: false,
    edit: false,
    write: false,
    glob: false,
    grep: false,
    task: false,
  },
  editor: {
    read: true,
    write: true,
    edit: true,
    greper: true,
    editor: false,
    reverie: false,
    submit_review: false,
    submit_review_result: false,
    webfetch: false,
    websearch: false,
    runner: false,
    glob: false,
    grep: false,
    task: false,
  },
  greper: {
    read: true,
    editor: false,
    greper: false,
    reverie: false,
    submit_review: false,
    submit_review_result: false,
    webfetch: false,
    websearch: false,
    runner: false,
    write: false,
    edit: false,
    glob: false,
    grep: false,
    task: false,
  },
  runner: {
    runner_execute: true,
    runner_wait: true,
    runner_abort: true,
    editor: false,
    greper: false,
    reverie: false,
    submit_review: false,
    submit_review_result: false,
    webfetch: false,
    read: false,
    write: false,
    edit: false,
    glob: false,
    grep: false,
    task: false,
  },
  reviewer: {
    read: true,
    greper: true,
    reverie: true,
    submit_review_result: true,
    submit_review: false,
    editor: false,
    webfetch: false,
    websearch: false,
    runner: false,
    write: false,
    edit: false,
    glob: false,
    grep: false,
    task: false,
  },
  reverie: {
    read: false,
    write: false,
    edit: false,
    editor: false,
    greper: false,
    reverie: false,
    submit_review: false,
    submit_review_result: false,
    webfetch: false,
    websearch: false,
    runner: false,
    glob: false,
    grep: false,
    task: false,
  },
};

const KunweiPlugin: Plugin = async (ctx) => {
  const capitalsContextHook = createCapitalsContextHook(ctx.directory);
  const nudgeTodoHook = createNudgeTodoHook(ctx);
  const loopCommandManager = createLoopCommandManager(ctx);
  const loopNudgeHook = createLoopNudgeHook(ctx);
  const runnerNudgeHook = createRunnerNudgeHook(ctx);

  return {
    name: 'kunwei',

    tool: {
      editor: createEditorTool(ctx),
      greper: createGreperTool(ctx),
      reverie: createReverieTool(ctx),
      submit_review: createSubmitReviewTool(ctx),
      submit_review_result: createSubmitReviewResultTool(),
      webfetch: createOllamaWebFetchTool(),
      websearch: createOllamaWebSearchTool(),
      runner: createRunnerTool(ctx),
      runner_execute: createRunnerExecuteTool(ctx),
      runner_wait: createRunnerWaitTool(ctx),
      runner_abort: createRunnerAbortTool(ctx),
    },

    'chat.message': async (input, output) => {
      const agent = input.agent ?? 'orchestrator';
      const allowedTools = AGENT_TOOLS_MAP[agent];
      if (allowedTools) {
        output.message.tools = {
          ...output.message.tools,
          ...allowedTools,
        };
      }
    },

    config: async (opencodeConfig) => {
      const userAgent = opencodeConfig.agent ?? {};
      opencodeConfig.agent = {
        ...userAgent,
        ...editorAgents,
        ...runnerAgents,
        ...reverieAgents,
        ...reviewerAgents,
        orchestrator: {
          ...(opencodeConfig.agent?.orchestrator as
            | Record<string, unknown>
            | undefined),
          tools: {
            editor: true,
            greper: true,
            reverie: true,
            submit_review: true,
            webfetch: true,
            websearch: true,
            runner: true,
            submit_review_result: false,
          },
          permission: {
            edit: 'deny',
            write: 'deny',
            glob: 'deny',
            grep: 'deny',
            task: 'deny',
          },
        } as Record<string, unknown>,
      };

      for (const name of [
        'editor',
        'greper',
        'runner',
        'reverie',
        'reviewer',
      ]) {
        const userEntry = userAgent[name] as
          | Record<string, unknown>
          | undefined;
        if (!userEntry) continue;
        const agentEntry = (opencodeConfig.agent as Record<string, unknown>)[
          name
        ] as Record<string, unknown> | undefined;
        if (agentEntry) {
          Object.assign(agentEntry, userEntry);
        }
      }

      if (userAgent.basher) {
        const runnerEntry = (opencodeConfig.agent as Record<string, unknown>)
          .runner as Record<string, unknown> | undefined;
        if (runnerEntry) {
          Object.assign(runnerEntry, userAgent.basher);
        }
        delete (opencodeConfig.agent as Record<string, unknown>).basher;
      }

      loopCommandManager.registerCommand(opencodeConfig);

      const agentConfig = opencodeConfig.agent as Record<string, unknown>;
      for (const [name, entry] of Object.entries(agentConfig)) {
        if (typeof entry !== 'object' || !entry) continue;
        const agent = entry as Record<string, unknown>;
        const perm = ((agent.permission as Record<string, unknown>) ??
          {}) as Record<string, unknown>;
        if (name === 'greper' || name === 'reviewer' || name === 'runner') {
          if (!('semble_*' in perm)) perm['semble_*'] = 'allow';
        } else {
          if (!('semble_*' in perm)) perm['semble_*'] = 'deny';
        }
        agent.permission = perm;
      }
    },

    'experimental.chat.system.transform': async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      await capitalsContextHook.handleSystemTransform(input, output);
    },

    'tool.execute.before': async (
      input: { tool: string; callID: string },
      output: { args?: Record<string, unknown> },
    ): Promise<void> => {},

    'tool.execute.after': async (
      input: { tool: string; callID: string },
      output: {
        output?: unknown;
        title?: string;
        metadata?: Record<string, unknown>;
      },
    ): Promise<void> => {},

    'command.execute.before': async (
      input: {
        command: string;
        sessionID: string;
        arguments: string;
      },
      output: { parts: Array<{ type: string; text?: string }> },
    ): Promise<void> => {
      await loopCommandManager.handleCommandExecuteBefore(input, output);
    },

    event: async (input: {
      event: { type: string; properties?: Record<string, unknown> };
    }): Promise<void> => {
      await nudgeTodoHook.handleEvent(input);
      await loopNudgeHook.handleEvent(input);
      await runnerNudgeHook.handleEvent(input);
    },
  };
};

export default KunweiPlugin;