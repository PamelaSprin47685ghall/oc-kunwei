import type { Plugin } from '@opencode-ai/plugin';
import { createBrowserTool, getBrowserConfig } from './browser/index.js';
import { createEditorTool, getEditorConfig } from './editor/index.js';
import { createFuzzyFindTool, createFuzzyGrepTool } from './fuzzy/index.js';
import { createGreperTool, getGreperConfig } from './greper/index.js';
import { createCapitalsContextHook } from './inject-caps/index.js';
import {
  createLoopCommandManager,
  createLoopNudgeHook,
  createSubmitReviewResultTool,
  createSubmitReviewTool,
  getReviewerConfig,
} from './loop/index.js';
import { getMcpConfig } from './mcp/index.js';
import { createNudgeTodoHook } from './nudge-todo/index.js';
import {
  createOllamaWebFetchTool,
  createOllamaWebSearchTool,
} from './ollama-web/index.js';
import { createReverieTool, getReverieConfig } from './reverie/index.js';
import {
  createRunnerAbortTool,
  createRunnerTool,
  createRunnerWaitTool,
  getRunnerConfig,
} from './runner/index.js';
import { createRunnerNudgeHook } from './runner/nudge.js';
import { createSyntaxCheckHook } from './tree-sitter/index.js';

type AgentName =
  | 'orchestrator'
  | 'editor'
  | 'reviewer'
  | 'greper'
  | 'browser'
  | 'runner'
  | 'reverie';

type ToolDefaults = Record<string, boolean>;

const AGENT_TOOL_DEFAULTS: Record<AgentName, ToolDefaults> = {
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
    glob: true,
    'stealth_browser_mcp_*': false,
    fuzzy_find: false,
    fuzzy_grep: false,
    grep: false,
    edit: false,
    write: false,
    task: false,
    runner_wait: false,
    runner_abort: false,
    submit_review_result: false,
  },
  editor: {
    read: true,
    write: true,
    edit: true,
    runner: true,
    glob: true,
    fuzzy_find: true,
    fuzzy_grep: true,
    grep: false,
    editor: false,
    greper: false,
    reverie: false,
    submit_review: false,
    submit_review_result: false,
    webfetch: false,
    websearch: false,
    browser: false,
    task: false,
    runner_wait: false,
    runner_abort: false,
    'stealth_browser_mcp_*': false,
  },
  reviewer: {
    read: true,
    submit_review_result: true,
    write: false,
    edit: false,
    editor: false,
    greper: false,
    reverie: false,
    submit_review: false,
    webfetch: false,
    websearch: false,
    runner: false,
    browser: false,
    glob: false,
    grep: false,
    fuzzy_find: false,
    fuzzy_grep: false,
    task: false,
    runner_wait: false,
    runner_abort: false,
    'stealth_browser_mcp_*': false,
  },
  greper: {
    read: true,
    runner: true,
    glob: true,
    fuzzy_find: true,
    fuzzy_grep: true,
    write: false,
    edit: false,
    editor: false,
    greper: false,
    reverie: false,
    submit_review: false,
    submit_review_result: false,
    webfetch: false,
    websearch: false,
    browser: false,
    grep: false,
    task: false,
    runner_wait: false,
    runner_abort: false,
    'stealth_browser_mcp_*': false,
  },
  browser: {
    read: true,
    'stealth_browser_mcp_*': true,
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
    browser: false,
    glob: false,
    grep: false,
    fuzzy_find: false,
    fuzzy_grep: false,
    task: false,
    runner_wait: false,
    runner_abort: false,
  },
  runner: {
    runner_wait: true,
    runner_abort: true,
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
    browser: false,
    glob: false,
    grep: false,
    fuzzy_find: false,
    fuzzy_grep: false,
    task: false,
    'stealth_browser_mcp_*': false,
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
    browser: false,
    glob: false,
    grep: false,
    fuzzy_find: false,
    fuzzy_grep: false,
    task: false,
    runner_wait: false,
    runner_abort: false,
    'stealth_browser_mcp_*': false,
  },
};

