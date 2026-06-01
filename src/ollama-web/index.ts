import type { ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin/tool';

import {
  formatFetchResponse,
  formatSearchResults,
  ollamaPost,
  validateFetchUrl,
} from 'engine/ollama';

const validateUrl = validateFetchUrl;

export function createOllamaWebSearchTool(): ToolDefinition {
  return tool({
    description: [
      'Search the web for any topic and get clean, ready-to-use content.',
      '',
      'Best for: Finding current information, news, facts, people, companies,',
      'or answering questions about any topic.',
      'Returns: Clean text content from top search results.',
      '',
      'Query tips:',
      'describe the ideal page, not keywords. "blog post comparing React and Vue performance" not "React vs Vue".',
      'Use category:people / category:company to search through Linkedin profiles / companies respectively.',
    ].join('\n'),
    args: {
      query: tool.schema
        .string()
        .describe(
          'Natural language search query. Should be a semantically rich description of the ideal page, not just keywords.',
        ),
      numResults: tool.schema
        .number()
        .int()
        .positive()
        .optional()
        .describe('Number of search results to return (default: 10)'),
    },
    execute: async (
      args: { query: string; numResults?: number },
      context: { abort: AbortSignal },
    ) => {
      try {
        const data = (await ollamaPost(
          '/web_search',
          {
            query: args.query,
            max_results: args.numResults ?? 10,
          },
          context.abort,
        )) as { results?: Array<{ title: string; url: string; content: string }> };
        const results = data.results ?? [];
        return formatSearchResults(results) || 'No results found.';
      } catch (error) {
        if (context.abort.aborted) {
          return 'Request was cancelled';
        }
        return `Search failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

export function createOllamaWebFetchTool(): ToolDefinition {
  return tool({
    description:
      'Fetch a URL with better extraction for static/docs pages. Supports llms.txt probing, content-focused HTML extraction, metadata, redirects, and an optional prompt processed by a cheap secondary model.',
    args: {
      url: tool.schema.string().describe('The URL to fetch'),
      extract_main: tool.schema
        .boolean()
        .optional()
        .describe(
          'Extract main content from the page, removing navigation, ads, etc. (default: true)',
        ),
      prefer_llms_txt: tool.schema
        .enum(['auto', 'always', 'never'])
        .optional()
        .describe(
          'Probe for llms.txt files before fetching full page (default: auto)',
        ),
      prompt: tool.schema
        .string()
        .optional()
        .describe(
          'Optional extraction task to run on the fetched content using a cheap secondary model',
        ),
      timeout: tool.schema
        .number()
        .optional()
        .describe('Timeout in seconds (max 120)'),
    },
    execute: async (
      args: {
        url: string;
        extract_main?: boolean;
        prefer_llms_txt?: string;
        prompt?: string;
        timeout?: number;
      },
      context: { abort: AbortSignal },
    ) => {
      const validationError = await validateUrl(args.url);
      if (validationError) return validationError;

      try {
        const data = (await ollamaPost(
          '/web_fetch',
          {
            url: args.url,
            extract_main: args.extract_main ?? true,
            prefer_llms_txt: args.prefer_llms_txt ?? 'auto',
            prompt: args.prompt,
            timeout: args.timeout,
          },
          context.abort,
        )) as {
          title?: string;
          byline?: string;
          length?: number;
          content?: string;
        };

        return formatFetchResponse(data);
      } catch (error) {
        if (context.abort.aborted) {
          return 'Request was cancelled';
        }
        return `Fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
