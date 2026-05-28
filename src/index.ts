import type { Plugin } from '@opencode-ai/plugin';
import {
  createBasherTool,
  enforceTimeout,
  getBasherConfig,
  stripHeadTailPipes,
} from './basher/index.js';
import { createEditorTool, getEditorConfig } from './editor/index.js';
import { createExplorerTool, getExplorerConfig } from './explorer/index.js';
import { createNudgeTodoHook } from './nudge-todo/index.js';
import {
  createOllamaWebFetchTool,
  createOllamaWebSearchTool,
} from './ollama-web/index.js';
import { createCapitalsContextHook } from './refer-caps/index.js';
import { createReverieTool, getReverieConfig } from './reverie/index.js';
import {
  createSubmitReviewResultTool,
  createSubmitReviewTool,
  createWithReviewCommandManager,
  createWithReviewNudgeHook,
} from './with-review/index.js';

const { agents: basherAgents, orchestratorTools: basherTools } =
  getBasherConfig();
const { agents: editorAgents, orchestratorTools: editorTools } =
  getEditorConfig();
const { agents: explorerAgents, orchestratorTools: explorerTools } =
  getExplorerConfig();
const { agents: reverieAgents } = getReverieConfig();

const CapsPlugin: Plugin = async (ctx) => {
  const capitalsContextHook = createCapitalsContextHook(ctx.directory);
  const nudgeTodoHook = createNudgeTodoHook(ctx);
  const withReviewCommandManager = createWithReviewCommandManager(ctx);
  const withReviewNudgeHook = createWithReviewNudgeHook(ctx);

  return {
    name: 'caps-context',

    tool: {
      basher: createBasherTool(ctx),
      editor: createEditorTool(ctx),
      explorer: createExplorerTool(ctx),
      reverie: createReverieTool(ctx),
      submit_review: createSubmitReviewTool(ctx),
      submit_review_result: createSubmitReviewResultTool(),
      webfetch: createOllamaWebFetchTool(),
      websearch: createOllamaWebSearchTool(),
    },

    config: async (opencodeConfig) => {
      opencodeConfig.tools = {
        ...(opencodeConfig.tools as Record<string, boolean> | undefined),
        bash: false,
        glob: false,
        grep: false,
      };

      opencodeConfig.agent = {
        ...opencodeConfig.agent,
        ...basherAgents,
        ...editorAgents,
        ...explorerAgents,
        ...reverieAgents,
        orchestrator: {
          ...(opencodeConfig.agent?.orchestrator as
            | Record<string, unknown>
            | undefined),
          tools: {
            ...basherTools,
            ...editorTools,
            ...explorerTools,
          },
        },
      };

      withReviewCommandManager.registerCommand(opencodeConfig);

      const agentConfig = opencodeConfig.agent as Record<string, unknown>;
      for (const [name, entry] of Object.entries(agentConfig)) {
        if (typeof entry !== 'object' || !entry) continue;
        const agent = entry as Record<string, unknown>;
        const perm = ((agent.permission as Record<string, unknown>) ??
          {}) as Record<string, unknown>;
        if (name === 'explorer') {
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
      input: { tool: string },
      output: { args?: Record<string, unknown> },
    ): Promise<void> => {
      if (input.tool !== 'bash') return;
      const args = output.args;
      if (!args || typeof args.command !== 'string') return;

      const { script } = stripHeadTailPipes(args.command);
      args.command = enforceTimeout(script);
    },

    'command.execute.before': async (
      input: {
        command: string;
        sessionID: string;
        arguments: string;
      },
      output: { parts: Array<{ type: string; text?: string }> },
    ): Promise<void> => {
      await withReviewCommandManager.handleCommandExecuteBefore(input, output);
    },

    event: async (input: {
      event: { type: string; properties?: Record<string, unknown> };
    }): Promise<void> => {
      await nudgeTodoHook.handleEvent(input);
      await withReviewNudgeHook.handleEvent(input);
    },
  };
};

export default CapsPlugin;
