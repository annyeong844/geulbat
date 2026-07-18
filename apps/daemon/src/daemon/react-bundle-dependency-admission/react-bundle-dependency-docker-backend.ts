import {
  runDockerClientCommand as runDockerCommand,
  type DockerClientCommandInvocation,
  type DockerClientCommandResult,
  type DockerClientCommandRunner,
} from '@geulbat/shared-utils/process-command';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReactBundleDependencyNetworkProbeCandidate } from './react-bundle-dependency-network-probe-candidate.js';

type DockerCommandResult = DockerClientCommandResult;

export type DockerCommandInvocation = DockerClientCommandInvocation;

type DockerCommandRunner = DockerClientCommandRunner;

export { runDockerCommand };

export interface DockerMetadataProbeCommandInvocation extends DockerCommandInvocation {
  writeOutput(relativePath: string, content: string): Promise<void>;
}

export type DockerMetadataProbeCommandRunner = (
  invocation: DockerMetadataProbeCommandInvocation,
) => Promise<DockerCommandResult>;

const DOCKER_METADATA_PROBE_ENTRYPOINT = `
const { readFileSync, writeFileSync } = require('node:fs');
const candidate = JSON.parse(readFileSync('/geulbat/input/candidate.json', 'utf8'));
writeFileSync(
  '/geulbat/output/candidate.json',
  JSON.stringify(candidate, null, 2) + '\\n',
  'utf8',
);
`;

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
  const availabilityStartedAtMs = Date.now();
  const versionTimeoutMs = initialDockerAvailabilityTimeoutMs(args.timeoutMs);
  if (versionTimeoutMs === null) {
    return dockerAvailabilityTimedOutResult('docker --version');
  }
  const versionResult = await runner({
    executable,
    args: ['--version'],
    timeoutMs: versionTimeoutMs,
    ...(args.signal ? { signal: args.signal } : {}),
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

  const imageTimeoutMs = remainingDockerAvailabilityTimeoutMs({
    timeoutMs: args.timeoutMs,
    availabilityStartedAtMs,
  });
  if (imageTimeoutMs === null) {
    return dockerAvailabilityTimedOutResult(
      `docker image inspect ${args.imageRef}`,
    );
  }
  const imageResult = await runner({
    executable,
    args: ['image', 'inspect', args.imageRef],
    timeoutMs: imageTimeoutMs,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  return (
    dockerUnavailableResult(
      imageResult,
      `docker image inspect ${args.imageRef}`,
    ) ?? imageResult
  );
}

function initialDockerAvailabilityTimeoutMs(timeoutMs: number): number | null {
  return timeoutMs > 0 ? timeoutMs : null;
}

function remainingDockerAvailabilityTimeoutMs(args: {
  timeoutMs: number;
  availabilityStartedAtMs: number;
}): number | null {
  const remainingMs =
    args.timeoutMs - (Date.now() - args.availabilityStartedAtMs);
  return remainingMs > 0 ? remainingMs : null;
}

function dockerAvailabilityTimedOutResult(
  commandLabel: string,
): DockerCommandResult {
  return {
    kind: 'timeout',
    stdout: '',
    stderr: `${commandLabel} did not start before the explicit timeout window elapsed`,
  };
}

export async function runDockerMetadataProbeProcess(args: {
  dockerPath?: string;
  imageRef: string;
  rootPath: string;
  outputDir: string;
  candidate: ReactBundleDependencyNetworkProbeCandidate;
  timeoutMs: number;
  signal?: AbortSignal;
  commandRunner?: DockerMetadataProbeCommandRunner;
  skipAvailabilityCheck?: boolean;
}): Promise<DockerCommandResult> {
  const executable = args.dockerPath ?? 'docker';
  const runner: DockerMetadataProbeCommandRunner =
    args.commandRunner ?? runDockerCommand;
  if (!args.skipAvailabilityCheck) {
    const availability = await checkDockerMetadataProbeBackendAvailable({
      timeoutMs: args.timeoutMs,
      imageRef: args.imageRef,
      ...(args.dockerPath ? { dockerPath: args.dockerPath } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      commandRunner: async (invocation) =>
        await runner({
          ...invocation,
          writeOutput: rejectDockerAvailabilityOutput,
        }),
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
    case 'output_limit_exceeded':
      return `${commandLabel} output exceeded buffer policy${formatDiagnosticsSuffix(result)}`;
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

function joinDiagnostics(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}
