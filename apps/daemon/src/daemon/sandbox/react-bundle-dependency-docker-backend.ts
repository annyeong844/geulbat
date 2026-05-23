import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReactBundleDependencyNetworkProbeCandidate } from './react-bundle-dependency-network-probe.js';

export type DockerCommandResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'cancelled'; stdout: string; stderr: string }
  | { kind: 'crash'; stdout: string; stderr: string };

export interface DockerCommandInvocation {
  executable: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  writeOutput(relativePath: string, content: string): Promise<void>;
}

export type DockerCommandRunner = (
  invocation: DockerCommandInvocation,
) => Promise<DockerCommandResult>;

export const DOCKER_METADATA_PROBE_ENTRYPOINT = `
const { readFileSync, writeFileSync } = require('node:fs');
const candidate = JSON.parse(readFileSync('/geulbat/input/candidate.json', 'utf8'));
writeFileSync(
  '/geulbat/output/candidate.json',
  JSON.stringify(candidate, null, 2) + '\\n',
  'utf8',
);
`;

const DOCKER_CLIENT_ENV_KEYS = [
  'DOCKER_API_VERSION',
  'DOCKER_CERT_PATH',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_BUILDKIT',
] as const;

export function buildDockerMetadataProbeRunArgs(args: {
  imageRef: string;
  inputDir: string;
  outputDir: string;
}): string[] {
  return [
    'run',
    '--rm',
    '--pull',
    'never',
    '--network',
    'none',
    '--read-only',
    '--cpus',
    '1',
    '--memory',
    '256m',
    '--pids-limit',
    '64',
    '-e',
    'GEULBAT_REACT_BUNDLE_DEPENDENCY_METADATA_PROBE=1',
    '-e',
    'GEULBAT_PROBE_NETWORK_POLICY=allowlisted_metadata_probe',
    '-e',
    'GEULBAT_CONTAINER_NETWORK_MODE=none',
    '-v',
    `${args.inputDir}:/geulbat/input:ro`,
    '-v',
    `${args.outputDir}:/geulbat/output`,
    args.imageRef,
    'node',
    '-e',
    DOCKER_METADATA_PROBE_ENTRYPOINT,
  ];
}

export async function checkDockerMetadataProbeBackendAvailable(args: {
  dockerPath?: string;
  imageRef?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  commandRunner?: DockerCommandRunner;
}): Promise<DockerCommandResult> {
  const executable = args.dockerPath ?? 'docker';
  const runner = args.commandRunner ?? runDockerCommand;
  const deadlineMs = Date.now() + args.timeoutMs;
  const versionResult = await runner({
    executable,
    args: ['--version'],
    timeoutMs: dockerAvailabilityTimeoutMs(deadlineMs),
    ...(args.signal ? { signal: args.signal } : {}),
    writeOutput: rejectDockerAvailabilityOutput,
  });
  const versionFailure = dockerUnavailableResult(
    versionResult,
    'docker --version',
  );
  if (versionFailure) {
    return versionFailure;
  }

  if (!args.imageRef) {
    return versionResult;
  }

  const imageResult = await runner({
    executable,
    args: ['image', 'inspect', args.imageRef],
    timeoutMs: dockerAvailabilityTimeoutMs(deadlineMs),
    ...(args.signal ? { signal: args.signal } : {}),
    writeOutput: rejectDockerAvailabilityOutput,
  });
  return (
    dockerUnavailableResult(
      imageResult,
      `docker image inspect ${args.imageRef}`,
    ) ?? imageResult
  );
}

function dockerAvailabilityTimeoutMs(deadlineMs: number): number {
  return Math.max(1, Math.min(deadlineMs - Date.now(), 5_000));
}

