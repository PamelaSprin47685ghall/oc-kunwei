import path from 'node:path';

import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import type { GrepCursor, GrepMode } from '@ff-labs/fff-node';

import {
  buildQuery,
  consumeIterator,
  createExternalFinder,
  FinderManager,
  fileAnnotation,
  formatFindOutput,
  formatGrepOutput,
  resolveExternalBasePath,
  storeIterator,
  truncateLine,
} from 'engine/fuzzy';

export { resolveExternalBasePath };

const z = tool.schema;

interface FuzzyFindIteratorState {
  query: string;
  pageSize: number;
  pageIndex: number;
  externalBasePath: string | null;
}

interface FuzzyGrepIteratorState {
  query: string;
  mode: GrepMode;
  smartCase: boolean;
  beforeContext: number;
  afterContext: number;
  pageSize: number;
  externalBasePath: string | null;
  cursor: GrepCursor | null;
}

// -- Fuzzy find tool --

const FUZZY_FIND_DESCRIPTION = `Search for files by fuzzy path text matching. Returns file paths ranked by relevance and frecency. Supports partial matches on file names and directory paths. Regex and glob syntax are not supported.

First call: provide pattern and optional path.
Later calls: provide only iterator.
Every result ends with iterator="..."; iteration is finished when it becomes iterator="".`;

