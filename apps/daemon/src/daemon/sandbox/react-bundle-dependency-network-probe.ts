import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID,
  REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY,
  REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION,
  probeHttpMetadata,
  type HttpMetadataProbeRequestTransport,
  type HttpMetadataProbeResult,
} from '../network/http-metadata-probe.js';
import type {
  SandboxAttemptStore,
  SandboxOutputRef,
  SandboxTerminalStatus,
} from './attempt-store.js';
import { createDisposableSandboxRoot } from './disposable-root.js';
import { buildSandboxEnvironment } from './environment.js';
import { importSandboxOutputEvidence } from './output-evidence-store.js';
import { collectSandboxOutputRef } from './output-validation.js';
import {
  validateReactBundleDependencyPrepareRequest,
  type ReactBundleDependencyPrepareRequest,
  type ValidatedReactBundleDependencyPrepareRequest,
  type ValidatedReactBundleDependencyRef,
} from './react-bundle-dependency-prepare.js';

const NETWORK_PROBE_OUTPUT_MAX_FILES = 8;
const NETWORK_PROBE_OUTPUT_MAX_BYTES = 128 * 1024;

type ReactBundleDependencyProbeIdentity = {
  kind: 'esm_import' | 'stylesheet';
  specifier?: string;
  packageName?: string;
  version?: string;
  requestedUrl: string;
};

type ReactBundleDependencyProbeResult = ReactBundleDependencyProbeIdentity &
  HttpMetadataProbeResult;

export interface ReactBundleDependencyNetworkProbeCandidate {
  schemaVersion: 1;
  adapterKind: 'react_bundle_dependency_metadata_probe';
  inputHash: string;
  probeMode: 'metadata';
  networkPolicy: typeof REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY;
  networkPolicyVersion: typeof REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION;
  allowlistId: typeof REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID;
  generatedAt: string;
  dependencyProbes: ReactBundleDependencyProbeResult[];
  failures: Array<{
    requestedUrl: string;
    reasonCode: string;
    status?: number;
  }>;
}

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
  allRequiredProbesOk: boolean;
  dependencyCount: number;
  failedDependencyCount: number;
  finalUrls: string[];
  failures: Array<{
    requestedUrl: string;
    reasonCode: string;
    status?: number;
  }>;
}

type NetworkProbeProcessResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'cancelled'; stdout: string; stderr: string }
  | { kind: 'crash'; stdout: string; stderr: string };

interface NetworkProbeProcessRunnerArgs {
  outputDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  now: () => string;
  signal?: AbortSignal;
  request: ValidatedReactBundleDependencyPrepareRequest;
  probeTransport?: HttpMetadataProbeRequestTransport;
  writeOutput(relativePath: string, content: string): Promise<void>;
}

type NetworkProbeProcessRunner = (
  args: NetworkProbeProcessRunnerArgs,
) => Promise<NetworkProbeProcessResult>;

export async function probeReactBundleExplicitCdnDependencies(args: {
  workspaceRoot: string;
  store: SandboxAttemptStore;
  request: ReactBundleDependencyPrepareRequest;
  timeoutMs: number;
  now?: () => string;
  signal?: AbortSignal;
  probeTransport?: HttpMetadataProbeRequestTransport;
  processRunner?: NetworkProbeProcessRunner;
}): Promise<ReactBundleDependencyNetworkProbeSummary> {
  const request = validateReactBundleDependencyPrepareRequest(args.request);
  const attempt = args.store.createAttempt({
    jobKind: 'react_bundle_dependency_network_probe',
    adapterKind: 'react_bundle_dependency_metadata_probe',
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
      adapterEnv: {
        GEULBAT_REACT_BUNDLE_DEPENDENCY_METADATA_PROBE: '1',
        GEULBAT_SANDBOX_NETWORK_POLICY: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY,
      },
    });

    const processResult = await runNetworkProbeProcess({
      outputDir: root.outputDir,
      env,
      timeoutMs: args.timeoutMs,
      now: args.now ?? (() => new Date().toISOString()),
      request,
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.probeTransport ? { probeTransport: args.probeTransport } : {}),
      ...(args.processRunner ? { processRunner: args.processRunner } : {}),
    });
    const status = classifyNetworkProbeResult(processResult);
    if (status !== 'succeeded' || processResult.kind !== 'exit') {
      args.store.markTerminal(attempt.attemptId, {
        status,
        exitCode: processResult.kind === 'exit' ? processResult.exitCode : null,
        diagnostics: joinDiagnostics(
          processResult.stdout,
          processResult.stderr,
        ),
      });
      throw new Error(
        `react bundle dependency metadata probe failed: ${status}`,
      );
    }

    return await importNetworkProbeOutput({
      workspaceRoot: args.workspaceRoot,
      store: args.store,
      attemptId: attempt.attemptId,
      request,
      processResult,
      outputDir: root.outputDir,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (root === null) {
      args.store.markTerminal(attempt.attemptId, {
        status: 'failed',
        diagnostics: `sandbox_root_failed: ${message}`,
      });
      throw new Error(
        `react bundle dependency metadata probe sandbox_root_failed: ${message}`,
      );
    }
    throw error;
  } finally {
    await root?.cleanup();
  }
}

