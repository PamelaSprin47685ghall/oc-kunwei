import { describe, expect, mock, test } from 'bun:test';
import { createEditorTool, getEditorConfig } from './index';

describe('getEditorConfig', () => {
  test('returns editor agent with basher tool and r/w/e permission', () => {
    const cfg = getEditorConfig();
    expect(cfg.agents.editor.mode).toBe('subagent');
    expect(cfg.agents.editor.prompt).toContain('code editing');
    expect(cfg.agents.editor.tools).toEqual({ basher: true, explorer: true });
    expect(cfg.agents.editor.permission).toMatchObject({
      read: 'allow',
      write: 'allow',
      edit: 'allow',
      explorer: 'allow',
      basher: 'allow',
    });
  });
});

describe('createEditorTool', () => {
  function mockCtx() {
    return {
      client: {
        session: {
          create: mock(async () => ({ data: { id: 'editor-child-1' } })),
          prompt: mock(async () => ({})),
          messages: mock(async () => ({
            data: [
              {
                info: { role: 'assistant' },
                parts: [
                  {
                    type: 'text',
                    text: 'Changed src/foo.ts: renamed bar to baz',
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
    const editor = createEditorTool(ctx);
    const result = await editor.execute(
      { task: 'Rename bar to baz in src/foo.ts' },
      {} as any,
    );
    expect(result).toContain('Changed src/foo.ts');
    expect(ctx.client.session.create).toHaveBeenCalled();
    expect(ctx.client.session.prompt).toHaveBeenCalled();
  });

  test('sends task to child session', async () => {
    const ctx = mockCtx();
    const editor = createEditorTool(ctx);
    await editor.execute(
      { task: 'Add isEven function to src/utils.ts' },
      {} as any,
    );
    const promptArg = ctx.client.session.prompt.mock.calls[0][0];
    const text = promptArg.body.parts[0].text;
    expect(text).toBe('Add isEven function to src/utils.ts');
  });

  test('uses editor agent', async () => {
    const ctx = mockCtx();
    const editor = createEditorTool(ctx);
    await editor.execute({ task: 'Fix bug in main.ts' }, {} as any);
    const promptArg = ctx.client.session.prompt.mock.calls[0][0];
    expect(promptArg.body.agent).toBe('editor');
  });
});
