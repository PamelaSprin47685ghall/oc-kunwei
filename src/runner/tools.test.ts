import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripHeadTailPipes } from './no-head-tail.js';
import {
  abort,
  cleanupJob,
  createJavascriptPrelude,
  type ExecuteResult,
  execute,
  getActiveJobs,
  resolveJavascriptSpecifier,
  rewriteJavascriptModuleSpecifiers,
  type WaitResult,
  wait,
} from './tools.js';

const hasNpx = (() => {
  try {
    execFileSync('npx', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const itIfNpx = hasNpx ? it : it.skip;

describe('Runner Tools', () => {
  beforeEach(() => {
    const jobs = getActiveJobs();
    for (const [sessionId] of jobs) {
      cleanupJob(sessionId);
    }
  });

  afterEach(() => {
    const jobs = getActiveJobs();
    for (const [sessionId] of jobs) {
      cleanupJob(sessionId);
    }
  });

  describe('execute', () => {
    it('should execute fast shell command and return synchronously', async () => {
      const result: ExecuteResult = await execute({
        sessionId: 'test-fast-shell',
        program: 'echo "hello"',
        language: 'shell',
      });

      expect(result.background).toBe(false);
      expect(result.output).toContain('hello');
    });

    it('should execute fast Python code and return synchronously', async () => {
      const result: ExecuteResult = await execute({
        sessionId: 'test-fast-python',
        program: 'print("hello from python")',
        language: 'python',
      });

      expect(result.background).toBe(false);
      expect(result.output).toContain('hello from python');
    });

    itIfNpx(
      'should background slow JavaScript code (no real-time wait)',
      async () => {
        const result: ExecuteResult = await execute({
          sessionId: 'test-bg-js',
          program: 'setInterval(() => {}, 60000);',
          language: 'javascript',
          earlyTimeoutMs: 50,
        });

        expect(result.background).toBe(true);
        expect(result.jobId).toBe('test-bg-js');
        abort('test-bg-js');
      },
    );

    itIfNpx(
      'should background JavaScript with CJS require prelude (no real-time wait)',
      async () => {
        const result: ExecuteResult = await execute({
          sessionId: 'test-bg-js-require',
          program: [
            'const path = require("node:path");',
            'console.log("basename=" + path.basename("/tmp/foo.txt"));',
          ].join('\n'),
          language: 'javascript',
          earlyTimeoutMs: 50,
        });

        expect(result.background).toBe(true);
        abort('test-bg-js-require');
      },
    );

    itIfNpx(
      'should background JavaScript with rewritten relative imports (no real-time wait)',
      async () => {
        const tmpDir = join(
          tmpdir(),
          `oc-kunwei-runner-fixture-${randomUUID()}`,
        );
        mkdirSync(tmpDir, { recursive: true });
        writeFileSync(
          join(tmpDir, 'fixture-relimport.mjs'),
          'export const value = 42;\n',
        );
        try {
          const result: ExecuteResult = await execute({
            sessionId: 'test-bg-js-relimport',
            program: [
              'import { value } from "./fixture-relimport.mjs";',
              'console.log("got=" + value);',
            ].join('\n'),
            language: 'javascript',
            earlyTimeoutMs: 50,
            cwd: tmpDir,
          });
          expect(result.background).toBe(true);
          abort('test-bg-js-relimport');
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      },
    );

    it('should background slow commands', async () => {
      const result: ExecuteResult = await execute({
        sessionId: 'test-slow',
        program: 'sleep 10',
        language: 'shell',
        earlyTimeoutMs: 50,
      });

      expect(result.background).toBe(true);
      expect(result.jobId).toBe('test-slow');
    });

    it('should block duplicate execution', async () => {
      await execute({
        sessionId: 'test-duplicate',
        program: 'sleep 10',
        language: 'shell',
        earlyTimeoutMs: 50,
      });

      try {
        await execute({
          sessionId: 'test-duplicate',
          program: 'echo "should fail"',
          language: 'shell',
          earlyTimeoutMs: 50,
        });
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain('A task is already running');
      }
    });
  });

  describe('wait', () => {
    it('returns completed result with empty output if no active job', async () => {
      const result = await wait({ sessionId: 'nonexistent', ms: 1000 });
      expect(result.completed).toBe(true);
      expect(result.output).toBe('');
      expect(result.message).toContain('No active job');
    });

    it('should wait and return output for background task', async () => {
      const execResult = await execute({
        sessionId: 'test-wait',
        program: 'sleep 10',
        language: 'shell',
        earlyTimeoutMs: 50,
      });

      if (execResult.background) {
        const waitResult: WaitResult = await wait({
          sessionId: 'test-wait',
          ms: 1000,
        });

        expect(waitResult.completed).toBe(false);
      }
    });

    it('should detect completed task', async () => {
      const execResult = await execute({
        sessionId: 'test-complete',
        program: 'echo "finished"',
        language: 'shell',
        earlyTimeoutMs: 50,
      });

      if (execResult.background) {
        const waitResult: WaitResult = await wait({
          sessionId: 'test-complete',
          ms: 1000,
        });

        expect(waitResult.completed).toBe(true);
        expect(waitResult.output).toContain('finished');
      }
    });
  });

  describe('abort', () => {
    it('should abort running task', async () => {
      await execute({
        sessionId: 'test-abort',
        program: 'sleep 100',
        language: 'shell',
        earlyTimeoutMs: 50,
      });

      const result = abort('test-abort');
      expect(result).toContain('forcefully terminated');
      expect(getActiveJobs().has('test-abort')).toBe(false);
    });

    it('should handle abort of nonexistent task', () => {
      const result = abort('nonexistent');
      expect(result).toContain('No active task');
    });
  });

  describe('cleanupJob', () => {
    it('should clean up active job', async () => {
      await execute({
        sessionId: 'test-cleanup',
        program: 'sleep 100',
        language: 'shell',
        earlyTimeoutMs: 50,
      });

      expect(getActiveJobs().has('test-cleanup')).toBe(true);
      cleanupJob('test-cleanup');
      expect(getActiveJobs().has('test-cleanup')).toBe(false);
    });
  });

  describe('head/tail pipe stripping', () => {
    it('strips head -n from shell pipe', async () => {
      const result: ExecuteResult = await execute({
        sessionId: 'test-head-pipe',
        program: 'echo hello | head -n 1',
        language: 'shell',
      });

      expect(result.output).toBe('hello');
    });

    it('strips tail -n from shell pipe', async () => {
      const result: ExecuteResult = await execute({
        sessionId: 'test-tail-pipe',
        program: 'echo "line1\nline2\nline3" | tail -n 1',
        language: 'shell',
      });

      expect(result.output).toContain('line1');
      expect(result.output).toContain('line2');
      expect(result.output).toContain('line3');
    });

    it('strips both head and tail from multi-pipe', async () => {
      const result: ExecuteResult = await execute({
        sessionId: 'test-multi-pipe',
        program: 'echo hello | head -n 10 | tail -n 5',
        language: 'shell',
      });

      expect(result.output).toBe('hello');
    });

    it('does not strip head/tail from python program', async () => {
      const result: ExecuteResult = await execute({
        sessionId: 'test-python-no-strip',
        program: 'print("hello | head -n 1")',
        language: 'python',
      });

      expect(result.output).toContain('hello | head -n 1');
    });

    it('stripHeadTailPipes unit test', () => {
      const result = stripHeadTailPipes('cat file | head -n 50');
      expect(result.script).toBe('cat file');
    });
  });

  describe('createJavascriptPrelude', () => {
    it('emits a CJS require bridge, __dirname, __filename, and ends with a newline', () => {
      const cwd = '/tmp/example';
      const prelude = createJavascriptPrelude(cwd);
      expect(prelude).toContain('import { createRequire } from "node:module";');
      expect(prelude).toContain('const require = createRequire(');
      expect(prelude).toContain(`const __dirname = ${JSON.stringify(cwd)};`);
      expect(prelude).toContain(
        `const __filename = ${JSON.stringify(`${cwd}/__runner__.mjs`)};`,
      );
      expect(prelude.endsWith('\n')).toBe(true);
    });
  });

  describe('resolveJavascriptSpecifier', () => {
    it('resolves ./relative to a file:// URL using posix separators on POSIX', () => {
      const cwd = '/home/me/project';
      const result = resolveJavascriptSpecifier(cwd, './lib/util.js');
      if (process.platform !== 'win32') {
        const expected = pathToFileURL('/home/me/project/lib/util.js').href;
        expect(result).toBe(expected);
      } else {
        expect(result.startsWith('file:///')).toBe(true);
        expect(result).toContain('lib');
        expect(result).toContain('util.js');
      }
    });

    it('resolves ../relative to a file:// URL', () => {
      const cwd = '/home/me/project/sub';
      const result = resolveJavascriptSpecifier(cwd, '../sibling.mjs');
      if (process.platform !== 'win32') {
        const expected = pathToFileURL('/home/me/project/sibling.mjs').href;
        expect(result).toBe(expected);
      } else {
        expect(result.startsWith('file:///')).toBe(true);
        expect(result).toContain('sibling.mjs');
      }
    });

    it('preserves query strings and hash fragments', () => {
      const cwd = '/home/me/project';
      const result = resolveJavascriptSpecifier(cwd, './mod.mjs?t=1#frag');
      if (process.platform !== 'win32') {
        expect(result).toBe(
          `${pathToFileURL('/home/me/project/mod.mjs').href}?t=1#frag`,
        );
      } else {
        expect(result).toContain('mod.mjs');
        expect(result).toContain('?t=1#frag');
      }
    });

    it('leaves bare specifiers (no ./ or ../) untouched', () => {
      const cwd = '/home/me/project';
      expect(resolveJavascriptSpecifier(cwd, 'node:fs')).toBe('node:fs');
      expect(resolveJavascriptSpecifier(cwd, 'lodash')).toBe('lodash');
    });
  });

  describe('rewriteJavascriptModuleSpecifiers', () => {
    it('rewrites `from "./x"` to a file:// import', () => {
      const cwd = '/home/me/project';
      const out = rewriteJavascriptModuleSpecifiers(
        'import { foo } from "./foo.mjs";\n',
        cwd,
      );
      const fileHref = pathToFileURL('/home/me/project/foo.mjs').href;
      expect(out).toContain(`from "${fileHref}";`);
    });

    it('rewrites `export * from "../x"` to a file:// export', () => {
      const cwd = '/home/me/project/nested';
      const out = rewriteJavascriptModuleSpecifiers(
        'export * from "../sibling.mjs";\n',
        cwd,
      );
      const fileHref = pathToFileURL('/home/me/project/sibling.mjs').href;
      expect(out).toContain(`from "${fileHref}";`);
    });

    it('rewrites dynamic import("./x") to a file:// URL', () => {
      const cwd = '/home/me/project';
      const out = rewriteJavascriptModuleSpecifiers(
        'const m = await import("./mod.mjs");\n',
        cwd,
      );
      const fileHref = pathToFileURL('/home/me/project/mod.mjs').href;
      expect(out).toContain(`import("${fileHref}")`);
    });

    it('does not rewrite bare specifiers (e.g. node:fs, lodash)', () => {
      const cwd = '/home/me/project';
      const src = [
        'import fs from "node:fs";',
        'import lodash from "lodash";',
      ].join('\n');
      const out = rewriteJavascriptModuleSpecifiers(src, cwd);
      expect(out).toContain('import fs from "node:fs";');
      expect(out).toContain('import lodash from "lodash";');
    });

    it('does not rewrite non-string specifiers or unrelated `from` tokens', () => {
      const cwd = '/home/me/project';
      const out = rewriteJavascriptModuleSpecifiers(
        'const from = "literal";\nconst x = from;\n',
        cwd,
      );
      expect(out).toBe('const from = "literal";\nconst x = from;\n');
    });

    it('round-trips: rewritten pathToFileURL/fileURLToPath matches a real file', () => {
      const cwd = '/home/me/project';
      const out = rewriteJavascriptModuleSpecifiers(
        'import x from "./module.mjs";',
        cwd,
      );
      const match = /from "(file:\/\/[^"]+)"/.exec(out);
      expect(match).not.toBeNull();
      const path = fileURLToPath(match?.[1] as string);
      if (process.platform !== 'win32') {
        expect(path).toBe(posix.join('/home/me/project', 'module.mjs'));
      } else {
        expect(path.replace(/\\/g, '/')).toBe('/home/me/project/module.mjs');
      }
    });
  });
});
