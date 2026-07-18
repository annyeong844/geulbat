import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isPlainRecord } from '@geulbat/protocol/runtime-utils';
import {
  sha256StableJson,
  stableStringify,
} from '@geulbat/shared-utils/stable-json';
import type { ProcessCommandResult } from '@geulbat/shared-utils/process-command';
import {
  REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID,
  REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY,
  REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION,
  probeHttpMetadata,
  type HttpMetadataProbeRequestTransport,
  type HttpMetadataProbeResult,
} from '../network/http-metadata-probe.js';
import type {
  SandboxAttemptCapabilityProjection,
  SandboxAttemptStore,
  SandboxOutputRef,
  SandboxTerminalStatus,
} from '../sandbox/attempt-store.js';
import {
  sandboxRootFailureDiagnostics,
  withRunningSandboxAttemptRoot,
} from '../sandbox/attempt-root.js';
import { buildSandboxEnvironment } from '../sandbox/environment.js';
import { importSandboxOutputEvidence } from '../sandbox/output-evidence-store.js';
import { collectSandboxOutputRef } from '../sandbox/output-validation.js';
import {
  validateReactBundleDependencyPrepareRequest,
  type ReactBundleDependencyPrepareRequest,
  type ValidatedReactBundleDependencyPrepareRequest,
  type ValidatedReactBundleDependencyRef,
} from './react-bundle-dependency-prepare.js';
import type {
  ReactBundleDependencyNetworkProbeCandidate,
  ReactBundleDependencyProbeIdentity,
  ReactBundleDependencyProbeResult,
} from './react-bundle-dependency-network-probe-candidate.js';
import {
  checkDockerMetadataProbeBackendAvailable,
  runDockerMetadataProbeProcess,
  type DockerMetadataProbeCommandRunner,
} from './react-bundle-dependency-docker-backend.js';

const IN_PROCESS_METADATA_PROBE_BACKEND_POLICY_ID =
  'react_bundle_dependency_metadata_probe_in_process_v1';
const DOCKER_METADATA_PROBE_BACKEND_POLICY_ID =
  'react_bundle_dependency_metadata_probe_docker_v1';
const DOCKER_METADATA_PROBE_IMAGE_POLICY_ID =
  'react_bundle_dependency_metadata_probe_image_v1';
const DOCKER_METADATA_PROBE_FILESYSTEM_POLICY_ID =
  'react_bundle_dependency_metadata_probe_fs_v1';
const DOCKER_METADATA_PROBE_ALLOWLIST_ID = 'react_bundle_dependency_cdn_v1';
const DOCKER_METADATA_PROBE_CONTAINER_NETWORK_MODE = 'none';

type ReactBundleDependencyMetadataProbeBackend =
  | {
      kind: 'in_process_adapter';
    }
  | {
      kind: 'docker_worker';
      dockerPath?: string;
      imageRef: string;
    };

type ReactBundleDependencyMetadataProbeBackendSummary =
  | {
      kind: 'in_process_adapter';
      backendPolicyId: typeof IN_PROCESS_METADATA_PROBE_BACKEND_POLICY_ID;
    }
  | {
      kind: 'docker_worker';
      backendPolicyId: typeof DOCKER_METADATA_PROBE_BACKEND_POLICY_ID;
      imagePolicyId: typeof DOCKER_METADATA_PROBE_IMAGE_POLICY_ID;
      filesystemPolicyId: typeof DOCKER_METADATA_PROBE_FILESYSTEM_POLICY_ID;
      allowlistId: typeof DOCKER_METADATA_PROBE_ALLOWLIST_ID;
      containerNetworkMode: typeof DOCKER_METADATA_PROBE_CONTAINER_NETWORK_MODE;
      imageRef: string;
    };

type ReactBundleDependencyMetadataProbeCapabilityProjection = {
  schemaVersion: 1;
  capabilityId: 'react_bundle_dependency_metadata_probe';
  capabilityClass: 'candidate_generation';
  executionClass: 'in_process_adapter' | 'docker_worker';
  commitBehavior: 'not_applicable';
  policies:
    | {
        backendPolicyId: typeof IN_PROCESS_METADATA_PROBE_BACKEND_POLICY_ID;
        networkPolicy: typeof REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY;
        networkPolicyVersion: typeof REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION;
        allowlistId: typeof REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID;
      }
    | {
        backendPolicyId: typeof DOCKER_METADATA_PROBE_BACKEND_POLICY_ID;
        imagePolicyId: typeof DOCKER_METADATA_PROBE_IMAGE_POLICY_ID;
        filesystemPolicyId: typeof DOCKER_METADATA_PROBE_FILESYSTEM_POLICY_ID;
        networkPolicy: typeof REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY;
        networkPolicyVersion: typeof REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION;
        allowlistId: typeof REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID;
        containerNetworkMode: typeof DOCKER_METADATA_PROBE_CONTAINER_NETWORK_MODE;
      };
} & SandboxAttemptCapabilityProjection;

