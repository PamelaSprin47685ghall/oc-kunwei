import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWriteStream } from 'node:fs';

export interface ActiveJob {
  childProcess: ChildProcess;
  stdoutFile: string;
  tempScriptPath?: string;
  bytesRead: number;
  status: 'running' | 'completed' | 'aborted';
  startTime: number;
  closePromise: Promise<void>;
}

const activeJobs = new Map<string, ActiveJob>();

function getLogPath(sessionId: string): string {
  const dir = join(tmpdir(), 'opencode-runner');
  mkdirSync(dir, { recursive: true });
  return join(dir, `runner-${sessionId}.log`);
}

function killTree(childProcess: ChildProcess): void {
  const pid = childProcess.pid;
  if (!pid) return;

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
      });
    } else {
      spawn('kill', ['-9', `-${pid}`], { stdio: 'ignore' });
    }
  } catch {
    try {
      childProcess.kill('SIGKILL');
    } catch {}
  }
}

export function cleanupJob(sessionId: string): void {
  const job = activeJobs.get(sessionId);
  if (!job) return;

  if (job.status === 'running') {
    killTree(job.childProcess);
    job.status = 'aborted';
  }

  try {
    if (existsSync(job.stdoutFile)) {
      unlinkSync(job.stdoutFile);
    }
  } catch {}

  if (job.tempScriptPath && existsSync(job.tempScriptPath)) {
    try {
      unlinkSync(job.tempScriptPath);
    } catch {}
  }

  activeJobs.delete(sessionId);
}