function getAgentToolDefaults(agent: AgentName): ToolDefaults {
  return AGENT_TOOL_DEFAULTS[agent];
}

function mergeTools(
  current: Record<string, unknown> | undefined,
  defaults: ToolDefaults,
): Record<string, boolean> {
  const merged: Record<string, boolean> = { ...defaults };
  for (const [key, value] of Object.entries(current ?? {})) {
    if (typeof value === 'boolean') merged[key] = value;
  }
  return merged;
}

const AGENT_PERMISSION_DEFAULTS: Record<AgentName, Record<string, string>> = {
  orchestrator: {
    bash: 'deny',
    edit: 'deny',
    write: 'deny',
    grep: 'deny',
    'stealth-browser-mcp_*': 'deny',
    runner_wait: 'deny',
    runner_abort: 'deny',
    task: 'deny',
    glob: 'allow',
    fuzzy_find: 'deny',
    fuzzy_grep: 'deny',
    question: 'allow',
  },
  editor: { bash: 'deny', grep: 'deny', task: 'deny' },
  reviewer: { bash: 'deny', edit: 'deny', write: 'deny', task: 'deny' },
  greper: {
    bash: 'deny',
    edit: 'deny',
    write: 'deny',
    grep: 'deny',
    task: 'deny',
  },
  browser: { bash: 'deny', edit: 'deny', write: 'deny', task: 'deny' },
  runner: { edit: 'deny', write: 'deny', task: 'deny' },
  reverie: { bash: 'deny', edit: 'deny', write: 'deny', task: 'deny' },
};

function getAgentPermissionDefaults(agent: AgentName): Record<string, string> {
  return { ...AGENT_PERMISSION_DEFAULTS[agent] };
}

function applyUniversalPermissionDeny(
  agent: AgentName,
  permission: Record<string, string>,
): void {
  if (permission.bash === undefined) permission.bash = 'deny';
  if (
    agent !== 'browser' &&
    permission['stealth-browser-mcp_*'] === undefined
  ) {
    permission['stealth-browser-mcp_*'] = 'deny';
  }
  if (agent !== 'runner') {
    if (permission.runner_wait === undefined) permission.runner_wait = 'deny';
    if (permission.runner_abort === undefined) permission.runner_abort = 'deny';
  }
  if (agent !== 'reviewer' && permission.submit_review_result === undefined) {
    permission.submit_review_result = 'deny';
  }
  if (
    agent !== 'editor' &&
    agent !== 'greper' &&
    permission.glob === undefined
  ) {
    permission.glob = 'deny';
  }
  if (agent === 'editor' || agent === 'greper') {
    if (permission.fuzzy_find === undefined) permission.fuzzy_find = 'allow';
    if (permission.fuzzy_grep === undefined) permission.fuzzy_grep = 'allow';
  } else {
    if (permission.fuzzy_find === undefined) permission.fuzzy_find = 'deny';
    if (permission.fuzzy_grep === undefined) permission.fuzzy_grep = 'deny';
  }
  if (permission.grep === undefined) permission.grep = 'deny';
  if (agent !== 'orchestrator' && permission.question === undefined) {
    permission.question = 'deny';
  }
}

const KNOWN_AGENT_NAMES: AgentName[] = [
  'orchestrator',
  'editor',
  'reviewer',
  'greper',
  'browser',
  'runner',
  'reverie',
];

function isAgentName(name: string): name is AgentName {
  return (KNOWN_AGENT_NAMES as string[]).includes(name);
}

