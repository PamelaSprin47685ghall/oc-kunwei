import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createOllamaWebFetchTool, createOllamaWebSearchTool } from './index';

beforeEach(() => {
  mock.module('./key', () => ({
    OLLAMA_API_KEY: 'test-api-key',
  }));
});

afterEach(() => {
  mock.restore();
});

describe('createOllamaWebFetchTool', () => {
  test('rejects invalid URL', async () => {
    const tool = createOllamaWebFetchTool();
    const result = await (tool as any).execute(
      { url: 'not-a-url' },
      { abort: new AbortController().signal },
    );
    expect(result).toBe('Invalid URL: not-a-url');
  });

  test('rejects unsupported protocol', async () => {
    const tool = createOllamaWebFetchTool();
    const result = await (tool as any).execute(
      { url: 'file:///etc/passwd' },
      { abort: new AbortController().signal },
    );
    expect(result).toBe(
      'Unsupported protocol: file:. Only http: and https: are allowed.',
    );
  });

  test('rejects ftp protocol', async () => {
    const tool = createOllamaWebFetchTool();
    const result = await (tool as any).execute(
      { url: 'ftp://example.com/file' },
      { abort: new AbortController().signal },
    );
    expect(result).toBe(
      'Unsupported protocol: ftp:. Only http: and https: are allowed.',
    );
  });

  test('accepts valid https URL and calls API', async () => {
    global.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            title: 'Test',
            content: '<p>hello</p>',
            byline: '',
            length: 100,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    ) as any;

    const tool = createOllamaWebFetchTool();
    const result = await (tool as any).execute(
      { url: 'https://example.com/doc' },
      { abort: new AbortController().signal },
    );

    expect(result).toContain('Title: Test');
    expect(result).toContain('hello');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const callUrl = (global.fetch as any).mock.calls[0][0];
    expect(callUrl).toContain('/web_fetch');
  });

  test('accepts valid http URL', async () => {
    global.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            title: 'HTTP',
            content: 'ok',
            byline: '',
            length: 50,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    ) as any;

    const tool = createOllamaWebFetchTool();
    const result = await (tool as any).execute(
      { url: 'http://example.com/page' },
      { abort: new AbortController().signal },
    );
    expect(result).toContain('Title: HTTP');
  });

  test('handles API error response', async () => {
    global.fetch = mock(
      async () =>
        new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' }),
    ) as any;

    const tool = createOllamaWebFetchTool();
    const result = await (tool as any).execute(
      { url: 'https://example.com/error' },
      { abort: new AbortController().signal },
    );
    expect(result).toContain('Ollama API error (502)');
  });

  test('handles aborted request', async () => {
    const controller = new AbortController();
    global.fetch = mock(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    }) as any;

    const tool = createOllamaWebFetchTool();
    const result = await (tool as any).execute(
      { url: 'https://example.com/slow' },
      { abort: controller.signal },
    );
    expect(result).toBe('Request was cancelled');
  });
});

describe('createOllamaWebSearchTool', () => {
  test('sends query to API and returns results', async () => {
    global.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              { title: 'Result 1', url: 'https://example.com/1' },
              { title: 'Result 2', url: 'https://example.com/2' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    ) as any;

    const tool = createOllamaWebSearchTool();
    const result = await (tool as any).execute(
      { query: 'test search', numResults: 5 },
      { abort: new AbortController().signal },
    );

    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.query).toBe('test search');
  });

  test('handles API error', async () => {
    global.fetch = mock(
      async () =>
        new Response('Unauthorized', {
          status: 401,
          statusText: 'Unauthorized',
        }),
    ) as any;

    const tool = createOllamaWebSearchTool();
    const result = await (tool as any).execute(
      { query: 'test' },
      { abort: new AbortController().signal },
    );
    expect(result).toContain('Ollama API error (401)');
  });

  test('handles abort', async () => {
    const controller = new AbortController();
    global.fetch = mock(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    }) as any;

    const tool = createOllamaWebSearchTool();
    const result = await (tool as any).execute(
      { query: 'test' },
      { abort: controller.signal },
    );
    expect(result).toBe('Request was cancelled');
  });
});
