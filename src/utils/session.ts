import type { PluginInput } from '@opencode-ai/plugin';
import { isAbortError } from 'engine/util';
import { readAssistantText, type Entry } from 'engine/session';

export { isAbortError };

export async function extractSessionText(
  client: PluginInput['client'],
  sessionId: string,
  directory?: string,
): Promise<string> {
  const result = await client.session.messages({
    path: { id: sessionId },
    ...(directory ? { query: { directory } } : {}),
  });
  const messages = asMessageArray(result.data);
  const entries: Entry[] = messages.map((m) => ({
    type: 'message',
    message: {
      role: m.info?.role,
      content: (m.parts ?? []) as Array<{ type?: string; text?: string }>,
    },
  }));
  return readAssistantText(entries) ?? '';
}

/**
 * Returns the abort signal if `context` is an object with an `abort` property
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

export function extractToolContext(
  context: unknown,
  fallbackDirectory: string,
): {
  directory: string;
  sessionID: string | undefined;
  abortSignal: AbortSignal | undefined;
} {
  const directory =
    context && typeof context === 'object' && 'directory' in context
      ? (context as { directory: string }).directory
      : fallbackDirectory;
  const sessionID =
    context && typeof context === 'object' && 'sessionID' in context
      ? (context as { sessionID: string }).sessionID
      : undefined;
  const abortSignal = getAbortSignal(context);
  return { directory, sessionID, abortSignal };
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

  const promptPromise = client.session.prompt(args);

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
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      promptPromise.catch(() => {});
      throw err;
    }
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export interface SubagentParams {
  agent: string;
  title: string;
  parts: Array<{ type: 'text'; text: string }>;
  directory: string;
  sessionID?: string;
  abortSignal?: AbortSignal;
}

export async function runSubagent(
  client: PluginInput['client'],
  params: SubagentParams,
): Promise<string> {
  const createResult = await client.session.create({
    query: { directory: params.directory },
    body: {
      parentID: params.sessionID,
      title: params.title,
    },
  });
  const childID = createResult.data?.id;
  if (!childID) return 'Failed to create child session';

  try {
    await promptWithAbort(
      client,
      {
        path: { id: childID },
        body: {
          agent: params.agent,
          parts: params.parts,
        },
      },
      params.abortSignal,
    );
  } catch (err) {
    if (isAbortError(err)) {
      try {
        client.session.abort({ path: { id: childID } });
      } catch (_) {}
      const text = await extractSessionText(client, childID, params.directory);
      return text ? `(aborted) ${text}` : '(aborted)';
    }
    throw err;
  }

  return (
    (await extractSessionText(client, childID, params.directory)) ||
    '(no output)'
  );
}

export interface TodoItem {
  id: string;
  content: string;
  status: string;
  priority: string;
}

export interface SessionMessage {
  info?: { role?: string };
  parts?: Array<{ type?: string; text?: string }>;
}

export function asTodoArray(data: unknown): TodoItem[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (item): item is TodoItem =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as TodoItem).id === 'string' &&
      typeof (item as TodoItem).status === 'string',
  );
}

export function asMessageArray(data: unknown): SessionMessage[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (item): item is SessionMessage => typeof item === 'object' && item !== null,
  );
}
