import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { stripHeadTailPipes } from './no-head-tail.js';
import {
  abort,
  cleanupJob,
  type ExecuteResult,
  execute,
  getActiveJobs,
  type WaitResult,
  wait,
} from './tools.js';

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
    it('should throw if no active job', async () => {
      try {
        await wait({ sessionId: 'nonexistent', ms: 1000 });
        expect(true).toBe(false);
      } catch (error) {
        expect((error as Error).message).toContain('No active job found');
      }
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
});