type SuccessfulHttpMetadataProbeResult = Extract<
  HttpMetadataProbeResult,
  { ok: true }
>;

type HttpMetadataProbeTimingBucket =
  SuccessfulHttpMetadataProbeResult['timingBucket'];

export type ReactBundleDependencyNetworkProbeSummaryProbe =
  ReactBundleDependencyProbeIdentity &
    (
      | {
          ok: true;
          requestedUrl: string;
          finalUrl: string;
          method: 'HEAD' | 'GET';
          status: number;
          contentType: string | null;
          contentLength: number | null;
          bytesRead: number;
          timingBucket: HttpMetadataProbeTimingBucket;
        }
      | {
          ok: false;
          requestedUrl: string;
          finalUrl?: string;
          method?: 'HEAD' | 'GET';
          status?: number;
          reasonCode: string;
        }
    );

export interface ReactBundleDependencyNetworkProbeSummary {
  ok: true;
  jobId: string;
  attemptId: string;
  evidenceRef: string;
  candidateHash: string;
  probeMode: 'metadata';
  networkPolicy: typeof REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY;
  networkPolicyVersion: typeof REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION;
  allowlistId: typeof REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID;
  backend: ReactBundleDependencyMetadataProbeBackendSummary;
  allRequiredProbesOk: boolean;
  dependencyCount: number;
  failedDependencyCount: number;
  dependencyProbes: ReactBundleDependencyNetworkProbeSummaryProbe[];
  finalUrls: string[];
  failures: Array<{
    requestedUrl: string;
    reasonCode: string;
    status?: number;
  }>;
}

type NetworkProbeProcessExitResult = Extract<
  ProcessCommandResult,
  { kind: 'exit' }
> & {
  expectedCandidateHash?: string;
};

type NetworkProbeProcessResult =
  | NetworkProbeProcessExitResult
  | Exclude<ProcessCommandResult, { kind: 'exit' }>;

interface NetworkProbeProcessRunnerArgs {
  outputDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now: () => string;
  signal?: AbortSignal;
  request: ValidatedReactBundleDependencyPrepareRequest;
  probeTransport?: HttpMetadataProbeRequestTransport;
  writeOutput(relativePath: string, content: string): Promise<void>;
}

type NetworkProbeProcessRunner = (
  args: NetworkProbeProcessRunnerArgs,
) => Promise<NetworkProbeProcessResult>;

const IN_PROCESS_METADATA_PROBE_BACKEND_SUMMARY: ReactBundleDependencyMetadataProbeBackendSummary =
  {
    kind: 'in_process_adapter',
    backendPolicyId: IN_PROCESS_METADATA_PROBE_BACKEND_POLICY_ID,
  };

