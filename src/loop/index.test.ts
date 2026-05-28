import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  createLoopCommandManager,
  createLoopNudgeHook,
  createSubmitReviewResultTool,
  isReviewSession,
  reviewSessions,
  setReviewSession,
  Deferred,
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
    expect(isReviewSession('ses-1')).toBe(false);
  });

  test('can activate', () => {
    setReviewSession('ses-1', true);
    expect(isReviewSession('ses-1')).toBe(true);
  });

  test('can deactivate', () => {
    setReviewSession('ses-1', true);
    setReviewSession('ses-1', false);
    expect(isReviewSession('ses-1')).toBe(false);
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
      expect(commands['loop']).toBeDefined();
      expect(commands['loop'].description).toContain('review');
    });

    test('does not overwrite existing command', () => {
      const manager = createLoopCommandManager(createMockContext());
      const existing = { template: 'custom', description: 'custom' };
      const config: Record<string, unknown> = {
        command: { 'loop': existing },
      };

      manager.registerCommand(config);

      expect(
        (config.command as Record<string, unknown>)['loop'],
      ).toBe(existing);
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

      expect(isReviewSession('ses-1')).toBe(false);
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

      expect(isReviewSession('ses-1')).toBe(true);
      expect(output.parts[0]?.text).toContain('Refactor the auth module');
      expect(output.parts[0]?.text).toContain('loop mode is active');
      expect(output.parts[0]?.text).toContain('submit_review');
      expect(output.parts[0]?.text).toContain('affectedFiles');
    });

    test('does not toggle — already active is a no-op', async () => {
      setReviewSession('ses-1', true);
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

      expect(isReviewSession('ses-1')).toBe(true);
      expect(output.parts[0]?.text).toContain('already active');
    });

  });
});

describe('createSubmitReviewResultTool', () => {
  test('resolves pending result with null feedback (accept)', async () => {
    reviewSessions.set('reviewer-1', { active: false });
    const entry = reviewSessions.get('reviewer-1')!;
    entry.pendingResult = new Deferred<any>();

    const reviewTool = createSubmitReviewResultTool();
    const result = await (reviewTool as any).execute(
      { feedback: null },
      { sessionID: 'reviewer-1' },
    );

    expect(result).toContain('accepted');
    expect(entry.pendingResult).toBeUndefined();
  });

  test('resolves pending result with feedback (reject)', async () => {
    reviewSessions.set('reviewer-1', { active: false });
    const entry = reviewSessions.get('reviewer-1')!;
    entry.pendingResult = new Deferred<any>();

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
    reviewSessions.set('reviewer-1', { active: false });
    const entry = reviewSessions.get('reviewer-1')!;
    entry.pendingResult = new Deferred<any>();

    const reviewTool = createSubmitReviewResultTool();
    const result = await (reviewTool as any).execute(
      { feedback: '   ' },
      { sessionID: 'reviewer-1' },
    );

    expect(result).toContain('accepted');
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
    setReviewSession('ses-1', true);

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
    setReviewSession('ses-1', true);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 'ses-1' } },
    });

    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
  });

  test('suppresses nudge after abort error', async () => {
    const ctx = createMockContext();
    const hook = createLoopNudgeHook(ctx);
    setReviewSession('ses-1', true);

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
