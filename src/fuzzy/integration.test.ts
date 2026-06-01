import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildQuery, normalizeExcludes, normalizePathConstraint } from './query';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'fuzzy-integ-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('fuzzy find / grep integration', () => {
  it('buildQuery assembles path + excludes + pattern for grep', () => {
    const q = buildQuery('src', 'TODO', 'test/,*.min.js', cwd);
    expect(q).toContain('src/');
    expect(q).toContain('!test/');
    expect(q).toContain('!*.min.js');
    expect(q.endsWith('TODO')).toBe(true);
  });

  it('normalizePathConstraint strips ./ and adds / for bare dirs', () => {
    expect(normalizePathConstraint('./src', cwd)).toBe('src/');
    expect(normalizePathConstraint('src/components', cwd)).toBe('src/components/');
  });

  it('normalizePathConstraint leaves globs alone', () => {
    expect(normalizePathConstraint('*.ts', cwd)).toBe('*.ts');
    expect(normalizePathConstraint('src/**/*.ts', cwd)).toBe('src/**/*.ts');
  });

  it('normalizePathConstraint returns null for absolute paths outside cwd', () => {
    expect(normalizePathConstraint('/etc/passwd', cwd)).toBeNull();
  });

  it('normalizeExcludes handles string, array, null, undefined', () => {
    expect(normalizeExcludes(null, cwd)).toEqual([]);
    expect(normalizeExcludes(undefined, cwd)).toEqual([]);
    expect(normalizeExcludes('dist/,*.tmp', cwd)).toEqual(['!dist/', '!*.tmp']);
    expect(normalizeExcludes(['dist/', '*.tmp'], cwd)).toEqual([
      '!dist/',
      '!*.tmp',
    ]);
  });

  it('buildQuery with external path passes absolute path through', () => {
    const q = buildQuery('/outside/file.txt', 'main', null, cwd, true);
    expect(q).toContain('/outside/file.txt');
    expect(q.endsWith('main')).toBe(true);
  });

});
