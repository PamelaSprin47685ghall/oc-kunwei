import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  createLoopCommandManager,
  createLoopNudgeHook,
  createSubmitReviewResultTool,
  createSubmitReviewTool,
  Deferred,
  getReviewerConfig,
  reviewSessions,
} from './index';

function createMockContext() {
  return {
    directory: '/tmp/test-project',
    client: {
      session: {
        create: mock(() => ({ data: { id: 'reviewer-1' } })),
        prompt: mock(() => {}),
        messages: mock(() => ({
          data: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'null' }],
            },
          ],
        })),
        todo: mock(() => ({ data: [] })),
      },
    },
  } as any;
}

function createOutput() {
  return {
    parts: [{ type: 'text', text: 'template content' }] as Array<{
      type: string;
      text?: string;
    }>,
  };
}

afterEach(() => {
  reviewSessions.clear();
});

describe('reviewSessions state', () => {
  test('starts inactive', () => {
    expect(reviewSessions.isActive('ses-1')).toBe(false);
  });

  test('can activate and deactivate', () => {
    reviewSessions.activate('ses-1', 'test task');
    expect(reviewSessions.isActive('ses-1')).toBe(true);
    reviewSessions.deactivate('ses-1');
    expect(reviewSessions.isActive('ses-1')).toBe(false);
  });

  test('stores original task', () => {
    reviewSessions.activate('ses-1', 'Refactor the auth module');
    expect(reviewSessions.getTask('ses-1')).toBe('Refactor the auth module');
  });

  test('unlock on unknown session does not throw', () => {
    expect(() => reviewSessions.unlock('nonexistent')).not.toThrow();
  });
});

describe('createLoopCommandManager', () => {
  describe('registerCommand', () => {
    test('registers the /loop command', () => {
      const manager = createLoopCommandManager(createMockContext());
      const config: Record<string, unknown> = {};

      manager.registerCommand(config);

      const commands = config.command as Record<
        string,
        { template: string; description: string }
      >;
      expect(commands.loop).toBeDefined();
      expect(commands.loop.description).toContain('review');
    });

    test('does not overwrite existing command', () => {
      const manager = createLoopCommandManager(createMockContext());
      const existing = { template: 'custom', description: 'custom' };
      const config: Record<string, unknown> = {
        command: { loop: existing },
      };

      manager.registerCommand(config);

      expect((config.command as Record<string, unknown>).loop).toBe(existing);
    });
  });

  describe('handleCommandExecuteBefore', () => {
    test('ignores non-loop commands', async () => {
      const manager = createLoopCommandManager(createMockContext());
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'other', sessionID: 'ses-1', arguments: 'test' },
        output,
      );

      expect(output.parts).toHaveLength(1);
      expect(output.parts[0].text).toBe('template content');
    });

    test('swallows command with empty arguments', async () => {
      const manager = createLoopCommandManager(createMockContext());
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'loop', sessionID: 'ses-1', arguments: '' },
        output,
      );

      expect(reviewSessions.isActive('ses-1')).toBe(false);
      expect(output.parts[0]?.text).toContain('cancelled');
    });

    test('rewrites task arguments into structured prompt', async () => {
      const manager = createLoopCommandManager(createMockContext());
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        {
          command: 'loop',
          sessionID: 'ses-1',
          arguments: 'Refactor the auth module',
        },
        output,
      );

      expect(reviewSessions.isActive('ses-1')).toBe(true);
      expect(output.parts[0]?.text).toContain('Refactor the auth module');
      expect(output.parts[0]?.text).toContain('loop mode is active');
      expect(output.parts[0]?.text).toContain('submit_review');
      expect(output.parts[0]?.text).toContain('affectedFiles');
    });

    test('does not toggle [\u2014] already active is a no-op', async () => {
      reviewSessions.activate('ses-1', 'existing task');
      const manager = createLoopCommandManager(createMockContext());
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        {
          command: 'loop',
          sessionID: 'ses-1',
          arguments: 'some task',
        },
        output,
      );

      expect(reviewSessions.isActive('ses-1')).toBe(true);
      expect(output.parts[0]?.text).toContain('already active');
    });
  });
});

describe('createSubmitReviewResultTool', () => {
  test('resolves pending result with null feedback (accept)', async () => {
    reviewSessions.setPending('reviewer-1', new Deferred<any>());

    const reviewTool = createSubmitReviewResultTool();
    const result = await (reviewTool as any).execute(
      { feedback: null },
      { sessionID: 'reviewer-1' },
    );

    expect(result).toContain('accepted');
  });

  test('resolves pending result with feedback (reject)', async () => {
    reviewSessions.setPending('reviewer-1', new Deferred<any>());

    const reviewTool = createSubmitReviewResultTool();
    const result = await (reviewTool as any).execute(
      { feedback: 'Fix the error handling' },
      { sessionID: 'reviewer-1' },
    );

    expect(result).toContain('rejected');
  });

  test('returns error when no pending review', async () => {
    const reviewTool = createSubmitReviewResultTool();
    const result = await (reviewTool as any).execute(
      { feedback: null },
      { sessionID: 'unknown-session' },
    );

    expect(result).toContain('No pending review');
  });

  test('treats empty string as null (accept)', async () => {
    reviewSessions.setPending('reviewer-1', new Deferred<any>());

    const reviewTool = createSubmitReviewResultTool();
    const result = await (reviewTool as any).execute(
      { feedback: '   ' },
      { sessionID: 'reviewer-1' },
    );

    expect(result).toContain('accepted');
  });
});

