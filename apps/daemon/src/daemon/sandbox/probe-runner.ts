import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  SandboxAttemptSnapshot,
  SandboxAttemptStore,
  SandboxOutputRef,
  SandboxTerminalStatus,
} from './attempt-store.js';
import { createDisposableSandboxRoot } from './disposable-root.js';
import { buildSandboxEnvironment } from './environment.js';
import { importSandboxOutputEvidence } from './output-evidence-store.js';
import { collectSandboxOutputRef } from './output-validation.js';

type ProbeProcessResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'cancelled'; stdout: string; stderr: string }
  | { kind: 'crash'; stdout: string; stderr: string };

interface ProbeProcessRunnerArgs {
  cwd: string;
  outputDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  writeOutput(relativePath: string, content: string): Promise<void>;
}

type ProbeProcessRunner = (
  args: ProbeProcessRunnerArgs,
) => Promise<ProbeProcessResult>;

const PROBE_OUTPUT_MAX_FILES = 16;
const PROBE_OUTPUT_MAX_BYTES = 64 * 1024;

export async function runDeterministicSandboxProbe(args: {
  workspaceRoot: string;
  store: SandboxAttemptStore;
  timeoutMs: number;
  signal?: AbortSignal;
  processRunner?: ProbeProcessRunner;
}): Promise<SandboxAttemptSnapshot> {
  const attempt = args.store.createAttempt({
    jobKind: 'sandbox_probe',
    adapterKind: 'deterministic_probe',
  });
  let root: Awaited<ReturnType<typeof createDisposableSandboxRoot>> | null =
    null;

  try {
    root = await createDisposableSandboxRoot({
      attemptId: attempt.attemptId,
    });
    args.store.markRunning(attempt.attemptId, { rootPath: root.rootPath });

    const env = buildSandboxEnvironment({
      homeDir: root.homeDir,
      tempDir: root.tempDir,
      adapterEnv: { GEULBAT_SANDBOX_PROBE: '1' },
    });

    const processResult = await runProbeProcess({
      cwd: root.rootPath,
      outputDir: root.outputDir,
      env,
      timeoutMs: args.timeoutMs,
      ...(args.processRunner ? { processRunner: args.processRunner } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    const status = classifyProbeResult(processResult);
    let outputRef: SandboxOutputRef | null = null;
    if (status === 'succeeded') {
      const collectedOutput = await collectSandboxOutputRef(root.outputDir, {
        maxFiles: PROBE_OUTPUT_MAX_FILES,
        maxBytes: PROBE_OUTPUT_MAX_BYTES,
      });
      outputRef = await importSandboxOutputEvidence({
        workspaceRoot: args.workspaceRoot,
        attempt,
        collectedOutput,
      });
    }

    return args.store.markTerminal(attempt.attemptId, {
      status,
      exitCode: processResult.kind === 'exit' ? processResult.exitCode : null,
      diagnostics: joinDiagnostics(processResult.stdout, processResult.stderr),
      outputRef,
    })!;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return args.store.markTerminal(attempt.attemptId, {
      status: root === null ? 'failed' : 'crashed',
      diagnostics: root === null ? `sandbox_root_failed: ${message}` : message,
    })!;
  } finally {
    await root?.cleanup();
  }
}

async function runProbeProcess(args: {
  processRunner?: ProbeProcessRunner;
  cwd: string;
  outputDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ProbeProcessResult> {
  const writeOutput = async (
    relativePath: string,
    content: string,
  ): Promise<void> => {
    const targetPath = join(args.outputDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
  };

  return (args.processRunner ?? runDefaultProbeProcess)({
    cwd: args.cwd,
    outputDir: args.outputDir,
    env: args.env,
    timeoutMs: args.timeoutMs,
    ...(args.signal ? { signal: args.signal } : {}),
    writeOutput,
  });
}

function classifyProbeResult(
  result: ProbeProcessResult,
): SandboxTerminalStatus {
  switch (result.kind) {
    case 'exit':
      return result.exitCode === 0 ? 'succeeded' : 'failed';
    case 'timeout':
      return 'timed_out';
    case 'cancelled':
      return 'cancelled';
    case 'crash':
      return 'crashed';
  }
}

async function runDefaultProbeProcess(
  args: ProbeProcessRunnerArgs,
): Promise<ProbeProcessResult> {
  if (args.signal?.aborted) {
    return { kind: 'cancelled', stdout: '', stderr: 'probe cancelled' };
  }

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { writeFile } from 'node:fs/promises';
await writeFile(${JSON.stringify(
          join(args.outputDir, 'result.json'),
        )}, JSON.stringify({ ok: true }) + '\\n', 'utf8');
console.log('sandbox probe ok');`,
      ],
      {
        cwd: args.cwd,
        env: args.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: ProbeProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      args.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ kind: 'timeout', stdout, stderr });
    }, args.timeoutMs);
    timer.unref?.();

    const onAbort = (): void => {
      child.kill('SIGTERM');
      finish({ kind: 'cancelled', stdout, stderr });
    };

    args.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      finish({ kind: 'crash', stdout, stderr: error.message });
    });
    child.on('close', (exitCode) => {
      finish({ kind: 'exit', exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function joinDiagnostics(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}