function createTempScript(
  program: string,
  language: 'shell' | 'python',
): { path: string; interpreter: string; args: string[] } {
  const dir = join(tmpdir(), 'opencode-runner');
  mkdirSync(dir, { recursive: true });

  if (language === 'python') {
    const scriptPath = join(dir, `script-${randomUUID()}.py`);
    writeFileSync(scriptPath, program, 'utf-8');
    return {
      path: scriptPath,
      interpreter: 'python3',
      args: [scriptPath],
    };
  }

  const ext = process.platform === 'win32' ? 'ps1' : 'sh';
  const scriptPath = join(dir, `script-${randomUUID()}.${ext}`);
  writeFileSync(scriptPath, program, 'utf-8');

  if (process.platform === 'win32') {
    return {
      path: scriptPath,
      interpreter: 'powershell.exe',
      args: ['-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    };
  }

  chmodSync(scriptPath, 0o755);
  return {
    path: scriptPath,
    interpreter: 'bash',
    args: [scriptPath],
  };
}

export interface ExecuteOptions {
  sessionId: string;
  program: string;
  language: 'shell' | 'python';
  dependencies?: string[];
  earlyTimeoutMs?: number;
  cwd?: string;
}

export interface ExecuteResult {
  output: string;
  background: boolean;
  jobId?: string;
  message?: string;
}

export async function execute(
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const { sessionId, program, language, dependencies, earlyTimeoutMs } = options;
  const timeoutMs = earlyTimeoutMs ?? 5000;

  const existingJob = activeJobs.get(sessionId);
  if (existingJob?.status === 'running') {
    throw new Error(
      'A task is already running. Use wait() to check progress or abort() to terminate it first.',
    );
  }

  if (existingJob) {
    cleanupJob(sessionId);
  }

  const logPath = getLogPath(sessionId);
  const writeStream = createWriteStream(logPath, { flags: 'w' });

  let commandToRun: string;
  let args: string[];
  let tempScriptPath: string | undefined;

  if (language === 'python') {
    const uvArgs = ['run'];
    if (dependencies?.length) {
      for (const dep of dependencies) {
        uvArgs.push('--with', dep);
      }
    }

    const scriptPath = join(
      tmpdir(),
      'opencode-runner',
      `script-${randomUUID()}.py`,
    );
    writeFileSync(scriptPath, program, 'utf-8');
    tempScriptPath = scriptPath;
    args = [...uvArgs, scriptPath];
    commandToRun = 'uv';
  } else {
    const { path, interpreter } = createTempScript(program, 'shell');
    commandToRun = interpreter;
    args = [path];
  }

  const startTime = Date.now();
  let childProcess: ChildProcess;

  try {
    childProcess = spawn(commandToRun, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env },
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      const executable = language === 'python' ? 'uv' : commandToRun;
      throw new Error(
        `Error: '${executable}' executable not found. ` +
          `Please ensure '${executable}' is installed and available on your PATH.`,
      );
    }
    throw error;
  }

  let job: ActiveJob;

  const closePromise = new Promise<void>((resolve, reject) => {
    childProcess.on('close', () => {
      if (job.status === 'running') {
        job.status = 'completed';
      }
      writeStream.end();
      resolve();
    });
    childProcess.on('error', (err: NodeJS.ErrnoException) => {
      if (job.status === 'running') {
        job.status = 'aborted';
      }
      writeStream.end();
      reject(err);
    });
  });

  job = {
    childProcess,
    stdoutFile: logPath,
    tempScriptPath,
    bytesRead: 0,
    status: 'running',
    startTime,
    closePromise,
  };

  activeJobs.set(sessionId, job);

  childProcess.stdout?.pipe(writeStream);
  childProcess.stderr?.pipe(writeStream);

  try {
    const isCompletedEarly = await Promise.race([
      job.closePromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);

    if (isCompletedEarly) {
      const fullOutput = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
      cleanupJob(sessionId);
      return {
        output: fullOutput.trim() || '(no output)',
        background: false,
        message: '[System] Task completed within 5 seconds.',
      };
    }
  } catch (error: any) {
    cleanupJob(sessionId);
    if (error.code === 'ENOENT') {
      const executable = language === 'python' ? 'uv' : commandToRun;
      throw new Error(
        `Error: '${executable}' executable not found. ` +
          `Please ensure '${executable}' is installed and available on your PATH.`,
      );
    }
    throw error;
  }

  const partialOutput = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
  job.bytesRead = partialOutput.length;

  return {
    output: partialOutput.trim() || '(no output yet)',
    background: true,
    jobId: sessionId,
    message:
      '[System] Task has been backgrounded. Use wait() to check progress.\n' +
      '💡 Decision guide: If subsequent waits show no progress or repetitive output, ' +
      'the command may be stuck. Consider calling abort() to terminate.',
  };
}

export interface WaitOptions {
  sessionId: string;
  ms: number;
}

export interface WaitResult {
  output: string;
  completed: boolean;
  message?: string;
}

export async function wait(options: WaitOptions): Promise<WaitResult> {
  const { sessionId, ms } = options;

  const job = activeJobs.get(sessionId);
  if (!job) {
    throw new Error('No active job found. Use execute() to start a task first.');
  }

  if (job.status === 'completed' || job.status === 'aborted') {
    const fullOutput = readFileSync(job.stdoutFile, 'utf-8');
    const result: WaitResult = {
      output: fullOutput.substring(job.bytesRead).trim(),
      completed: true,
      message:
        job.status === 'completed'
          ? '[System] Task has completed.'
          : '[System] Task was aborted.',
    };
    cleanupJob(sessionId);
    return result;
  }

  await Promise.race([
    job.closePromise,
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);

  const fullOutput = readFileSync(job.stdoutFile, 'utf-8');
  const newOutput = fullOutput.substring(job.bytesRead).trim();
  job.bytesRead = fullOutput.length;

  if (job.status !== 'running') {
    cleanupJob(sessionId);
    return {
      output: newOutput || '(no new output)',
      completed: true,
      message:
        job.status === 'completed'
          ? '[System] Task has completed.'
          : '[System] Task was aborted.',
    };
  }

  if (!newOutput) {
    return {
      output: '',
      completed: false,
      message:
        '[System] Task still running. No new output during this wait.\n' +
        '⚠️ Risk warning: Output stream is silent. This strongly suggests the process may be hung ' +
        'or stuck in an infinite loop. Evaluate the last few lines of output carefully.\n' +
        'Unless you are sure it is doing heavy background computation, continued waiting is usually pointless. ' +
        'The wise choice is to call abort() and redesign a more robust command.',
    };
  }

  return {
    output: newOutput,
    completed: false,
    message: '[System] Task still running in background.',
  };
}

export function abort(sessionId: string): string {
  const job = activeJobs.get(sessionId);
  if (!job) {
    return 'No active task found to abort.';
  }

  cleanupJob(sessionId);
  return '[System] Task has been forcefully terminated.';
}

export function getSessionId(context: unknown): string {
  if (
    context &&
    typeof context === 'object' &&
    'sessionID' in context &&
    typeof (context as { sessionID: unknown }).sessionID === 'string'
  ) {
    return (context as { sessionID: string }).sessionID;
  }
  return randomUUID();
}

export function getActiveJobs(): Map<string, ActiveJob> {
  return activeJobs;
}
