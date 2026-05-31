// Type-only import from @ff-labs/fff-node - erased at build time.
// The package is an optional dependency; types are used for internal
// result shapes only.
import type { GrepResult, SearchResult } from '@ff-labs/fff-node';

// -- Line truncation --

const GREP_MAX_LINE_LENGTH = 500;

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
  const trimmed = line.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

// -- File annotation --

const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;

interface FileAnnotationItem {
  gitStatus: string;
  totalFrecencyScore: number;
  accessFrecencyScore: number;
}

function fffFileAnnotation(item: FileAnnotationItem): string {
  try {
    const git = item.gitStatus;
    if (git && git !== 'clean' && git !== 'unknown' && git !== '') {
      return `  [${git} in git]`;
    }
    const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
    if (frecency >= HOT_FRECENCY) return '  [VERY often touched file]';
    if (frecency >= WARM_FRECENCY) return '  [often touched file]';
  } catch {
    // best effort
  }
  return '';
}

// -- Grep output formatting --

export function formatGrepOutput(
  result: Pick<GrepResult, 'items' | 'totalMatched'>,
): string {
  try {
    if (!result?.items?.length) return 'No matches found';
    const totalMatched = result.totalMatched ?? result.items.length;
    const lines: string[] = [
      `${totalMatched} match${totalMatched === 1 ? '' : 'es'}`,
      '',
    ];
    let currentFile = '';
    for (const match of result.items) {
      if (!match) continue;
      if (match.relativePath !== currentFile) {
        if (lines.length > 0) lines.push('');
        currentFile = match.relativePath;
        lines.push(`${currentFile}${fffFileAnnotation(match)}`);
      }
      match.contextBefore?.forEach((line: string, i: number) => {
        const ctxLen = match.contextBefore?.length ?? 0;
        const lineNum = match.lineNumber - ctxLen + i;
        lines.push(` ${lineNum}- ${truncateLine(line)}`);
      });
      lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);
      match.contextAfter?.forEach((line: string, i: number) => {
        const lineNum = match.lineNumber + 1 + i;
        lines.push(` ${lineNum}- ${truncateLine(line)}`);
      });
    }
    return lines.join('\n');
  } catch {
    return '(error formatting grep output)';
  }
}

// -- Find output formatting --

export function formatFindOutput(
  result: Pick<SearchResult, 'items' | 'totalFiles' | 'totalMatched'>,
): string {
  try {
    if (!result?.items?.length) return 'No matching files found';
    const totalMatched = result.totalMatched ?? result.items.length;
    const totalFiles = result.totalFiles ?? 0;
    const lines: string[] = [
      `${totalMatched} matching file${totalMatched === 1 ? '' : 's'} (${totalFiles} total indexed)`,
      '',
    ];
    for (const item of result.items) {
      if (!item) continue;
      lines.push(`${item.relativePath}${fffFileAnnotation(item as FileAnnotationItem)}`);
    }
    return lines.join('\n');
  } catch {
    return '(error formatting find output)';
  }
}

// -- Iterator store --

const iteratorStore = new Map<string, unknown>();
let iteratorCounter = 0;

export function storeIterator(prefix: string, data: unknown): string {
  const id = `${prefix}${++iteratorCounter}`;
  iteratorStore.set(id, data);
  if (iteratorStore.size > 200) {
    const first = iteratorStore.keys().next().value;
    if (first) iteratorStore.delete(first);
  }
  return id;
}

export function consumeIterator<T>(id: string): T | undefined {
  const value = iteratorStore.get(id) as T | undefined;
  if (value !== undefined) iteratorStore.delete(id);
  return value;
}