async function runNetworkProbeProcess(args: {
  processRunner?: NetworkProbeProcessRunner;
  outputDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  now: () => string;
  signal?: AbortSignal;
  request: ValidatedReactBundleDependencyPrepareRequest;
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

  return (args.processRunner ?? runDefaultNetworkProbeProcess)({
    outputDir: args.outputDir,
    env: args.env,
    timeoutMs: args.timeoutMs,
    now: args.now,
    request: args.request,
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
  };
}

async function buildCandidate(args: {
  request: ValidatedReactBundleDependencyPrepareRequest;
  now: () => string;
  signal?: AbortSignal;
  probeTransport?: HttpMetadataProbeRequestTransport;
}): Promise<ReactBundleDependencyNetworkProbeCandidate> {
  const dependencyProbes = await Promise.all(
    args.request.dependencyRefs.map(async (dependency) => ({
      ...probeIdentity(dependency),
      ...(await probeHttpMetadata({
        url: dependency.url,
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
    case 'crash':
      return 'crashed';
  }
}

async function importNetworkProbeOutput(args: {
  workspaceRoot: string;
  store: SandboxAttemptStore;
  attemptId: string;
  request: ValidatedReactBundleDependencyPrepareRequest;
  processResult: Extract<NetworkProbeProcessResult, { kind: 'exit' }>;
  outputDir: string;
}): Promise<ReactBundleDependencyNetworkProbeSummary> {
  const current = args.store.getAttempt(args.attemptId);
  if (!current) {
    throw new Error(`sandbox attempt not found: ${args.attemptId}`);
  }

  const collectedOutput = await collectSandboxOutputRef(args.outputDir, {
    maxFiles: NETWORK_PROBE_OUTPUT_MAX_FILES,
    maxBytes: NETWORK_PROBE_OUTPUT_MAX_BYTES,
  });
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

async function readAndValidateCandidate(args: {
  outputRef: SandboxOutputRef;
  request: ValidatedReactBundleDependencyPrepareRequest;
}): Promise<ReactBundleDependencyNetworkProbeCandidate> {
  const candidateText = await readFile(
    join(args.outputRef.rootPath, 'candidate.json'),
    'utf8',
  );
  const candidate = JSON.parse(
    candidateText,
  ) as ReactBundleDependencyNetworkProbeCandidate;
  if (candidate.schemaVersion !== 1) {
    throw new Error('candidate schemaVersion must be 1');
  }
  if (candidate.adapterKind !== 'react_bundle_dependency_metadata_probe') {
    throw new Error('candidate adapterKind mismatch');
  }
  if (candidate.inputHash !== args.request.inputHash) {
    throw new Error('candidate input hash mismatch');
  }
  if (candidate.networkPolicy !== REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY) {
    throw new Error('candidate networkPolicy mismatch');
  }
  if (
    candidate.networkPolicyVersion !==
    REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION
  ) {
    throw new Error('candidate networkPolicyVersion mismatch');
  }
  if (candidate.allowlistId !== REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID) {
    throw new Error('candidate allowlistId mismatch');
  }
  if (
    candidate.dependencyProbes.length !== args.request.dependencyRefs.length
  ) {
    throw new Error('candidate dependency probe count mismatch');
  }
  for (const [index, expected] of args.request.dependencyRefs.entries()) {
    const actual = candidate.dependencyProbes[index];
    if (!actual) {
      throw new Error('candidate dependency probe missing');
    }
    if (actual.kind !== expected.kind) {
      throw new Error('candidate dependency probe kind mismatch');
    }
    if (actual.requestedUrl !== expected.url) {
      throw new Error('candidate dependency probe requestedUrl mismatch');
    }
    if (expected.specifier && actual.specifier !== expected.specifier) {
      throw new Error('candidate dependency probe specifier mismatch');
    }
  }

  const expectedFailures = projectFailures(candidate.dependencyProbes);
  if (
    stableStringify(candidate.failures) !== stableStringify(expectedFailures)
  ) {
    throw new Error('candidate failures projection mismatch');
  }
  return candidate;
}

function toSummary(args: {
  attempt: { jobId: string; attemptId: string };
  outputRef: SandboxOutputRef;
  candidate: ReactBundleDependencyNetworkProbeCandidate;
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
    allRequiredProbesOk: args.candidate.failures.length === 0,
    dependencyCount: args.candidate.dependencyProbes.length,
    failedDependencyCount: args.candidate.failures.length,
    finalUrls: args.candidate.dependencyProbes.flatMap((probe) =>
      probe.ok ? [probe.finalUrl] : [],
    ),
    failures: args.candidate.failures,
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

function isFailedProbe(
  probe: ReactBundleDependencyProbeResult,
): probe is ReactBundleDependencyProbeIdentity &
  Extract<HttpMetadataProbeResult, { ok: false }> {
  return !probe.ok;
}

function joinDiagnostics(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}

function sha256StableJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
