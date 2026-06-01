import { describe, expect, it } from 'bun:test';
import {
  consumeIterator,
  formatFindOutput,
  formatGrepOutput,
  storeIterator,
} from './format';
import { resolveExternalBasePath } from './index';
import {
  buildQuery,
  normalizeExcludes,
  normalizePathConstraint,
} from './query';

// ── index.ts ──

describe('resolveExternalBasePath', () => {
  it('treats path with extension as file → parent dir + filename', () => {
    const result = resolveExternalBasePath('/home/user/docs/readme.txt');
    expect(result.basePath).toBe('/home/user/docs');
    expect(result.pathConstraint).toBe('readme.txt');
  });

  it('treats path without extension as directory → self + null', () => {
    const result = resolveExternalBasePath('/home/user/project');
    expect(result.basePath).toBe('/home/user/project');
    expect(result.pathConstraint).toBeNull();
  });

  it('treats dot-prefixed path as file → parent dir + filename', () => {
    const result = resolveExternalBasePath('/home/user/.gitignore');
    expect(result.basePath).toBe('/home/user');
    expect(result.pathConstraint).toBe('.gitignore');
  });

  it('normalizes relative paths', () => {
    const result = resolveExternalBasePath('/tmp/../home/user/file.ts');
    expect(result.basePath).toBe('/home/user');
    expect(result.pathConstraint).toBe('file.ts');
  });
});

// ── query.ts ──

describe('normalizePathConstraint', () => {
  it('returns null for empty path', () => {
    expect(normalizePathConstraint('')).toBeNull();
  });

  it('returns null for current directory', () => {
    expect(normalizePathConstraint('.')).toBeNull();
    expect(normalizePathConstraint('./')).toBeNull();
  });

  it('strips leading ./', () => {
    expect(normalizePathConstraint('./src')).toBe('src/');
  });

  it('adds trailing slash for bare directory', () => {
    expect(normalizePathConstraint('src/components')).toBe('src/components/');
  });

  it('keeps trailing slash', () => {
    expect(normalizePathConstraint('src/')).toBe('src/');
  });

  it('keeps glob patterns unchanged', () => {
    expect(normalizePathConstraint('*.ts')).toBe('*.ts');
    expect(normalizePathConstraint('src/**/*.ts')).toBe('src/**/*.ts');
  });

  it('returns null for external absolute paths', () => {
    expect(normalizePathConstraint('/outside/repo')).toBeNull();
  });

  it('normalizes absolute path inside cwd', () => {
    const cwd = '/home/user/project';
    expect(normalizePathConstraint('/home/user/project/src', cwd)).toBe('src/');
  });
});

describe('normalizeExcludes', () => {
  it('returns empty array for null/undefined', () => {
    expect(normalizeExcludes(null)).toEqual([]);
    expect(normalizeExcludes(undefined)).toEqual([]);
  });

  it('normalizes comma-separated excludes', () => {
    const result = normalizeExcludes('test/,*.min.js');
    expect(result).toContain('!test/');
    expect(result).toContain('!*.min.js');
  });

  it('preserves negation prefix from input', () => {
    const result = normalizeExcludes('!dist/');
    expect(result).toContain('!dist/');
  });
});

describe('buildQuery', () => {
  it('builds simple pattern query', () => {
    expect(buildQuery(null, 'main.ts', null)).toBe('main.ts');
  });

  it('builds query with path constraint', () => {
    const q = buildQuery('src', 'main.ts', null);
    expect(q).toContain('src/');
    expect(q).toContain('main.ts');
  });

  it('builds query with excludes', () => {
    const q = buildQuery(null, 'TODO', 'test/');
    expect(q).toContain('!test/');
    expect(q).toContain('TODO');
  });

  it('allows external absolute paths with allowExternal=true', () => {
    const q = buildQuery('/tmp/other', 'file.txt', null, '/home/proj', true);
    expect(q).toContain('/tmp/other');
  });
});

// ── format.ts ──

describe('formatGrepOutput', () => {
  it('returns no matches message for empty result', () => {
    expect(formatGrepOutput({ items: [], totalMatched: 0 })).toBe(
      'No matches found',
    );
  });

  it('formats grep matches grouped by file', () => {
    const result = {
      items: [
        {
          relativePath: 'src/index.ts',
          fileName: 'index.ts',
          gitStatus: 'clean',
          size: 100,
          modified: 1000,
          isBinary: false,
          totalFrecencyScore: 0,
          accessFrecencyScore: 0,
          modificationFrecencyScore: 0,
          lineNumber: 10,
          col: 0,
          byteOffset: 0,
          lineContent: '  const x = 1;',
          matchRanges: [[8, 9] as [number, number]],
          contextBefore: [],
          contextAfter: ['const y = 2;'],
        },
        {
          relativePath: 'src/index.ts',
          fileName: 'index.ts',
          gitStatus: 'clean',
          size: 100,
          modified: 1000,
          isBinary: false,
          totalFrecencyScore: 0,
          accessFrecencyScore: 0,
          modificationFrecencyScore: 0,
          lineNumber: 12,
          col: 0,
          byteOffset: 0,
          lineContent: 'useEffect(() => {});',
          matchRanges: [[0, 9] as [number, number]],
          contextBefore: [],
          contextAfter: [],
        },
      ],
      totalMatched: 2,
    };

    const output = formatGrepOutput(result);
    expect(output).toContain('2 matches');
    expect(output).toContain('src/index.ts');
    expect(output).toContain('10:');
    expect(output).toContain('const x = 1;');
    expect(output).toContain('11-');
    expect(output).toContain('const y = 2;');
  });
});

describe('formatFindOutput', () => {
  it('returns no files message for empty result', () => {
    const result = formatFindOutput({ items: [], totalFiles: 0, totalMatched: 0 });
    expect(result).toBe('No matching files found');
  });

  it('formats file paths with total count', () => {
    const result = formatFindOutput(
      {
        items: [
          {
            relativePath: 'src/main.ts',
            fileName: 'main.ts',
            size: 500,
            modified: 1000,
            accessFrecencyScore: 0,
            modificationFrecencyScore: 0,
            totalFrecencyScore: 10,
            gitStatus: 'clean',
          },
        ],
        totalFiles: 20,
        totalMatched: 1,
      },
    );
    expect(result).toContain('1 matching file (20 total indexed)');
    expect(result).toContain('src/main.ts');
  });

  it('formats multiple matches without score heuristics', () => {
    const result = formatFindOutput(
      {
        items: [
          {
            relativePath: 'src/unrelated.ts',
            fileName: 'unrelated.ts',
            size: 200,
            modified: 1000,
            accessFrecencyScore: 0,
            modificationFrecencyScore: 0,
            totalFrecencyScore: 0,
            gitStatus: 'clean',
          },
        ],
        totalFiles: 250,
        totalMatched: 10,
      },
    );
    expect(result).toContain('10 matching files (250 total indexed)');
    expect(result).toContain('src/unrelated.ts');
  });
});

describe('iterator store', () => {
  it('stores and consumes iterator data once', () => {
    const data = {
      query: 'src/main',
      pageSize: 20,
      pageIndex: 1,
    };
    const id = storeIterator('ffi_f', data);
    expect(id).toMatch(/^ffi_f\d+$/);
    const retrieved = consumeIterator<typeof data>(id);
    expect(retrieved?.query).toBe('src/main');
    expect(retrieved?.pageIndex).toBe(1);
    expect(consumeIterator(id)).toBeUndefined();
  });

  it('returns undefined for unknown iterator id', () => {
    expect(consumeIterator('missing')).toBeUndefined();
  });
});