export async function probeReactBundleExplicitCdnDependencies(args: {
  workspaceRoot: string;
  store: SandboxAttemptStore;
  request: ReactBundleDependencyPrepareRequest;
  timeoutMs?: number;
  now?: () => string;
  signal?: AbortSignal;
  probeTransport?: HttpMetadataProbeRequestTransport;
  processRunner?: NetworkProbeProcessRunner;
  backend?: ReactBundleDependencyMetadataProbeBackend;
  dockerCommandRunner?: DockerMetadataProbeCommandRunner;
}): Promise<ReactBundleDependencyNetworkProbeSummary> {
  const request = validateReactBundleDependencyPrepareRequest(args.request);
  const backend = normalizeMetadataProbeBackend(args.backend);
  const backendSummary = summarizeMetadataProbeBackend(backend);
  const attempt = args.store.createAttempt({
    jobKind: 'react_bundle_dependency_network_probe',
    adapterKind: 'react_bundle_dependency_metadata_probe',
    capability: projectMetadataProbeCapability(backendSummary),
  });

  return await withRunningSandboxAttemptRoot({
    attemptId: attempt.attemptId,
    store: args.store,
    onRootFailure: (message) => {
      args.store.markTerminal(attempt.attemptId, {
        status: 'failed',
        diagnostics: sandboxRootFailureDiagnostics(message),
      });
      throw new Error(
        `react bundle dependency metadata probe sandbox_root_failed: ${message}`,
      );
    },
    run: async (root) => {
      const env = buildSandboxEnvironment({
        homeDir: root.homeDir,
        tempDir: root.tempDir,
        adapterEnv: {
          GEULBAT_REACT_BUNDLE_DEPENDENCY_METADATA_PROBE: '1',
          GEULBAT_SANDBOX_NETWORK_POLICY:
            REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY,
        },
      });

      const processResult = await runNetworkProbeProcess({
        rootPath: root.rootPath,
        outputDir: root.outputDir,
        env,
        now: args.now ?? (() => new Date().toISOString()),
        request,
        backend,
        ...(args.timeoutMs !== undefined
          ? { timeoutMs: args.timeoutMs, timeoutStartedAtMs: Date.now() }
          : {}),
        ...(args.signal ? { signal: args.signal } : {}),
        ...(args.probeTransport ? { probeTransport: args.probeTransport } : {}),
        ...(args.processRunner ? { processRunner: args.processRunner } : {}),
        ...(args.dockerCommandRunner
          ? { dockerCommandRunner: args.dockerCommandRunner }
          : {}),
      });
      const status = classifyNetworkProbeResult(processResult);
      if (status !== 'succeeded' || processResult.kind !== 'exit') {
        const diagnostics = joinDiagnostics(
          processResult.stdout,
          processResult.stderr,
        );
        args.store.markTerminal(attempt.attemptId, {
          status,
          exitCode:
            processResult.kind === 'exit' ? processResult.exitCode : null,
          diagnostics,
        });
        throw new Error(
          `react bundle dependency metadata probe failed: ${status}${
            diagnostics ? `: ${diagnostics}` : ''
          }`,
        );
      }

      return await importNetworkProbeOutput({
        workspaceRoot: args.workspaceRoot,
        store: args.store,
        attemptId: attempt.attemptId,
        request,
        backendSummary,
        processResult,
        outputDir: root.outputDir,
      });
    },
  });
}

async function runNetworkProbeProcess(args: {
  processRunner?: NetworkProbeProcessRunner;
  rootPath: string;
  outputDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  timeoutStartedAtMs?: number;
  now: () => string;
  signal?: AbortSignal;
  request: ValidatedReactBundleDependencyPrepareRequest;
  backend: ReactBundleDependencyMetadataProbeBackend;
  dockerCommandRunner?: DockerMetadataProbeCommandRunner;
  probeTransport?: HttpMetadataProbeRequestTransport;
}): Promise<NetworkProbeProcessResult> {
  const writeOutput = async (
    relativePath: string,
    content: string,
  ): Promise<void> => {
    const targetPath = join(args.outputDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
  };

  if (args.backend.kind === 'docker_worker') {
    if (args.timeoutMs === undefined) {
      return missingDockerTimeoutResult();
    }
    const timeoutContext = {
      timeoutMs: args.timeoutMs,
      ...(args.timeoutStartedAtMs !== undefined
        ? { timeoutStartedAtMs: args.timeoutStartedAtMs }
        : {}),
    };
    const dockerCommandRunner = args.dockerCommandRunner;
    const availabilityTimeoutMs = remainingAttemptTimeoutMs(timeoutContext);
    if (availabilityTimeoutMs <= 0) {
      return timeoutResult();
    }
    const availability = await checkDockerMetadataProbeBackendAvailable({
      timeoutMs: availabilityTimeoutMs,
      imageRef: args.backend.imageRef,
      ...(args.backend.dockerPath
        ? { dockerPath: args.backend.dockerPath }
        : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      ...(dockerCommandRunner
        ? {
            commandRunner: async (invocation) =>
              await dockerCommandRunner({
                ...invocation,
                writeOutput: rejectDockerAvailabilityOutput,
              }),
          }
        : {}),
    });
    if (availability.kind !== 'exit' || availability.exitCode !== 0) {
      return availability;
    }

    const probeTimeoutMs = remainingAttemptTimeoutMs(timeoutContext);
    if (probeTimeoutMs <= 0) {
      return timeoutResult();
    }
    const candidate = await buildCandidate({
      request: args.request,
      now: args.now,
      timeoutMs: probeTimeoutMs,
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.probeTransport ? { probeTransport: args.probeTransport } : {}),
    });
    const expectedCandidateHash = sha256StableJson(candidate);

    const dockerRunTimeoutMs = remainingAttemptTimeoutMs(timeoutContext);
    if (dockerRunTimeoutMs <= 0) {
      return timeoutResult();
    }
    const dockerResult = await runDockerMetadataProbeProcess({
      imageRef: args.backend.imageRef,
      rootPath: args.rootPath,
      outputDir: args.outputDir,
      candidate,
      timeoutMs: dockerRunTimeoutMs,
      skipAvailabilityCheck: true,
      ...(args.backend.dockerPath
        ? { dockerPath: args.backend.dockerPath }
        : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.dockerCommandRunner
        ? { commandRunner: args.dockerCommandRunner }
        : {}),
    });
    return dockerResult.kind === 'exit'
      ? { ...dockerResult, expectedCandidateHash }
      : dockerResult;
  }

  return (args.processRunner ?? runDefaultNetworkProbeProcess)({
    outputDir: args.outputDir,
    env: args.env,
    now: args.now,
    request: args.request,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.probeTransport ? { probeTransport: args.probeTransport } : {}),
    writeOutput,
  });
}