describe('createSubmitReviewTool', () => {
  test('rejects when session is not in loop mode', async () => {
    const ctx = createMockContext();
    const tool = createSubmitReviewTool(ctx);
    const result = await (tool as any).execute(
      { report: 'did stuff', affectedFiles: ['a.ts'] },
      { sessionID: 'ses-1', directory: '/tmp' },
    );
    expect(result).toContain('do not need review');
  });

  test('rejects concurrent review attempts', async () => {
    reviewSessions.activate('ses-1', 'task');
    reviewSessions.tryLock('ses-1');

    const ctx = createMockContext();
    const tool = createSubmitReviewTool(ctx);
    const result = await (tool as any).execute(
      { report: 'did stuff', affectedFiles: ['a.ts'] },
      { sessionID: 'ses-1', directory: '/tmp' },
    );
    expect(result).toContain('already in progress');
  });

  test('releases lock when reviewer session creation fails', async () => {
    reviewSessions.activate('ses-1', 'task');

    const ctx = createMockContext();
    ctx.client.session.create = mock(async () => ({ data: { id: undefined } }));

    const tool = createSubmitReviewTool(ctx);
    const result = await (tool as any).execute(
      { report: 'did stuff', affectedFiles: ['a.ts'] },
      { sessionID: 'ses-1', directory: '/tmp' },
    );

    expect(result).toContain('Failed to create reviewer session');
    expect(reviewSessions.isActive('ses-1')).toBe(true);
    expect(reviewSessions.tryLock('ses-1')).toBe(true);
  });

  test('releases lock when client.session.create throws', async () => {
    reviewSessions.activate('ses-1', 'task');

    const ctx = createMockContext();
    ctx.client.session.create = mock(async () => {
      throw new Error('Session creation network error');
    });

    const tool = createSubmitReviewTool(ctx);
    await expect(
      (tool as any).execute(
        { report: 'did stuff', affectedFiles: ['a.ts'] },
        { sessionID: 'ses-1', directory: '/tmp' },
      ),
    ).rejects.toThrow('Session creation network error');

    expect(reviewSessions.isActive('ses-1')).toBe(true);
    expect(reviewSessions.tryLock('ses-1')).toBe(true);
  });

  test('reviewer config matches getReviewerConfig exactly', () => {
    const config = getReviewerConfig();
    expect(config.agents?.reviewer?.permission).toEqual({
      read: 'allow',
      bash: 'deny',
      edit: 'deny',
      write: 'deny',
      glob: 'deny',
      grep: 'deny',
      fuzzy_find: 'deny',
      fuzzy_grep: 'deny',
      task: 'deny',
    });
  });
});

describe('createLoopNudgeHook', () => {
  test('does not nudge when session is not in loop mode', async () => {
    const ctx = createMockContext();
    const hook = createLoopNudgeHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 'ses-1' } },
    });

    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
  });

  test('nudges when session is in loop mode and no open todos', async () => {
    const ctx = createMockContext();
    ctx.client.session.todo = mock(() => ({ data: [] }));
    const hook = createLoopNudgeHook(ctx);
    reviewSessions.activate('ses-1', 'task');

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 'ses-1' } },
    });

    expect(ctx.client.session.prompt).toHaveBeenCalledTimes(1);
  });

  test('does not nudge when there are open todos (todo nudge takes priority)', async () => {
    const ctx = createMockContext();
    ctx.client.session.todo = mock(() => ({
      data: [
        {
          id: '1',
          content: 'task',
          status: 'in_progress',
          priority: 'high',
        },
      ],
    }));
    const hook = createLoopNudgeHook(ctx);
    reviewSessions.activate('ses-1', 'task');

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 'ses-1' } },
    });

    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
  });

  test('suppresses nudge after abort error', async () => {
    const ctx = createMockContext();
    const hook = createLoopNudgeHook(ctx);
    reviewSessions.activate('ses-1', 'task');

    await hook.handleEvent({
      event: {
        type: 'session.error',
        properties: {
          sessionID: 'ses-1',
          error: { name: 'MessageAbortedError' },
        },
      },
    });

    ctx.client.session.todo = mock(() => ({ data: [] }));
    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 'ses-1' } },
    });

    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
  });

  test('ignores events without sessionID', async () => {
    const ctx = createMockContext();
    const hook = createLoopNudgeHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: {} },
    });

    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
  });
});
