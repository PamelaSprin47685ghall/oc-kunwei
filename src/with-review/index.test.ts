import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  createWithReviewCommandManager,
  createWithReviewNudgeHook,
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

describe('createWithReviewCommandManager', () => {
  describe('registerCommand', () => {
    test('registers the /with-review command', () => {
      const manager = createWithReviewCommandManager(createMockContext());
      const config: Record<string, unknown> = {};

      manager.registerCommand(config);

      const commands = config.command as Record<
        string,
        { template: string; description: string }
      >;
      expect(commands['with-review']).toBeDefined();
      expect(commands['with-review'].description).toContain('review');
    });

    test('does not overwrite existing command', () => {
      const manager = createWithReviewCommandManager(createMockContext());
      const existing = { template: 'custom', description: 'custom' };
      const config: Record<string, unknown> = {
        command: { 'with-review': existing },
      };

      manager.registerCommand(config);

      expect(
        (config.command as Record<string, unknown>)['with-review'],
      ).toBe(existing);
    });
  });

  describe('handleCommandExecuteBefore', () => {
    test('ignores non-with-review commands', async () => {
      const manager = createWithReviewCommandManager(createMockContext());
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'other', sessionID: 'ses-1', arguments: 'test' },
        output,
      );

      expect(output.parts).toHaveLength(1);
      expect(output.parts[0].text).toBe('template content');
    });

    test('swallows command with empty arguments', async () => {
      const manager = createWithReviewCommandManager(createMockContext());
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        { command: 'with-review', sessionID: 'ses-1', arguments: '' },
        output,
      );

      expect(isReviewSession('ses-1')).toBe(false);
      expect(output.parts[0]?.text).toContain('cancelled');
    });

    test('rewrites task arguments into structured prompt', async () => {
      const manager = createWithReviewCommandManager(createMockContext());
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        {
          command: 'with-review',
          sessionID: 'ses-1',
          arguments: 'Refactor the auth module',
        },
        output,
      );

      expect(isReviewSession('ses-1')).toBe(true);
      expect(output.parts[0]?.text).toContain('Refactor the auth module');
      expect(output.parts[0]?.text).toContain('with-review mode is active');
      expect(output.parts[0]?.text).toContain('submit_review');
      expect(output.parts[0]?.text).toContain('affectedFiles');
    });

    test('does not toggle — already active is a no-op', async () => {
      setReviewSession('ses-1', true);
      const manager = createWithReviewCommandManager(createMockContext());
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        {
          command: 'with-review',
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
    setReviewSession('reviewer-1', false);
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
    setReviewSession('reviewer-1', false);
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
    setReviewSession('reviewer-1', false);
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

describe('createWithReviewNudgeHook', () => {
  test('does not nudge when session is not in with-review mode', async () => {
    const ctx = createMockContext();
    const hook = createWithReviewNudgeHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 'ses-1' } },
    });

    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
  });

  test('nudges when session is in with-review mode and no open todos', async () => {
    const ctx = createMockContext();
    ctx.client.session.todo = mock(() => ({ data: [] }));
    const hook = createWithReviewNudgeHook(ctx);
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
    const hook = createWithReviewNudgeHook(ctx);
    setReviewSession('ses-1', true);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: { sessionID: 'ses-1' } },
    });

    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
  });

  test('suppresses nudge after abort error', async () => {
    const ctx = createMockContext();
    const hook = createWithReviewNudgeHook(ctx);
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
    const hook = createWithReviewNudgeHook(ctx);

    await hook.handleEvent({
      event: { type: 'session.idle', properties: {} },
    });

    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
  });
});