async function runDefaultNetworkProbeProcess(
  args: NetworkProbeProcessRunnerArgs,
): Promise<NetworkProbeProcessResult> {
  if (args.signal?.aborted) {
    return {
      kind: 'cancelled',
      stdout: '',
      stderr: 'dependency metadata probe cancelled',
    };
  }

  const candidate = await buildCandidate({
    request: args.request,
    now: args.now,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.probeTransport ? { probeTransport: args.probeTransport } : {}),
  });
  await args.writeOutput(
    'candidate.json',
    JSON.stringify(candidate, null, 2) + '\n',
  );
  return {
    kind: 'exit',
    exitCode: 0,
    stdout: 'react bundle dependency metadata probe ok',
    stderr: '',
    expectedCandidateHash: sha256StableJson(candidate),
  };
}

async function rejectDockerAvailabilityOutput(
  relativePath: string,
  _content: string,
): Promise<void> {
  throw new Error(`unexpected docker output path: ${relativePath}`);
}

async function buildCandidate(args: {
  request: ValidatedReactBundleDependencyPrepareRequest;
  now: () => string;
  timeoutMs?: number;
  signal?: AbortSignal;
  probeTransport?: HttpMetadataProbeRequestTransport;
}): Promise<ReactBundleDependencyNetworkProbeCandidate> {
  const dependencyProbes = await Promise.all(
    args.request.dependencyRefs.map(async (dependency) => ({
      ...probeIdentity(dependency),
      ...(await probeHttpMetadata({
        url: dependency.url,
        ...(args.timeoutMs !== undefined
          ? { totalTimeoutMs: args.timeoutMs }
          : {}),
        ...(args.signal ? { signal: args.signal } : {}),
        ...(args.probeTransport ? { transport: args.probeTransport } : {}),
      })),
    })),
  );

  return {
    schemaVersion: 1,
    adapterKind: 'react_bundle_dependency_metadata_probe',
    inputHash: args.request.inputHash,
    probeMode: 'metadata',
    networkPolicy: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY,
    networkPolicyVersion: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION,
    allowlistId: REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID,
    generatedAt: args.now(),
    dependencyProbes,
    failures: projectFailures(dependencyProbes),
  };
}

function probeIdentity(
  dependency: ValidatedReactBundleDependencyRef,
): ReactBundleDependencyProbeIdentity {
  return {
    kind: dependency.kind,
    ...(dependency.specifier ? { specifier: dependency.specifier } : {}),
    ...(dependency.packageName ? { packageName: dependency.packageName } : {}),
    ...(dependency.version ? { version: dependency.version } : {}),
    requestedUrl: dependency.url,
  };
}

function classifyNetworkProbeResult(
  result: NetworkProbeProcessResult,
): SandboxTerminalStatus {
  switch (result.kind) {
    case 'exit':
      return result.exitCode === 0 ? 'succeeded' : 'failed';
    case 'timeout':
      return 'timed_out';
    case 'cancelled':
      return 'cancelled';
    case 'output_limit_exceeded':
      return 'crashed';
    case 'crash':
      return 'crashed';
  }
}