export function createFuzzyFindTool(): ToolDefinition {
  return tool({
    description: FUZZY_FIND_DESCRIPTION,
    args: {
      pattern: z
        .string()
        .min(1)
        .nullish()
        .describe(
          "Initial plain fuzzy file path text to search for (e.g., 'component', 'src/utils/', 'Button.tsx'). Regex and glob syntax are not supported.",
        ),
      path: z
        .string()
        .nullish()
        .describe('Initial optional path constraint to narrow search scope'),
      limit: z
        .number()
        .int()
        .min(1)
        .nullish()
        .describe('Maximum number of results to return per call (default: 30)'),
      iterator: z
        .string()
        .nullish()
        .describe(
          'Opaque single-use iterator from a previous fuzzy_find result. On continuation, pass only this field. Iteration is finished when the result shows iterator="".',
        ),
    },
    execute: async (args, context) => {
      const external: { f: { destroy(): void } | null } = { f: null };
      try {
        const activeCwd = context.directory;
        let searchState: FuzzyFindIteratorState | undefined = args.iterator
          ? consumeIterator<FuzzyFindIteratorState>(args.iterator)
          : undefined;

        if (!searchState) {
          if (args.iterator) {
            return `fuzzy_find iterator error: unknown, expired, or already consumed iterator "${args.iterator}"`;
          }
          if (!args.pattern) {
            return 'pattern is required on the first call';
          }

          let externalBasePath: string | null = null;
          let externalPathConstraint: string | null = null;
          if (args.path && path.isAbsolute(args.path)) {
            const info = resolveExternalBasePath(path.resolve(args.path));
            externalBasePath = info.basePath;
            externalPathConstraint = info.pathConstraint;
          }

          searchState = {
            query: buildQuery(
              externalBasePath ? externalPathConstraint : args.path,
              args.pattern,
              undefined,
              externalBasePath ?? activeCwd,
              !!externalBasePath,
            ),
            pageSize: args.limit ?? 30,
            pageIndex: 0,
            externalBasePath,
          };
        }

        const externalBasePath = searchState.externalBasePath;
        const f = externalBasePath
          ? await (async () => {
              const finder = await createExternalFinder(externalBasePath);
              external.f = finder;
              return finder;
            })()
          : await FinderManager.get(activeCwd);

        const searchResult = f.fileSearch(searchState.query, {
          pageIndex: searchState.pageIndex,
          pageSize: searchState.pageSize,
        });
        if (!searchResult?.ok) {
          throw new Error(searchResult?.error || 'fuzzy_find failed');
        }

        const result = searchResult.value;
        if (!result?.items?.length) {
          return 'No matching files found\n\n[iterator=""]';
        }

        let output = formatFindOutput(result);
        const nextPageIndex = searchState.pageIndex + 1;
        output += `\n\n[iterator="${
          (result.totalMatched ?? 0) > nextPageIndex * searchState.pageSize
            ? storeIterator('ffi_f', {
                ...searchState,
                pageIndex: nextPageIndex,
              })
            : ''
        }"]`;

        return output;
      } catch (err) {
        return `fuzzy_find error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        if (external.f) {
          try {
            external.f.destroy();
          } catch {
            // cleanup best-effort
          }
        }
      }
    },
  });
}

// -- Fuzzy grep tool --

const FUZZY_GREP_DESCRIPTION = `Search file contents using fuzzy-aware content search. Smart-case, git-aware, frecency-ranked. Supports automatic regex mode for regex-like patterns and automatic fuzzy fallback when no exact matches are found.

First call: provide pattern and optional filters.
Later calls: provide only iterator.
Every result ends with iterator="..."; iteration is finished when it becomes iterator="".`;

export function createFuzzyGrepTool(): ToolDefinition {
  return tool({
    description: FUZZY_GREP_DESCRIPTION,
    args: {
      pattern: z
        .string()
        .min(1)
        .nullish()
        .describe(
          'Initial search pattern. Required on the first call. Supports literal text and regex-like patterns.',
        ),
      path: z
        .string()
        .nullish()
        .describe(
          "Initial path constraint (repo-relative or absolute path outside workspace). Use 'src/' or '*.ts' to narrow the first call.",
        ),
      exclude: z
        .union([z.string(), z.array(z.string())])
        .nullish()
        .describe("Initial exclude paths (e.g. 'test/,*.min.js')"),
      caseSensitive: z
        .boolean()
        .nullish()
        .describe(
          'Initial case-sensitivity override (smart-case by default - case-insensitive when pattern is all lowercase)',
        ),
      context: z
        .number()
        .int()
        .min(0)
        .nullish()
        .describe('Initial number of context lines before and after each match'),
      limit: z
        .number()
        .int()
        .min(1)
        .nullish()
        .describe('Maximum number of matches to return per call'),
      iterator: z
        .string()
        .nullish()
        .describe(
          'Opaque single-use iterator from a previous fuzzy_grep result. On continuation, pass only this field. Iteration is finished when the result shows iterator="".',
        ),
    },
    execute: async (args, context) => {
      const external: { f: { destroy(): void } | null } = { f: null };
      try {
        const activeCwd = context.directory;
        let searchState: FuzzyGrepIteratorState | undefined = args.iterator
          ? consumeIterator<FuzzyGrepIteratorState>(args.iterator)
          : undefined;

        if (!searchState) {
          if (args.iterator) {
            return `fuzzy_grep iterator error: unknown, expired, or already consumed iterator "${args.iterator}"`;
          }
          if (!args.pattern) {
            return 'pattern is required on the first call';
          }

          let externalBasePath: string | null = null;
          let externalPathConstraint: string | null = null;
          if (args.path && path.isAbsolute(args.path)) {
            const info = resolveExternalBasePath(path.resolve(args.path));
            externalBasePath = info.basePath;
            externalPathConstraint = info.pathConstraint;
          }

          const query = buildQuery(
            externalBasePath ? externalPathConstraint : args.path,
            args.pattern,
            args.exclude,
            externalBasePath ?? activeCwd,
            !!externalBasePath,
          );

          const hasRegexSyntax =
            args.pattern !== args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          let mode: GrepMode = hasRegexSyntax ? 'regex' : 'plain';
          if (mode === 'regex') {
            try {
              new RegExp(args.pattern);
            } catch {
              mode = 'plain';
            }
          }

          const trimmed = args.pattern.trim();
          const isWildcardOnly =
            hasRegexSyntax &&
            /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(
              trimmed,
            );
          if (isWildcardOnly) {
            return `Pattern '${args.pattern}' matches everything - fuzzy_grep needs a concrete substring or identifier.`;
          }

          searchState = {
            query,
            mode,
            smartCase: args.caseSensitive !== true,
            beforeContext: args.context ?? 0,
            afterContext: args.context ?? 0,
            pageSize: args.limit ?? 50,
            externalBasePath,
            cursor: null,
          };
        }

        const externalBasePath = searchState.externalBasePath;
        const f = externalBasePath
          ? await (async () => {
              const finder = await createExternalFinder(externalBasePath);
              external.f = finder;
              return finder;
            })()
          : await FinderManager.get(activeCwd);

        const grepResult = f.grep(searchState.query, {
          mode: searchState.mode,
          smartCase: searchState.smartCase,
          maxMatchesPerFile: Math.min(searchState.pageSize, 50),
          pageSize: searchState.pageSize,
          cursor: searchState.cursor,
          beforeContext: searchState.beforeContext,
          afterContext: searchState.afterContext,
          classifyDefinitions: true,
        });
        if (!grepResult?.ok) {
          throw new Error(grepResult?.error || 'fuzzy_grep failed');
        }

        let result = grepResult.value;
        let fuzzyNotice: string | null = null;
        if (!result?.items?.length && !args.iterator && searchState.mode !== 'regex') {
          try {
            const fuzzy = f.grep(searchState.query, {
              mode: 'fuzzy',
              smartCase: searchState.smartCase,
              maxMatchesPerFile: Math.min(searchState.pageSize, 50),
              pageSize: searchState.pageSize,
              cursor: null,
              beforeContext: 0,
              afterContext: 0,
              classifyDefinitions: true,
            });
            if (fuzzy?.ok && fuzzy.value?.items?.length) {
              fuzzyNotice = '0 exact matches. Maybe you meant this?';
              result = fuzzy.value;
              searchState = {
                ...searchState,
                mode: 'fuzzy',
                beforeContext: 0,
                afterContext: 0,
                cursor: null,
              };
            }
          } catch {
            // fuzzy fallback best-effort
          }
        }

        let output = formatGrepOutput(result);
        const notices: string[] = [];
        if (result?.regexFallbackError) {
          notices.push(
            `Invalid regex: ${result.regexFallbackError}, used literal match`
          );
        }
        notices.push(
          `iterator="${
            result?.nextCursor
              ? storeIterator('ffi_i', { ...searchState, cursor: result.nextCursor })
              : ''
          }"`,
        );
        if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
        if (fuzzyNotice) output = `[${fuzzyNotice}]\n${output}`;

        return output;
      } catch (err) {
        return `fuzzy_grep error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        if (external.f) {
          try {
            external.f.destroy();
          } catch {
            // cleanup best-effort
          }
        }
      }
    },
  });
}
