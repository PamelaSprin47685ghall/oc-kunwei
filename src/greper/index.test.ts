import { describe, expect, mock, test } from 'bun:test';
import { createGreperTool, getGreperConfig } from './index';

describe('getGreperConfig', () => {
  test('returns greper agent with runner tool and read permission', () => {
    const cfg = getGreperConfig();
    expect(cfg.agents.greper.mode).toBe('subagent');
    expect(cfg.agents.greper.prompt).toContain('code exploration');
    expect(cfg.agents.greper.permission).toMatchObject({
      read: 'allow',
      glob: 'allow',
      bash: 'deny',
      edit: 'deny',
      write: 'deny',
      grep: 'deny',
      fuzzy_find: 'allow',
      fuzzy_grep: 'allow',
      task: 'deny',
    });
  });

  test('prompt warns against using runner for modifications', () => {
    const cfg = getGreperConfig();
    expect(cfg.agents.greper.prompt).toContain('Do NOT use runner');
  });
});

describe('createGreperTool', () => {
  function mockCtx() {
    return {
      client: {
        session: {
          create: mock(async () => ({ data: { id: 'greper-child-1' } })),
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
    const greper = createGreperTool(ctx);
    const result = await greper.execute(
      { intent: 'Where is isEven defined?' },
      {} as any,
    );
    expect(result).toContain('isEven');
    expect(ctx.client.session.create).toHaveBeenCalled();
    expect(ctx.client.session.prompt).toHaveBeenCalled();
  });

  test('sends query to child session', async () => {
    const ctx = mockCtx();
    const greper = createGreperTool(ctx);
    await greper.execute({ intent: 'Find the auth middleware' }, {} as any);
    const promptArg = ctx.client.session.prompt.mock.calls[0][0];
    const text = promptArg.body.parts[0].text;
    expect(text).toBe('Find the auth middleware');
  });

  test('uses greper agent', async () => {
    const ctx = mockCtx();
    const greper = createGreperTool(ctx);
    await greper.execute({ intent: 'search test' }, {} as any);
    const promptArg = ctx.client.session.prompt.mock.calls[0][0];
    expect(promptArg.body.agent).toBe('greper');
  });
});
