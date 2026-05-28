import type { PluginInput } from '@opencode-ai/plugin';

export async function extractSessionText(
  client: PluginInput['client'],
  sessionId: string,
  directory?: string,
): Promise<string> {
  const result = await client.session.messages({
    path: { id: sessionId },
    ...(directory ? { query: { directory } } : {}),
  });
  const messages = (result.data ?? []) as Array<{
    info?: { role?: string };
    parts?: Array<{ type?: string; text?: string }>;
  }>;
  const texts: string[] = [];
  for (const m of messages) {
    if (m.info?.role !== 'assistant') continue;
    for (const p of m.parts ?? []) {
      if (p.type === 'text' && p.text) texts.push(p.text);
    }
  }
  return texts.join('\n\n');
}

/**
 * Extract an AbortSignal from a context object.
 * Returns the signal if `context` is an object with an `abort` property
 * that looks like an AbortSignal (has `addEventListener`, `removeEventListener`, `aborted`).
 */
export function getAbortSignal(context: unknown): AbortSignal | undefined {
  if (typeof context !== 'object' || context === null) return undefined;
  const maybeSignal = (context as Record<string, unknown>).abort;
  if (
    typeof maybeSignal === 'object' &&
    maybeSignal !== null &&
    'addEventListener' in maybeSignal &&
    'removeEventListener' in maybeSignal &&
    'aborted' in maybeSignal
  ) {
    return maybeSignal as AbortSignal;
  }
  return undefined;
}

/**
 * Call `client.session.prompt` with optional abort signal support.
 *
 * - If the signal is already aborted, returns early without calling prompt.
 * - If no signal is provided, calls prompt directly.
 * - If a signal is provided, races the prompt against the abort signal and
 *   cleans up the listener in a finally block.
 *
 * Unhandled rejection on the prompt promise is prevented via `.catch(() => {})`.
 */
export async function promptWithAbort(
  client: PluginInput['client'],
  args: Parameters<PluginInput['client']['session']['prompt']>[0],
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  if (!signal) {
    await client.session.prompt(args);
    return;
  }

  const promptPromise = client.session.prompt(args).catch(() => {});

  let rejectAbort: (reason?: unknown) => void;
  const abortPromise = new Promise<void>((_, reject) => {
    rejectAbort = reject;
  });

  const onAbort = () => {
    rejectAbort(new DOMException('Aborted', 'AbortError'));
  };

  signal.addEventListener('abort', onAbort);

  try {
    await Promise.race([promptPromise, abortPromise]);
  } catch {
    // Aborted – suppress the error
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
