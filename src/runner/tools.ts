import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripHeadTailPipes } from './no-head-tail.js';

export type RunnerLanguage = 'shell' | 'python' | 'javascript';

export interface ActiveJob {
  sessionId: string;
  childProcess: ChildProcess | null;
  stdoutFile: string;
  tempPath?: string;
  projectDir?: string;
  abortController: AbortController;
  bytesRead: number;
  status: 'running' | 'completed' | 'aborted';
  startTime: number;
  closePromise: Promise<void>;
}

const activeJobs = new Map<string, ActiveJob>();

const RUNNER_EARLY_TIMEOUT_MS = 5000;
const RUNNER_LOG_DIR = join(tmpdir(), 'omp-kunwei-runner');

function getRunnerLogPath(sessionId: string): string {
  mkdirSync(RUNNER_LOG_DIR, { recursive: true });
  return join(RUNNER_LOG_DIR, `runner-${sessionId}.log`);
}

function getRunnerProjectDir(sessionId: string): string {
  mkdirSync(RUNNER_LOG_DIR, { recursive: true });
  return join(RUNNER_LOG_DIR, `runner-${sessionId}`);
}

function getRunnerTempScriptPath(
  cwd: string,
  sessionId: string,
  extension: string,
): string {
  return join(cwd, `.runner-${sessionId}.${extension}`);
}

function killTree(childProcess: ChildProcess | null): void {
  if (!childProcess) return;
  const pid = childProcess.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
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
    try {
      job.abortController.abort();
    } catch {}
    killTree(job.childProcess);
    job.status = 'aborted';
  }

  try {
    if (existsSync(job.stdoutFile)) unlinkSync(job.stdoutFile);
  } catch {}

  if (job.tempPath && existsSync(job.tempPath)) {
    try {
      unlinkSync(job.tempPath);
    } catch {}
  }

  if (job.projectDir && existsSync(job.projectDir)) {
    try {
      rmSync(job.projectDir, { recursive: true, force: true });
    } catch {}
  }

  activeJobs.delete(sessionId);
}