const KunweiPlugin: Plugin = async (ctx) => {
  const mcps = getMcpConfig();
  const capitalsContextHook = createCapitalsContextHook(ctx.directory);
  const nudgeTodoHook = createNudgeTodoHook(ctx);
  const loopCommandManager = createLoopCommandManager(ctx);
  const loopNudgeHook = createLoopNudgeHook(ctx);
  const runnerNudgeHook = createRunnerNudgeHook(ctx);
  const syntaxCheckHook = createSyntaxCheckHook(ctx);

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
      fuzzy_find: createFuzzyFindTool(),
      fuzzy_grep: createFuzzyGrepTool(),
      runner_wait: createRunnerWaitTool(),
      runner_abort: createRunnerAbortTool(),
    },

    'chat.message': async (input, output) => {
      const agent = input.agent ?? 'orchestrator';
      const defaults = isAgentName(agent) ? getAgentToolDefaults(agent) : null;
      if (!defaults) return;
      output.message.tools = mergeTools(output.message.tools, defaults);
    },

    config: async (opencodeConfig) => {
      const userAgent = opencodeConfig.agent ?? {};

      opencodeConfig.agent = {
        ...userAgent,
        ...getEditorConfig().agents,
        ...getRunnerConfig().agents,
        ...getReverieConfig().agents,
        ...getReviewerConfig().agents,
        ...getGreperConfig().agents,
        ...getBrowserConfig().agents,
        orchestrator: {
          ...(opencodeConfig.agent?.orchestrator as
            | Record<string, unknown>
            | undefined),
          tools: mergeTools(
            (
              opencodeConfig.agent?.orchestrator as
                | Record<string, unknown>
                | undefined
            )?.tools as Record<string, unknown> | undefined,
            getAgentToolDefaults('orchestrator'),
          ),
          permission: {
            ...getAgentPermissionDefaults('orchestrator'),
            ...((
              opencodeConfig.agent?.orchestrator as
                | Record<string, unknown>
                | undefined
            )?.permission as Record<string, unknown> | undefined),
          },
          mcps: [],
        },
      };

      const renameMap: Record<string, string> = {
        editor: 'editor',
        greper: 'greper',
        runner: 'runner',
        reverie: 'reverie',
        reviewer: 'reviewer',
        browser: 'browser',
      };
      for (const [oldName, newName] of Object.entries(renameMap)) {
        const userEntry = userAgent[oldName] as
          | Record<string, unknown>
          | undefined;
        if (!userEntry) continue;
        const agentEntry = (opencodeConfig.agent as Record<string, unknown>)[
          newName
        ] as Record<string, unknown> | undefined;
        if (agentEntry) Object.assign(agentEntry, userEntry);
      }

      if (userAgent.basher) {
        const runnerEntry = (opencodeConfig.agent as Record<string, unknown>)
          .runner as Record<string, unknown> | undefined;
        if (runnerEntry) Object.assign(runnerEntry, userAgent.basher);
        delete (opencodeConfig.agent as Record<string, unknown>).basher;
      }

      const configMcp = opencodeConfig.mcp as
        | Record<string, unknown>
        | undefined;
      if (!configMcp) {
        opencodeConfig.mcp = { ...mcps };
      } else {
        Object.assign(configMcp, mcps);
      }

      loopCommandManager.registerCommand(opencodeConfig);

      const agentConfig = opencodeConfig.agent as Record<string, unknown>;
      for (const [name, entry] of Object.entries(agentConfig)) {
        if (typeof entry !== 'object' || !entry) continue;
        const agent = entry as Record<string, unknown>;
        const perm =
          (agent.permission as Record<string, string> | undefined) ?? {};
        if (isAgentName(name)) {
          const defaults = getAgentPermissionDefaults(name);
          for (const [key, value] of Object.entries(defaults)) {
            if (perm[key] === undefined) perm[key] = value;
          }
          applyUniversalPermissionDeny(name, perm);
        } else {
          applyUniversalPermissionDeny('runner', perm);
        }
        agent.permission = perm;

        if (isAgentName(name)) {
          agent.tools = mergeTools(
            agent.tools as Record<string, unknown> | undefined,
            getAgentToolDefaults(name),
          );
        }
      }
    },

    'experimental.chat.system.transform': async (
      input: { sessionID?: string },
      output: { system: string[] },
    ): Promise<void> => {
      await capitalsContextHook.handleSystemTransform(input, output);
    },

    'tool.execute.after': async (
      input: { tool: string; callID: string },
      output: {
        output?: unknown;
        title?: string;
        metadata?: Record<string, unknown>;
      },
    ): Promise<void> => {
      await syntaxCheckHook['tool.execute.after'](input, output);
    },

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
