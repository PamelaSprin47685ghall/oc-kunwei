import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReverieTool, getReverieConfig } from './index';

describe('getReverieConfig', () => {
  test('returns reverie agent with empty tools', () => {
    const cfg = getReverieConfig();
    expect(cfg.agents.reverie.mode).toBe('subagent');
    expect(cfg.agents.reverie.prompt).toContain('quiet room');
    expect(cfg.agents.reverie.permission).toEqual({
      bash: 'deny',
      edit: 'deny',
      write: 'deny',
      glob: 'deny',
      grep: 'deny',
      fuzzy_find: 'deny',
      fuzzy_grep: 'deny',
      task: 'deny',
      read: 'deny',
    });
  });
});

describe('createReverieTool', () => {
  function mockCtx() {
    return {
      directory: '/test',
      client: {
        session: {
          create: mock(async () => ({ data: { id: 'reverie-child-1' } })),
          prompt: mock(async () => ({})),
          messages: mock(async () => ({
            data: [
              {
                info: { role: 'assistant' },
                parts: [
                  {
                    type: 'text',
                    text: 'After careful consideration, the deadlock arises from the circular dependency between A and B.',
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

  test('returns answer from child session', async () => {
    const ctx = mockCtx();
    const reverie = createReverieTool(ctx);
    const result = await reverie.execute(
      { intent: 'Why is there a deadlock?', files: [] },
      {} as any,
    );
    expect(result).toContain('deadlock');
    expect(ctx.client.session.create).toHaveBeenCalled();
    expect(ctx.client.session.prompt).toHaveBeenCalled();
  });

  test('sends question and file context to child', async () => {
    const ctx = mockCtx();
    const reverie = createReverieTool(ctx);
    await reverie.execute(
      { intent: 'Is this architecture sound?', files: [] },
      {} as any,
    );
    const promptArg = ctx.client.session.prompt.mock.calls[0][0];
    const texts = promptArg.body.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text);
    expect(texts.some((t: string) => t.includes('architecture sound'))).toBe(
      true,
    );
  });

  test('uses reverie agent', async () => {
    const ctx = mockCtx();
    const reverie = createReverieTool(ctx);
    await reverie.execute({ intent: 'What?', files: [] }, {} as any);
    const promptArg = ctx.client.session.prompt.mock.calls[0][0];
    expect(promptArg.body.agent).toBe('reverie');
  });

  test('includes file contents in prompt', async () => {
    const ctx = mockCtx();
    const reverie = createReverieTool(ctx);
    await reverie.execute(
      { intent: 'Analyze this', files: ['src/main.ts', 'src/lib.ts'] },
      {} as any,
    );
    const promptArg = ctx.client.session.prompt.mock.calls[0][0];
    const texts = promptArg.body.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text);
    expect(texts.some((t: string) => t.includes('=== src/main.ts ==='))).toBe(
      true,
    );
    expect(texts.some((t: string) => t.includes('=== src/lib.ts ==='))).toBe(
      true,
    );
  });
});

describe('reverie path sandbox', () => {
  let projectDir: string;
  let outsideDir: string;

  function mockCtx(directory: string) {
    return {
      directory,
      client: {
        session: {
          create: mock(async () => ({ data: { id: 'reverie-sandbox-1' } })),
          prompt: mock(async () => ({})),
          messages: mock(async () => ({ data: [] })),
          abort: mock(async () => ({})),
        },
      },
    } as any;
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'reverie-proj-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'reverie-out-'));
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'safe.ts'), 'safe content');
    writeFileSync(join(outsideDir, 'secret.txt'), 'TOP SECRET');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test('rejects files outside project directory', async () => {
    const ctx = mockCtx(projectDir);
    const reverie = createReverieTool(ctx);
    await reverie.execute(
      {
        intent: 'review',
        files: [`${outsideDir}/secret.txt`],
      },
      {} as any,
    );
    const promptArg = ctx.client.session.prompt.mock.calls[0][0];
    const texts = promptArg.body.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n');
    expect(texts).toContain('outside project directory');
    expect(texts).not.toContain('TOP SECRET');
  });

  test('accepts files inside project directory', async () => {
    const ctx = mockCtx(projectDir);
    const reverie = createReverieTool(ctx);
    await reverie.execute(
      { intent: 'review', files: ['src/safe.ts'] },
      {} as any,
    );
    const promptArg = ctx.client.session.prompt.mock.calls[0][0];
    const texts = promptArg.body.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n');
    expect(texts).toContain('safe content');
  });
});
