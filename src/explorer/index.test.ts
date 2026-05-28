import { describe, expect, mock, test } from 'bun:test';
import { createExplorerTool, getExplorerConfig } from './index';

describe('getExplorerConfig', () => {
  test('returns explorer agent with basher tool and read permission', () => {
    const cfg = getExplorerConfig();
    expect(cfg.agents.explorer.mode).toBe('subagent');
    expect(cfg.agents.explorer.prompt).toContain('code exploration');
    expect(cfg.agents.explorer.tools).toEqual({ basher: true });
    expect(cfg.agents.explorer.permission).toEqual({ '*': 'deny', read: 'allow' });
  });

  test('has semble MCP', () => {
    const cfg = getExplorerConfig();
    expect(cfg.agents.explorer.mcps).toEqual(['semble']);
  });

  test('prompt warns against using basher for modifications', () => {
    const cfg = getExplorerConfig();
    expect(cfg.agents.explorer.prompt).toContain('Do NOT use basher');
  });
});

describe('createExplorerTool', () => {
  function mockCtx() {
    return {
      client: {
        session: {
          create: mock(async () => ({ data: { id: 'explorer-child-1' } })),
          prompt: mock(async () => ({})),
          messages: mock(async () => ({
            data: [
              {
                info: { role: 'assistant' },
                parts: [
                  {
                    type: 'text',
                    text: 'Found isEven in src/utils.ts:42 — exported function that checks parity.',
                  },
                ],
              },
            ],
          })),
          abort: mock(async () => ({})),
        },
      },
    } as any;
  }

  test('returns summary from child session', async () => {
    const ctx = mockCtx();
    const explorer = createExplorerTool(ctx);
    const result = await explorer.execute(
      { query: 'Where is isEven defined?' },
      {} as any,
    );
    expect(result).toContain('isEven');
    expect(ctx.client.session.create).toHaveBeenCalled();
    expect(ctx.client.session.prompt).toHaveBeenCalled();
  });

  test('sends query to child session', async () => {
    const ctx = mockCtx();
    const explorer = createExplorerTool(ctx);
    await explorer.execute({ query: 'Find the auth middleware' }, {} as any);
    const promptArg = ctx.client.session.prompt.mock.calls[0][0];
    const text = promptArg.body.parts[0].text;
    expect(text).toBe('Find the auth middleware');
  });

  test('uses explorer agent', async () => {
    const ctx = mockCtx();
    const explorer = createExplorerTool(ctx);
    await explorer.execute({ query: 'search test' }, {} as any);
    const promptArg = ctx.client.session.prompt.mock.calls[0][0];
    expect(promptArg.body.agent).toBe('explorer');
  });
});
