import { describe, expect, mock, test } from 'bun:test';
import { createNudgeTodoHook } from './index';

describe('nudge-todo', () => {
  function mockCtx(overrides?: {
    todo?: Array<{
      id: string;
      content: string;
      status: string;
      priority: string;
    }>;
    messages?: Array<{
      info: { role: string };
      parts: Array<{ type: string; text?: string }>;
    }>;
  }) {
    return {
      client: {
        session: {
          todo: mock(async () => ({ data: overrides?.todo ?? [] })),
          messages: mock(async () => ({ data: overrides?.messages ?? [] })),
          prompt: mock(async () => ({})),
        },
      },
    } as any;
  }

  test('idle + open todos → injects continuation', async () => {
    const ctx = mockCtx({
      todo: [{ id: '1', content: 'x', status: 'pending', priority: 'high' }],
    });
    const hook = createNudgeTodoHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 's1' } },
    });

    expect(ctx.client.session.prompt).toHaveBeenCalledTimes(1);
    const call = ctx.client.session.prompt.mock.calls[0][0];
    expect(call.path.id).toBe('s1');
    expect(call.body.parts[0].text).toContain('incomplete todos');
  });

  test('all todos done → no injection', async () => {
    const ctx = mockCtx({
      todo: [{ id: '1', content: 'x', status: 'completed', priority: 'high' }],
    });
    const hook = createNudgeTodoHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 's1' } },
    });

    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
  });

  test('abort error suppresses continuation', async () => {
    const ctx = mockCtx({
      todo: [{ id: '1', content: 'x', status: 'pending', priority: 'high' }],
    });
    const hook = createNudgeTodoHook(ctx);

    await hook.handleEvent({
      event: {
        type: 'session.error',
        properties: { sessionID: 's1', error: { name: 'MessageAbortedError' } },
      },
    });

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 's1' } },
    });

    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
  });

  test('no sessionID → no-op', async () => {
    const ctx = mockCtx();
    const hook = createNudgeTodoHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: {} },
    });

    expect(ctx.client.session.todo).not.toHaveBeenCalled();
  });

  test('idle + open todos + last message has <skip-todo-check /> → no injection', async () => {
    const ctx = mockCtx({
      todo: [{ id: '1', content: 'x', status: 'pending', priority: 'high' }],
      messages: [
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'Some response <skip-todo-check />' }],
        },
      ],
    });
    const hook = createNudgeTodoHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 's1' } },
    });

    expect(ctx.client.session.messages).toHaveBeenCalledTimes(1);
    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
  });
});