async function importNetworkProbeOutput(args: {
  workspaceRoot: string;
  store: SandboxAttemptStore;
  attemptId: string;
  request: ValidatedReactBundleDependencyPrepareRequest;
  backendSummary: ReactBundleDependencyMetadataProbeBackendSummary;
  processResult: Extract<NetworkProbeProcessResult, { kind: 'exit' }>;
  outputDir: string;
}): Promise<ReactBundleDependencyNetworkProbeSummary> {
  const current = args.store.getAttempt(args.attemptId);
  if (!current) {
    throw new Error(`sandbox attempt not found: ${args.attemptId}`);
  }

  let collectedOutput: Awaited<ReturnType<typeof collectSandboxOutputRef>>;
  try {
    collectedOutput = await collectSandboxOutputRef(args.outputDir);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    args.store.markTerminal(args.attemptId, {
      status: 'failed',
      exitCode: args.processResult.exitCode,
      diagnostics: `output_collection_failed: ${message}`,
    });
    throw new Error(
      `react bundle dependency metadata probe output_collection_failed: ${message}`,
    );
  }
  let outputRef: SandboxOutputRef;
  try {
    outputRef = await importSandboxOutputEvidence({
      workspaceRoot: args.workspaceRoot,
      attempt: current,
      collectedOutput,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    args.store.markTerminal(args.attemptId, {
      status: 'failed',
      exitCode: args.processResult.exitCode,
      diagnostics: `evidence_import_failed: ${message}`,
    });
    throw new Error(
      `react bundle dependency metadata probe evidence_import_failed: ${message}`,
    );
  }

  let candidate: ReactBundleDependencyNetworkProbeCandidate;
  try {
    candidate = await readAndValidateCandidate({
      outputRef,
      request: args.request,
      ...(args.processResult.expectedCandidateHash
        ? { expectedCandidateHash: args.processResult.expectedCandidateHash }
        : {}),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    args.store.markTerminal(args.attemptId, {
      status: 'failed',
      exitCode: args.processResult.exitCode,
      diagnostics: `candidate_validation_failed: ${message}; evidenceRef=${outputRef.evidenceRef}`,
    });
    throw error;
  }

  if (candidate.failures.length > 0) {
    args.store.markTerminal(args.attemptId, {
      status: 'failed',
      exitCode: args.processResult.exitCode,
      diagnostics: `dependency_probe_policy_failed: ${candidate.failures.length} probe(s) failed; evidenceRef=${outputRef.evidenceRef}`,
    });
    throw new Error(
      'react bundle dependency metadata probe dependency_probe_policy_failed',
    );
  }

  const summary = toSummary({
    attempt: current,
    outputRef,
    candidate,
    backendSummary: args.backendSummary,
  });
  args.store.markTerminal(args.attemptId, {
    status: 'succeeded',
    exitCode: args.processResult.exitCode,
    diagnostics: joinDiagnostics(
      args.processResult.stdout,
      args.processResult.stderr,
    ),
    outputRef,
  });
  return summary;
}

function isHttpMetadataProbeResult(
  value: unknown,
): value is HttpMetadataProbeResult {
  if (!isPlainRecord(value) || typeof value['requestedUrl'] !== 'string') {
    return false;
  }

  const policy = value['policy'];
  if (
    !isPlainRecord(policy) ||
    policy['name'] !== REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY ||
    policy['version'] !== REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION ||
    policy['allowlistId'] !== REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID
  ) {
    return false;
  }

  const redirectChain = value['redirectChain'];
  if (
    !Array.isArray(redirectChain) ||
    !redirectChain.every(
      (redirect: unknown) =>
        isPlainRecord(redirect) &&
        typeof redirect['fromUrl'] === 'string' &&
        typeof redirect['toUrl'] === 'string' &&
        typeof redirect['status'] === 'number',
    )
  ) {
    return false;
  }

  const method = value['method'];
  const validMethod = method === 'HEAD' || method === 'GET';
  const timingBucket = value['timingBucket'];
  const validTimingBucket =
    timingBucket === 'lt_100ms' ||
    timingBucket === 'lt_500ms' ||
    timingBucket === 'lt_2s' ||
    timingBucket === 'gte_2s';
  const contentType = value['contentType'];
  const contentLength = value['contentLength'];

  if (value['ok'] === true) {
    return (
      typeof value['finalUrl'] === 'string' &&
      validMethod &&
      typeof value['status'] === 'number' &&
      (contentType === null || typeof contentType === 'string') &&
      (contentLength === null || typeof contentLength === 'number') &&
      typeof value['bytesRead'] === 'number' &&
      validTimingBucket
    );
  }
  if (value['ok'] !== false) {
    return false;
  }

  const reasonCode = value['reasonCode'];
  const validReasonCode =
    reasonCode === 'invalid_url' ||
    reasonCode === 'unsupported_scheme' ||
    reasonCode === 'disallowed_origin' ||
    reasonCode === 'unsafe_url' ||
    reasonCode === 'unsafe_redirect' ||
    reasonCode === 'dns_blocked' ||
    reasonCode === 'http_status' ||
    reasonCode === 'timeout' ||
    reasonCode === 'network_error';
  return (
    (value['finalUrl'] === undefined ||
      typeof value['finalUrl'] === 'string') &&
    (method === undefined || validMethod) &&
    (value['status'] === undefined || typeof value['status'] === 'number') &&
    (contentType === undefined ||
      contentType === null ||
      typeof contentType === 'string') &&
    (contentLength === undefined ||
      contentLength === null ||
      typeof contentLength === 'number') &&
    (value['bytesRead'] === undefined ||
      typeof value['bytesRead'] === 'number') &&
    (timingBucket === undefined || validTimingBucket) &&
    validReasonCode &&
    typeof value['message'] === 'string'
  );
}

async function readAndValidateCandidate(args: {
  outputRef: SandboxOutputRef;
  request: ValidatedReactBundleDependencyPrepareRequest;
  expectedCandidateHash?: string;
}): Promise<ReactBundleDependencyNetworkProbeCandidate> {
  const candidateText = await readFile(
    join(args.outputRef.rootPath, 'candidate.json'),
    'utf8',
  );
  const candidate: unknown = JSON.parse(candidateText);
  if (!isPlainRecord(candidate)) {
    throw new Error('candidate must be an object');
  }
  if (candidate['schemaVersion'] !== 1) {
    throw new Error('candidate schemaVersion must be 1');
  }
  if (candidate['adapterKind'] !== 'react_bundle_dependency_metadata_probe') {
    throw new Error('candidate adapterKind mismatch');
  }
  if (candidate['inputHash'] !== args.request.inputHash) {
    throw new Error('candidate input hash mismatch');
  }
  if (candidate['networkPolicy'] !== REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY) {
    throw new Error('candidate networkPolicy mismatch');
  }
  if (
    candidate['networkPolicyVersion'] !==
    REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION
  ) {
    throw new Error('candidate networkPolicyVersion mismatch');
  }
  if (candidate['allowlistId'] !== REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID) {
    throw new Error('candidate allowlistId mismatch');
  }
  if (candidate['probeMode'] !== 'metadata') {
    throw new Error('candidate probeMode mismatch');
  }
  const generatedAt = candidate['generatedAt'];
  if (typeof generatedAt !== 'string') {
    throw new Error('candidate generatedAt must be a string');
  }
  if (
    args.expectedCandidateHash &&
    sha256StableJson(candidate) !== args.expectedCandidateHash
  ) {
    throw new Error('candidate content hash mismatch');
  }
  const rawDependencyProbes = candidate['dependencyProbes'];
  if (!Array.isArray(rawDependencyProbes)) {
    throw new Error('candidate dependencyProbes must be an array');
  }
  const dependencyProbeValues: unknown[] = rawDependencyProbes;
  if (dependencyProbeValues.length !== args.request.dependencyRefs.length) {
    throw new Error('candidate dependency probe count mismatch');
  }
  const dependencyProbes: ReactBundleDependencyProbeResult[] = [];
  for (const [index, expected] of args.request.dependencyRefs.entries()) {
    const actual = dependencyProbeValues[index];
    if (!isPlainRecord(actual)) {
      throw new Error('candidate dependency probe missing');
    }
    if (actual['kind'] !== expected.kind) {
      throw new Error('candidate dependency probe kind mismatch');
    }
    if (actual['requestedUrl'] !== expected.url) {
      throw new Error('candidate dependency probe requestedUrl mismatch');
    }
    if (actual['specifier'] !== expected.specifier) {
      throw new Error('candidate dependency probe specifier mismatch');
    }
    if (actual['packageName'] !== expected.packageName) {
      throw new Error('candidate dependency probe packageName mismatch');
    }
    if (actual['version'] !== expected.version) {
      throw new Error('candidate dependency probe version mismatch');
    }
    if (!isHttpMetadataProbeResult(actual)) {
      throw new Error(
        `candidate dependency probe result mismatch at index ${index}`,
      );
    }
    const validatedProbe: ReactBundleDependencyProbeResult = {
      ...actual,
      ...probeIdentity(expected),
    };
    dependencyProbes.push(validatedProbe);
  }

  const rawFailures = candidate['failures'];
  if (!Array.isArray(rawFailures)) {
    throw new Error('candidate failures must be an array');
  }
  const failureValues: unknown[] = rawFailures;
  const failures: ReactBundleDependencyNetworkProbeCandidate['failures'] = [];
  for (const failure of failureValues) {
    if (!isReactBundleDependencyProbeFailure(failure)) {
      throw new Error('candidate failure shape mismatch');
    }
    failures.push(failure);
  }

  const expectedFailures = projectFailures(dependencyProbes);
  if (stableStringify(failures) !== stableStringify(expectedFailures)) {
    throw new Error('candidate failures projection mismatch');
  }
  return {
    ...candidate,
    schemaVersion: 1,
    adapterKind: 'react_bundle_dependency_metadata_probe',
    inputHash: args.request.inputHash,
    probeMode: 'metadata',
    networkPolicy: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY,
    networkPolicyVersion: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION,
    allowlistId: REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID,
    generatedAt,
    dependencyProbes,
    failures,
  };
}

function toSummary(args: {
  attempt: { jobId: string; attemptId: string };
  outputRef: SandboxOutputRef;
  candidate: ReactBundleDependencyNetworkProbeCandidate;
  backendSummary: ReactBundleDependencyMetadataProbeBackendSummary;
}): ReactBundleDependencyNetworkProbeSummary {
  return {
    ok: true,
    jobId: args.attempt.jobId,
    attemptId: args.attempt.attemptId,
    evidenceRef: args.outputRef.evidenceRef,
    candidateHash: sha256StableJson(args.candidate),
    probeMode: 'metadata',
    networkPolicy: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY,
    networkPolicyVersion: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION,
    allowlistId: REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID,
    backend: args.backendSummary,
    allRequiredProbesOk: args.candidate.failures.length === 0,
    dependencyCount: args.candidate.dependencyProbes.length,
    failedDependencyCount: args.candidate.failures.length,
    dependencyProbes: args.candidate.dependencyProbes.map(projectSummaryProbe),
    finalUrls: args.candidate.dependencyProbes.flatMap((probe) =>
      probe.ok ? [probe.finalUrl] : [],
    ),
    failures: args.candidate.failures,
  };
}

function projectSummaryProbe(
  probe: ReactBundleDependencyProbeResult,
): ReactBundleDependencyNetworkProbeSummaryProbe {
  if (probe.ok) {
    return {
      kind: probe.kind,
      ...(probe.specifier ? { specifier: probe.specifier } : {}),
      ...(probe.packageName ? { packageName: probe.packageName } : {}),
      ...(probe.version ? { version: probe.version } : {}),
      ok: true,
      requestedUrl: probe.requestedUrl,
      finalUrl: probe.finalUrl,
      method: probe.method,
      status: probe.status,
      contentType: probe.contentType,
      contentLength: probe.contentLength,
      bytesRead: probe.bytesRead,
      timingBucket: probe.timingBucket,
    };
  }

  return {
    kind: probe.kind,
    ...(probe.specifier ? { specifier: probe.specifier } : {}),
    ...(probe.packageName ? { packageName: probe.packageName } : {}),
    ...(probe.version ? { version: probe.version } : {}),
    ok: false,
    requestedUrl: probe.requestedUrl,
    ...(probe.finalUrl ? { finalUrl: probe.finalUrl } : {}),
    ...(probe.method ? { method: probe.method } : {}),
    ...(probe.status !== undefined ? { status: probe.status } : {}),
    reasonCode: probe.reasonCode,
  };
}

function normalizeMetadataProbeBackend(
  backend?: ReactBundleDependencyMetadataProbeBackend,
): ReactBundleDependencyMetadataProbeBackend {
  if (!backend) {
    return {
      kind: 'in_process_adapter',
    };
  }
  if (backend.kind === 'in_process_adapter') {
    return {
      kind: 'in_process_adapter',
    };
  }
  if (backend.kind !== 'docker_worker') {
    throw new Error(
      'unsupported react bundle dependency metadata probe backend',
    );
  }
  if (backend.imageRef.trim().length === 0) {
    throw new Error('docker metadata probe backend imageRef is required');
  }

  return {
    kind: 'docker_worker',
    imageRef: backend.imageRef,
    ...(backend.dockerPath ? { dockerPath: backend.dockerPath } : {}),
  };
}

function remainingAttemptTimeoutMs(args: {
  timeoutMs: number;
  timeoutStartedAtMs?: number;
}): number {
  if (args.timeoutStartedAtMs === undefined) {
    return args.timeoutMs;
  }
  return args.timeoutMs - (Date.now() - args.timeoutStartedAtMs);
}

function missingDockerTimeoutResult(): NetworkProbeProcessResult {
  return {
    kind: 'crash',
    stdout: '',
    stderr:
      'react bundle dependency metadata docker probe requires explicit timeoutMs',
  };
}

function timeoutResult(): NetworkProbeProcessResult {
  return {
    kind: 'timeout',
    stdout: '',
    stderr: 'react bundle dependency metadata probe timeout',
  };
}

function summarizeMetadataProbeBackend(
  backend: ReactBundleDependencyMetadataProbeBackend,
): ReactBundleDependencyMetadataProbeBackendSummary {
  if (backend.kind === 'in_process_adapter') {
    return IN_PROCESS_METADATA_PROBE_BACKEND_SUMMARY;
  }

  return {
    kind: 'docker_worker',
    backendPolicyId: DOCKER_METADATA_PROBE_BACKEND_POLICY_ID,
    imagePolicyId: DOCKER_METADATA_PROBE_IMAGE_POLICY_ID,
    filesystemPolicyId: DOCKER_METADATA_PROBE_FILESYSTEM_POLICY_ID,
    allowlistId: DOCKER_METADATA_PROBE_ALLOWLIST_ID,
    containerNetworkMode: DOCKER_METADATA_PROBE_CONTAINER_NETWORK_MODE,
    imageRef: backend.imageRef,
  };
}

function projectMetadataProbeCapability(
  backend: ReactBundleDependencyMetadataProbeBackendSummary,
): ReactBundleDependencyMetadataProbeCapabilityProjection {
  const base = {
    schemaVersion: 1,
    capabilityId: 'react_bundle_dependency_metadata_probe',
    capabilityClass: 'candidate_generation',
    commitBehavior: 'not_applicable',
  } as const;

  if (backend.kind === 'in_process_adapter') {
    return {
      ...base,
      executionClass: 'in_process_adapter',
      policies: {
        backendPolicyId: backend.backendPolicyId,
        networkPolicy: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY,
        networkPolicyVersion: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION,
        allowlistId: REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID,
      },
    };
  }

  return {
    ...base,
    executionClass: 'docker_worker',
    policies: {
      backendPolicyId: backend.backendPolicyId,
      imagePolicyId: backend.imagePolicyId,
      filesystemPolicyId: backend.filesystemPolicyId,
      networkPolicy: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY,
      networkPolicyVersion: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION,
      allowlistId: backend.allowlistId,
      containerNetworkMode: backend.containerNetworkMode,
    },
  };
}

function projectFailures(
  dependencyProbes: readonly ReactBundleDependencyProbeResult[],
): ReactBundleDependencyNetworkProbeCandidate['failures'] {
  return dependencyProbes.filter(isFailedProbe).map((probe) => ({
    requestedUrl: probe.requestedUrl,
    reasonCode: probe.reasonCode,
    ...(probe.status !== undefined ? { status: probe.status } : {}),
  }));
}

function isReactBundleDependencyProbeFailure(
  value: unknown,
): value is ReactBundleDependencyNetworkProbeCandidate['failures'][number] {
  return (
    isPlainRecord(value) &&
    typeof value['requestedUrl'] === 'string' &&
    typeof value['reasonCode'] === 'string' &&
    (value['status'] === undefined || typeof value['status'] === 'number')
  );
}

function isFailedProbe(
  probe: ReactBundleDependencyProbeResult,
): probe is ReactBundleDependencyProbeIdentity &
  Extract<HttpMetadataProbeResult, { ok: false }> {
  return !probe.ok;
}

function joinDiagnostics(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}
