import { describe, expect, mock, test } from 'bun:test';
import {
  createBasherTool,
  getBasherConfig,
  stripHeadTailPipes,
} from './index';

describe('stripHeadTailPipes', () => {
  test('strips | head -n N', () => {
    const r = stripHeadTailPipes('cat file | head -n 50');
    expect(r.script).toBe('cat file');
    expect(r.stripped).toEqual([
      { pipe: '| head -n 50', name: 'head', count: 50 },
    ]);
  });

  test('strips | tail -N', () => {
    const r = stripHeadTailPipes('dmesg | tail -20');
    expect(r.script).toBe('dmesg');
  });

  test('passes through clean commands', () => {
    const r = stripHeadTailPipes('ls -la');
    expect(r.script).toBe('ls -la');
    expect(r.stripped).toEqual([]);
  });

  test('uppercase Head not stripped', () => {
    expect(stripHeadTailPipes('cat file | Head -n 10').script).toBe(
      'cat file | Head -n 10',
    );
  });

  test('strips multiple pipes', () => {
    const r = stripHeadTailPipes('cmd | head -n 5 | tail -n 1');
    expect(r.script).toBe('cmd');
    expect(r.stripped).toHaveLength(2);
  });
});

describe('getBasherConfig', () => {
  test('returns basher agent with subagent mode and bash-only permission', () => {
    const cfg = getBasherConfig();
    expect(cfg.agents.basher.mode).toBe('subagent');
    expect(cfg.agents.basher.prompt).toContain('expert at analyzing');
    expect(cfg.agents.basher.permission).toMatchObject({
      bash: 'allow',
      edit: 'deny',
      write: 'deny',
      glob: 'deny',
      grep: 'deny',
      task: 'deny',
      read: 'deny',
    });
  });
});

describe('createBasherTool', () => {
  function mockCtx() {
    return {
      client: {
        session: {
          create: mock(async () => ({ data: { id: 'child-1' } })),
          prompt: mock(async () => ({})),
          messages: mock(async () => ({
            data: [
              {
                info: { role: 'assistant' },
                parts: [{ type: 'text', text: 'All 17 tests passed.' }],
              },
            ],
          })),
          abort: mock(async () => ({})),
        },
      },
    } as any;
  }

  test('returns NL summary from child session', async () => {
    const ctx = mockCtx();
    const basher = createBasherTool(ctx);
    const result = await basher.execute(
      { command: 'npm test', what_to_summarize: 'Did tests pass?' },
      {} as any,
    );
    expect(result).toContain('All 17 tests passed');
    expect(ctx.client.session.create).toHaveBeenCalled();
    expect(ctx.client.session.prompt).toHaveBeenCalled();
  });

  test('sends command and what_to_summarize to child', async () => {
    const ctx = mockCtx();
    const basher = createBasherTool(ctx);
    await basher.execute(
      { command: 'npm test', what_to_summarize: 'Show failures only' },
      {} as any,
    );
    const promptArg = ctx.client.session.prompt.mock.calls[0][0];
    const text = promptArg.body.parts[0].text;
    expect(text).toContain('npm test');
    expect(text).toContain('Show failures only');
  });

  test('strips pipes before sending to child', async () => {
    const ctx = mockCtx();
    const basher = createBasherTool(ctx);
    await basher.execute(
      { command: 'cat log | head -n 20', what_to_summarize: 'Summary' },
      {} as any,
    );
    const text = ctx.client.session.prompt.mock.calls[0][0].body.parts[0].text;
    expect(text).toContain('cat log');
    expect(text).not.toContain('| head -n 20');
  });
});