export async function runDockerMetadataProbeProcess(args: {
  dockerPath?: string;
  imageRef: string;
  rootPath: string;
  outputDir: string;
  candidate: ReactBundleDependencyNetworkProbeCandidate;
  timeoutMs: number;
  signal?: AbortSignal;
  commandRunner?: DockerCommandRunner;
  skipAvailabilityCheck?: boolean;
}): Promise<DockerCommandResult> {
  const executable = args.dockerPath ?? 'docker';
  const runner = args.commandRunner ?? runDockerCommand;
  if (!args.skipAvailabilityCheck) {
    const availability = await checkDockerMetadataProbeBackendAvailable({
      timeoutMs: args.timeoutMs,
      imageRef: args.imageRef,
      ...(args.dockerPath ? { dockerPath: args.dockerPath } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      commandRunner: runner,
    });
    if (availability.kind !== 'exit' || availability.exitCode !== 0) {
      return availability;
    }
  }

  const inputDir = join(args.rootPath, 'docker-input');
  await mkdir(inputDir, { recursive: true });
  await mkdir(args.outputDir, { recursive: true });
  await writeFile(
    join(inputDir, 'candidate.json'),
    JSON.stringify(args.candidate, null, 2) + '\n',
    'utf8',
  );

  return await runner({
    executable,
    args: buildDockerMetadataProbeRunArgs({
      imageRef: args.imageRef,
      inputDir,
      outputDir: args.outputDir,
    }),
    timeoutMs: args.timeoutMs,
    ...(args.signal ? { signal: args.signal } : {}),
    writeOutput: async (relativePath, content) => {
      if (relativePath !== 'candidate.json') {
        throw new Error(`unexpected docker output path: ${relativePath}`);
      }
      await mkdir(args.outputDir, { recursive: true });
      await writeFile(join(args.outputDir, 'candidate.json'), content, 'utf8');
    },
  });
}

async function rejectDockerAvailabilityOutput(
  relativePath: string,
  _content: string,
): Promise<void> {
  throw new Error(`unexpected docker output path: ${relativePath}`);
}

function dockerUnavailableResult(
  result: DockerCommandResult,
  commandLabel: string,
): DockerCommandResult | null {
  if (result.kind === 'exit' && result.exitCode === 0) {
    return null;
  }
  if (result.kind === 'timeout' || result.kind === 'cancelled') {
    return result;
  }
  return {
    kind: 'crash',
    stdout: result.stdout,
    stderr: `docker_unavailable: ${describeDockerUnavailable(
      result,
      commandLabel,
    )}`,
  };
}

function describeDockerUnavailable(
  result: DockerCommandResult,
  commandLabel: string,
): string {
  switch (result.kind) {
    case 'exit': {
      const diagnostics = joinDiagnostics(result.stdout, result.stderr);
      return diagnostics.length > 0
        ? diagnostics
        : `${commandLabel} exited ${result.exitCode}`;
    }
    case 'timeout':
      return `${commandLabel} timed out${formatDiagnosticsSuffix(result)}`;
    case 'cancelled':
      return `${commandLabel} cancelled${formatDiagnosticsSuffix(result)}`;
    case 'crash':
      return `${commandLabel} crashed${formatDiagnosticsSuffix(result)}`;
  }
}

function formatDiagnosticsSuffix(result: {
  stdout: string;
  stderr: string;
}): string {
  const diagnostics = joinDiagnostics(result.stdout, result.stderr);
  return diagnostics.length > 0 ? `: ${diagnostics}` : '';
}

export async function runDockerCommand(
  invocation: DockerCommandInvocation,
): Promise<DockerCommandResult> {
  if (invocation.signal?.aborted) {
    return {
      kind: 'cancelled',
      stdout: '',
      stderr: 'docker command cancelled',
    };
  }

  return new Promise((resolve) => {
    const child = spawn(invocation.executable, invocation.args, {
      env: buildDockerCommandEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingTermination: 'timeout' | 'cancelled' | null = null;

    const finish = (result: DockerCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      invocation.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const terminate = (kind: 'timeout' | 'cancelled'): void => {
      if (settled || pendingTermination) {
        return;
      }
      pendingTermination = kind;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 1_000);
      forceKillTimer.unref?.();
    };

    const timer = setTimeout(() => {
      terminate('timeout');
    }, invocation.timeoutMs);
    timer.unref?.();

    const onAbort = (): void => {
      terminate('cancelled');
    };

    invocation.signal?.addEventListener('abort', onAbort, { once: true });
    if (invocation.signal?.aborted) {
      terminate('cancelled');
    }

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
      if (pendingTermination) {
        finish({ kind: pendingTermination, stdout, stderr });
        return;
      }
      finish({ kind: 'exit', exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function buildDockerCommandEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    ...Object.fromEntries(
      DOCKER_CLIENT_ENV_KEYS.flatMap((key) => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  };
}

function joinDiagnostics(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}
