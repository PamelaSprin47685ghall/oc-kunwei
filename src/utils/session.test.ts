import { afterEach, describe, expect, mock, test } from 'bun:test';
import { promptWithAbort } from './session';

function createMockClient() {
  return {
    session: {
      prompt: mock(() => Promise.resolve()),
    },
  } as any;
}

afterEach(() => {
  mock.restore();
});

describe('promptWithAbort', () => {
  test('calls prompt directly when no signal provided', async () => {
    const client = createMockClient();
    await promptWithAbort(client, { parts: [] });
    expect(client.session.prompt).toHaveBeenCalledTimes(1);
  });

  test('returns early if signal already aborted', async () => {
    const client = createMockClient();
    const controller = new AbortController();
    controller.abort();
    await promptWithAbort(client, { parts: [] }, controller.signal);
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  test('propagates abort error through Promise.race', async () => {
    const client = createMockClient();
    client.session.prompt = mock(
      () =>
        new Promise(() => {
          // Never resolves so abort signal wins the race
        }),
    );

    const controller = new AbortController();
    const promptPromise = promptWithAbort(
      client,
      { parts: [] },
      controller.signal,
    );

    controller.abort();

    await expect(promptPromise).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('handles late prompt rejection after abort to avoid unhandled rejection', async () => {
    const client = createMockClient();
    let rejectPromptRef: ((reason?: unknown) => void) | undefined;
    client.session.prompt = mock(
      () =>
        new Promise((_, reject) => {
          rejectPromptRef = reject;
        }),
    );

    const controller = new AbortController();
    const promptPromise = promptWithAbort(
      client,
      { parts: [] },
      controller.signal,
    );

    controller.abort();

    await expect(promptPromise).rejects.toThrow(DOMException);

    rejectPromptRef?.(new Error('Late error'));
    await new Promise((r) => setTimeout(r, 10));
  });

  test('propagates non-abort errors through Promise.race', async () => {
    const client = createMockClient();
    client.session.prompt = mock(() =>
      Promise.reject(new Error('Prompt failed')),
    );

    const controller = new AbortController();
    await expect(
      promptWithAbort(client, { parts: [] }, controller.signal),
    ).rejects.toThrow('Prompt failed');
  });
});
