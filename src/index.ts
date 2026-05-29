import type { Plugin } from '@opencode-ai/plugin';
import {
  createBasherTool,
  getBasherConfig,
  stripHeadTailPipes,
} from './basher/index.js';
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
import { createReverieTool, getReverieConfig } from './reverie/index.js';

const { agents: basherAgents } = getBasherConfig();
const { agents: editorAgents } = getEditorConfig();
const { agents: greperAgents } = getGreperConfig();
const { agents: reverieAgents } = getReverieConfig();
const { agents: reviewerAgents } = getReviewerConfig();

// 全局、唯一的 Agent 工具权限分配表
const AGENT_TOOLS_MAP: Record<string, Record<string, boolean>> = {
  orchestrator: {
    basher: true,
    editor: true,
    greper: true,
    reverie: true,
    submit_review: true,
    webfetch: true,
    websearch: true,
    submit_review_result: false,
    bash: false,
    edit: false,
    write: false,
    glob: false,
    grep: false,
    task: false,
  },
  basher: {
    bash: true,
    basher: false,
    editor: false,
    greper: false,
    reverie: false,
    submit_review: false,
    submit_review_result: false,
    webfetch: false,
    websearch: false,
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
    basher: true,
    greper: true,
    editor: false,
    reverie: false,
    submit_review: false,
    submit_review_result: false,
    webfetch: false,
    websearch: false,
    bash: false,
    glob: false,
    grep: false,
    task: false,
  },
  greper: {
    read: true,
    basher: true,
    editor: false,
    greper: false,
    reverie: false,
    submit_review: false,
    submit_review_result: false,
    webfetch: false,
    websearch: false,
    bash: false,
    write: false,
    edit: false,
    glob: false,
    grep: false,
    task: false,
  },
  reviewer: {
    read: true,
    basher: true,
    greper: true,
    reverie: true,
    submit_review_result: true,
    submit_review: false,
    editor: false,
    webfetch: false,
    websearch: false,
    bash: false,
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
    bash: false,
    basher: false,
    editor: false,
    greper: false,
    reverie: false,
    submit_review: false,
    submit_review_result: false,
    webfetch: false,
    websearch: false,
    glob: false,
    grep: false,
    task: false,
  },
};

const CapsPlugin: Plugin = async (ctx) => {
  const capitalsContextHook = createCapitalsContextHook(ctx.directory);
  const nudgeTodoHook = createNudgeTodoHook(ctx);
  const loopCommandManager = createLoopCommandManager(ctx);
  const loopNudgeHook = createLoopNudgeHook(ctx);

  return {
    name: 'caps-context',

    tool: {
      basher: createBasherTool(ctx),
      editor: createEditorTool(ctx),
      greper: createGreperTool(ctx),
      reverie: createReverieTool(ctx),
      submit_review: createSubmitReviewTool(ctx),
      submit_review_result: createSubmitReviewResultTool(),
      webfetch: createOllamaWebFetchTool(),
      websearch: createOllamaWebSearchTool(),
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
        ...basherAgents,
        ...editorAgents,
        ...greperAgents,
        ...reverieAgents,
        ...reviewerAgents,
        orchestrator: {
          ...(opencodeConfig.agent?.orchestrator as
            | Record<string, unknown>
            | undefined),
          tools: {
            basher: true,
            editor: true,
            greper: true,
            reverie: true,
            submit_review: true,
            webfetch: true,
            websearch: true,
            submit_review_result: false,
          },
          permission: {
            bash: 'deny',
            edit: 'deny',
            write: 'deny',
            glob: 'deny',
            grep: 'deny',
            task: 'deny',
          },
        } as Record<string, unknown>,
      };

      for (const name of [
        'basher',
        'editor',
        'greper',
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

      loopCommandManager.registerCommand(opencodeConfig);

      const agentConfig = opencodeConfig.agent as Record<string, unknown>;
      for (const [name, entry] of Object.entries(agentConfig)) {
        if (typeof entry !== 'object' || !entry) continue;
        const agent = entry as Record<string, unknown>;
        const perm = ((agent.permission as Record<string, unknown>) ??
          {}) as Record<string, unknown>;
        if (name === 'greper' || name === 'reviewer') {
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
    ): Promise<void> => {
      if (input.tool !== 'bash') return;
      const args = output.args;
      if (!args || typeof args.command !== 'string') return;
      const { script } = stripHeadTailPipes(args.command);
      args.command = script;

      const timeout = args.timeout;
      if (typeof timeout !== 'number') {
        throw new Error('Timeout must be explicitly set (no fallback).');
      }
      if (timeout > 10000) {
        throw new Error(
          'Timeout too large. Set a shorter timeout (<= 10000ms or 10s) or run the command using tmux.',
        );
      }
    },

    'tool.execute.after': async (
      input: { tool: string; callID: string },
      output: {
        output?: unknown;
        title?: string;
        metadata?: Record<string, unknown>;
      },
    ): Promise<void> => {
      if (input.tool !== 'bash') return;
      if (output.title) output.title = 'Command Output';
      if (output.metadata) output.metadata = {};
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
    },
  };
};

export default CapsPlugin;