function createTempShellScript(scriptPath: string, program: string): string {
  writeFileSync(scriptPath, program, 'utf-8');
  if (process.platform !== 'win32') chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function createTempPythonScript(scriptPath: string, program: string): string {
  writeFileSync(scriptPath, program, 'utf-8');
  return scriptPath;
}

function createTempJavascriptScript(
  scriptPath: string,
  program: string,
): string {
  writeFileSync(scriptPath, `${program}\n`, 'utf-8');
  return scriptPath;
}

export function createJavascriptPrelude(cwd: string): string {
  return [
    'import { createRequire } from "node:module";',
    `const require = createRequire(${JSON.stringify(join(cwd, '__runner__.cjs'))});`,
    `const __dirname = ${JSON.stringify(cwd)};`,
    `const __filename = ${JSON.stringify(join(cwd, '__runner__.mjs'))};`,
    '',
  ].join('\n');
}

export function resolveJavascriptSpecifier(
  cwd: string,
  specifier: string,
): string {
  const match = /^(\.{1,2}(?:\/[^?#]*)?)([?#].*)?$/.exec(specifier);
  if (!match) return specifier;
  return `${pathToFileURL(resolve(cwd, match[1])).href}${match[2] || ''}`;
}

export function rewriteJavascriptModuleSpecifiers(
  program: string,
  cwd: string,
): string {
  return program
    .replace(
      /\b(from\s*['"])(\.{1,2}\/[^'"]*)(['"])/g,
      (_match, prefix, specifier, suffix) =>
        `${prefix}${resolveJavascriptSpecifier(cwd, specifier)}${suffix}`,
    )
    .replace(
      /\b(export\s+\*\s+from\s*['"])(\.{1,2}\/[^'"]*)(['"])/g,
      (_match, prefix, specifier, suffix) =>
        `${prefix}${resolveJavascriptSpecifier(cwd, specifier)}${suffix}`,
    )
    .replace(
      /\b(import\s*\(\s*['"])(\.{1,2}\/[^'"]*)(['"]\s*\))/g,
      (_match, prefix, specifier, suffix) =>
        `${prefix}${resolveJavascriptSpecifier(cwd, specifier)}${suffix}`,
    );
}

interface ChildProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

function runChildProcess(
  options: ChildProcessOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    childProcess.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    childProcess.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const onAbort = () => killTree(childProcess);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    childProcess.on('error', (error) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    childProcess.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${stdout}${stderr}`.trim() ||
            `${options.command} exited with code ${code}`,
        ),
      );
    });
  });
}

async function ensureJavascriptProject(
  projectDir: string,
  dependencies: string[] | undefined,
): Promise<void> {
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'package.json'),
    '{"type":"module"}\n',
    'utf-8',
  );

  const requiredPackages = [...new Set(['tsx', ...(dependencies ?? [])])];
  if (requiredPackages.length === 0) return;

  await runChildProcess({
    command: 'npx',
    args: [
      '--yes',
      'npm@latest',
      'install',
      '--prefix',
      projectDir,
      ...requiredPackages,
    ],
    cwd: projectDir,
  });
}

interface ProgramRunner {
  onSpawn: (child: ChildProcess) => void;
  abortSignal: AbortSignal;
  onOutput: (chunk: string) => void;
}

function spawnRunnerProgram(
  runner: ProgramRunner,
  command: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number | undefined; cancelled: boolean }> {
  const childProcess = spawn(command, args, {
    cwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  runner.onSpawn(childProcess);
  childProcess.stdout?.on('data', (chunk) => runner.onOutput(chunk.toString()));
  childProcess.stderr?.on('data', (chunk) => runner.onOutput(chunk.toString()));

  const onAbort = () => killTree(childProcess);
  runner.abortSignal.addEventListener('abort', onAbort, { once: true });

  return new Promise((resolve, reject) => {
    childProcess.on('error', (error) => {
      runner.abortSignal.removeEventListener('abort', onAbort);
      reject(error);
    });
    childProcess.on('close', (code) => {
      runner.abortSignal.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code === null ? undefined : code,
        cancelled: runner.abortSignal.aborted,
      });
    });
  });
}

interface InternalExecuteOptions {
  program: string;
  language: RunnerLanguage;
  dependencies: string[] | undefined;
  cwd: string;
  projectDir?: string;
  runner: ProgramRunner;
}

async function executeShellProgram(
  options: InternalExecuteOptions,
  job: ActiveJob,
): Promise<{ exitCode: number | undefined; cancelled: boolean }> {
  const extension = process.platform === 'win32' ? 'ps1' : 'sh';
  const scriptPath = createTempShellScript(
    getRunnerTempScriptPath(options.cwd, job.sessionId, extension),
    options.program,
  );
  job.tempPath = scriptPath;

  return spawnRunnerProgram(
    options.runner,
    process.platform === 'win32' ? 'powershell.exe' : 'bash',
    process.platform === 'win32'
      ? ['-ExecutionPolicy', 'Bypass', '-File', scriptPath]
      : [scriptPath],
    options.cwd,
  );
}

async function executePythonProgram(
  options: InternalExecuteOptions,
  job: ActiveJob,
): Promise<{ exitCode: number | undefined; cancelled: boolean }> {
  const scriptPath = createTempPythonScript(
    getRunnerTempScriptPath(options.cwd, job.sessionId, 'py'),
    options.program,
  );
  job.tempPath = scriptPath;

  const args = ['--isolated'];
  for (const dependency of options.dependencies ?? []) {
    args.push('--with', dependency);
  }
  args.push('--from', 'python', 'python', scriptPath);

  return spawnRunnerProgram(options.runner, 'uvx', args, options.cwd);
}

async function executeJavascriptProgram(
  options: InternalExecuteOptions,
  job: ActiveJob,
  projectDir: string,
): Promise<{ exitCode: number | undefined; cancelled: boolean }> {
  await ensureJavascriptProject(projectDir, options.dependencies);
  const scriptBody = `${createJavascriptPrelude(options.cwd)}${rewriteJavascriptModuleSpecifiers(options.program, options.cwd)}`;
  const scriptPath = createTempJavascriptScript(
    getRunnerTempScriptPath(projectDir, job.sessionId, 'mts'),
    scriptBody,
  );
  job.tempPath = scriptPath;

  return spawnRunnerProgram(
    options.runner,
    'npx',
    ['--prefix', projectDir, '--yes', '--no-install', 'tsx', scriptPath],
    options.cwd,
  );
}

export interface ExecuteOptions {
  sessionId: string;
  program: string;
  language: RunnerLanguage;
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

export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
  const { sessionId, language, dependencies, earlyTimeoutMs } = options;
  let { program } = options;
  if (language === 'shell') program = stripHeadTailPipes(program).script;
  const timeoutMs = earlyTimeoutMs ?? RUNNER_EARLY_TIMEOUT_MS;
  const cwd = options.cwd ?? process.cwd();

  const existingJob = activeJobs.get(sessionId);
  if (existingJob?.status === 'running') {
    throw new Error(
      'A task is already running. Use wait() to check progress or abort() to terminate it first.',
    );
  }
  if (existingJob) {
    cleanupJob(sessionId);
  }

  const logPath = getRunnerLogPath(sessionId);
  const writeStream = createWriteStream(logPath, { flags: 'w' });

  const job: ActiveJob = {
    sessionId,
    childProcess: null,
    stdoutFile: logPath,
    abortController: new AbortController(),
    bytesRead: 0,
    status: 'running',
    startTime: Date.now(),
    closePromise: Promise.resolve(),
  };
  if (language === 'javascript' || language === 'python') {
    job.projectDir = getRunnerProjectDir(sessionId);
  }
  activeJobs.set(sessionId, job);

  const runner: ProgramRunner = {
    onSpawn: (child) => {
      job.childProcess = child;
    },
    abortSignal: job.abortController.signal,
    onOutput: (chunk) => {
      writeStream.write(chunk);
    },
  };

  let capturedError: unknown;
  const closePromise = (async () => {
    try {
      const internalOptions: InternalExecuteOptions = {
        program,
        language,
        dependencies,
        cwd,
        projectDir: job.projectDir,
        runner,
      };
      const result =
        language === 'shell'
          ? await executeShellProgram(internalOptions, job)
          : language === 'python'
            ? await executePythonProgram(internalOptions, job)
            : await executeJavascriptProgram(
                internalOptions,
                job,
                job.projectDir as string,
              );
      job.childProcess = null;
      if (job.status === 'running') {
        job.status = result.cancelled ? 'aborted' : 'completed';
      }
      if (result.exitCode !== undefined && result.exitCode !== 0) {
        writeStream.write(
          `\n[runner] Command exited with code ${result.exitCode}\n`,
        );
      }
    } catch (error) {
      if (job.status === 'running') job.status = 'aborted';
      writeStream.write(
        `\n[runner] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      capturedError = error;
    } finally {
      writeStream.end();
    }
  })();

  job.closePromise = closePromise;

  try {
    const isCompletedEarly = await Promise.race([
      closePromise.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), timeoutMs),
      ),
    ]);

    if (isCompletedEarly) {
      if (capturedError) {
        cleanupJob(sessionId);
        throw capturedError;
      }
      const fullOutput = existsSync(logPath)
        ? readFileSync(logPath, 'utf-8')
        : '';
      cleanupJob(sessionId);
      return {
        output: fullOutput.trim() || '(no output)',
        background: false,
        message: '[System] Task completed.',
      };
    }
  } catch (error: unknown) {
    if (error === capturedError) {
      throw error;
    }
    cleanupJob(sessionId);
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') {
      const executable =
        language === 'python'
          ? 'uvx'
          : language === 'javascript'
            ? 'npx'
            : process.platform === 'win32'
              ? 'powershell.exe'
              : 'bash';
      throw new Error(
        `Error: '${executable}' executable not found. ` +
          `Please ensure '${executable}' is installed and available on your PATH.`,
      );
    }
    throw error;
  }

  const partialOutput = existsSync(logPath)
    ? readFileSync(logPath, 'utf-8')
    : '';
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
    throw new Error(
      'No active job found. Use execute() to start a task first.',
    );
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
