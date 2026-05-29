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
  createFuzzyGlobTool,
  createFuzzyGrepTool,
} from './fuzzy/index.js';
import {
  createOllamaWebFetchTool,
  createOllamaWebSearchTool,
} from './ollama-web/index.js';
import {
  createRunnerTool,
  getRunnerConfig,
} from './runner/index.js';
import { createRunnerNudgeHook } from './runner/nudge.js';
import { createReverieTool, getReverieConfig } from './reverie/index.js';
import { getMcpConfig } from './mcp/index.js';
import { createBrowserTool, getBrowserConfig } from './browser/index.js';

const { agents: editorAgents } = getEditorConfig();
const { agents: runnerAgents } = getRunnerConfig();
const { agents: browserAgents } = getBrowserConfig();
const { agents: reverieAgents } = getReverieConfig();
const { agents: reviewerAgents } = getReviewerConfig();
const { agents: greperAgents } = getGreperConfig();

const AGENT_TOOLS_MAP: Record<string, Record<string, boolean>> = {
  orchestrator: {
    read: true,
    editor: true,
    greper: true,
    reverie: true,
    submit_review: true,
    webfetch: true,
    websearch: true,
    runner: true,
    browser: true,
    submit_review_result: false,
    edit: false,
    write: false,
    glob: false,
    grep: false,
    task: false,
  },
  greper: {
    read: true,
    runner: true,
    editor: false,
    greper: false,
    reverie: false,
    submit_review: false,
    submit_review_result: false,
    webfetch: false,
    websearch: false,
    write: false,
    edit: false,
    glob: true,
    grep: true,
    task: false,
  },
  browser: {
    read: true,
    'stealth_browser_mcp_*': true,
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
  const mcps = getMcpConfig();
  const capitalsContextHook = createCapitalsContextHook(ctx.directory);
  const nudgeTodoHook = createNudgeTodoHook(ctx);
  const loopCommandManager = createLoopCommandManager(ctx);
  const loopNudgeHook = createLoopNudgeHook(ctx);
  const runnerNudgeHook = createRunnerNudgeHook(ctx);

  return {
    name: 'kunwei',
    mcp: mcps,

    tool: {
      editor: createEditorTool(ctx),
      greper: createGreperTool(ctx),
      reverie: createReverieTool(ctx),
      submit_review: createSubmitReviewTool(ctx),
      submit_review_result: createSubmitReviewResultTool(),
      webfetch: createOllamaWebFetchTool(),
      websearch: createOllamaWebSearchTool(),
      runner: createRunnerTool(ctx),
      browser: createBrowserTool(ctx),
      glob: createFuzzyGlobTool(),
      grep: createFuzzyGrepTool(),
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
        ...greperAgents,
        ...browserAgents,
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
            browser: true,
            submit_review_result: false,
          },
          permission: {
            edit: 'deny',
            write: 'deny',
            glob: 'deny',
            grep: 'deny',
            task: 'deny',
            bash: 'deny',
          },
          mcps: [],
        } as Record<string, unknown>,
      };

      for (const name of [
        'editor',
        'greper',
        'runner',
        'reverie',
        'reviewer',
        'browser',
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

      const configMcp = opencodeConfig.mcp as Record<string, unknown> | undefined;
      if (!configMcp) {
        opencodeConfig.mcp = { ...mcps };
      } else {
        Object.assign(configMcp, mcps);
      }

      loopCommandManager.registerCommand(opencodeConfig);

      const agentConfig = opencodeConfig.agent as Record<string, unknown>;
      for (const [_name, entry] of Object.entries(agentConfig)) {
        if (typeof entry !== 'object' || !entry) continue;
        const agent = entry as Record<string, unknown>;
        const perm = ((agent.permission as Record<string, unknown>) ??
          {}) as Record<string, unknown>;
        perm.bash = 'deny';
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
      _input: { tool: string; callID: string },
      _output: { args?: Record<string, unknown> },
    ): Promise<void> => { },

    'tool.execute.after': async (
      _input: { tool: string; callID: string },
      _output: {
        output?: unknown;
        title?: string;
        metadata?: Record<string, unknown>;
      },
    ): Promise<void> => { },

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