import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  validateReactBundleRuntimeUrlPolicy,
  type ReactBundleRuntimeUrlPolicyFailureReason,
} from '@geulbat/protocol/react-bundle-runtime-url-policy';
import { isPlainRecord } from '@geulbat/protocol/runtime-utils';
import type { ProcessCommandResult } from '@geulbat/shared-utils/process-command';
import { sha256StableJson } from '@geulbat/shared-utils/stable-json';
import type {
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

export interface ReactBundleRuntimeDependencies {
  importMap?: {
    imports?: Record<string, string>;
  };
  stylesheets?: string[];
}

export type ReactBundleExplicitDependencyRef =
  | {
      kind: 'esm_import';
      specifier: string;
      packageName: string;
      version: string;
      provider: 'explicit_cdn';
      url: string;
      integrity?: string;
    }
  | {
      kind: 'stylesheet';
      packageName?: string;
      version?: string;
      provider: 'explicit_cdn';
      url: string;
      integrity?: string;
    };

export interface ReactBundleDependencyPrepareRequest {
  entryUrl: string;
  runtimeDependencies: ReactBundleRuntimeDependencies;
  dependencyRefs: ReactBundleExplicitDependencyRef[];
}

export interface ValidatedReactBundleDependencyRef {
  kind: 'esm_import' | 'stylesheet';
  specifier?: string;
  packageName?: string;
  version?: string;
  provider: 'explicit_cdn';
  url: string;
  integrity?: string;
  integrityStatus: 'provided' | 'missing_allowed';
}

export interface ValidatedReactBundleDependencyPrepareRequest {
  entryUrl: string;
  runtimeDependencies: ReactBundleRuntimeDependencies;
  dependencyRefs: ValidatedReactBundleDependencyRef[];
  inputHash: string;
  lifecycleScripts: 'not_applicable';
  networkPolicy: 'none';
}

export interface ReactBundleDependencyPrepareSummary {
  ok: true;
  jobId: string;
  attemptId: string;
  evidenceRef: string;
  candidateHash: string;
  manifest: {
    entryUrl: string;
    runtimeDependencies: ReactBundleRuntimeDependencies;
  };
  provenanceSummary: {
    provider: 'explicit_cdn';
    resolvedUrls: string[];
    dependencyCount: number;
    lifecycleScripts: 'not_applicable';
    networkPolicy: 'none';
    dependencyEvidence: Array<{
      kind: 'esm_import' | 'stylesheet';
      specifier?: string;
      packageName?: string;
      version?: string;
      url: string;
      integrityStatus: 'provided' | 'missing_allowed';
    }>;
  };
}

type DependencyPrepareCandidate = ReturnType<typeof buildCandidate>;

type DependencyPrepareProcessResult = ProcessCommandResult;

interface DependencyPrepareProcessRunnerArgs {
  cwd: string;
  outputDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  request: ValidatedReactBundleDependencyPrepareRequest;
  writeOutput(relativePath: string, content: string): Promise<void>;
}

type DependencyPrepareProcessRunner = (
  args: DependencyPrepareProcessRunnerArgs,
) => Promise<DependencyPrepareProcessResult>;

export function validateReactBundleDependencyPrepareRequest(
  request: ReactBundleDependencyPrepareRequest,
): ValidatedReactBundleDependencyPrepareRequest {
  assertNonEmptyString(request.entryUrl, 'entryUrl');
  const entryUrl = normalizeReactBundleEntryUrl(request.entryUrl);
  const runtimeDependencies = normalizeRuntimeDependencies(
    request.runtimeDependencies,
  );
  if (!Array.isArray(request.dependencyRefs)) {
    throw new Error('dependencyRefs must be an array');
  }

  const imports = runtimeDependencies.importMap?.imports ?? {};
  const stylesheets = runtimeDependencies.stylesheets ?? [];
  const normalizedRefs = request.dependencyRefs.map(normalizeDependencyRef);

  assertEsmImportConsistency(imports, normalizedRefs);
  assertStylesheetConsistency(stylesheets, normalizedRefs);

  return {
    entryUrl,
    runtimeDependencies,
    dependencyRefs: normalizedRefs,
    inputHash: sha256StableJson({ ...request, entryUrl }),
    lifecycleScripts: 'not_applicable',
    networkPolicy: 'none',
  };
}

function normalizeRuntimeDependencies(
  value: unknown,
): ReactBundleRuntimeDependencies {
  assertPlainRecord(value, 'runtimeDependencies');
  assertSupportedKeys(value, ['importMap', 'stylesheets'], (key) => {
    throw new Error(`runtimeDependencies does not support ${key}`);
  });

  const importMap = normalizeRuntimeImportMap(value.importMap);
  const stylesheets = normalizeRuntimeStylesheets(value.stylesheets);
  const dependencies: ReactBundleRuntimeDependencies = {};
  if (importMap && Object.keys(importMap.imports ?? {}).length > 0) {
    dependencies.importMap = importMap;
  }
  if (stylesheets && stylesheets.length > 0) {
    dependencies.stylesheets = stylesheets;
  }
  return dependencies;
}

function normalizeRuntimeImportMap(
  value: unknown,
): ReactBundleRuntimeDependencies['importMap'] | undefined {
  if (value === undefined) return undefined;
  assertPlainRecord(value, 'runtimeDependencies.importMap');
  assertSupportedKeys(value, ['imports'], () => {
    throw new Error('runtimeDependencies.importMap supports imports only');
  });

  if (value.imports === undefined) return undefined;
  assertPlainRecord(value.imports, 'runtimeDependencies.importMap.imports');

  const imports: Record<string, string> = {};
  for (const [specifier, url] of Object.entries(value.imports)) {
    if (specifier.trim().length === 0) {
      throw new Error('runtime dependency import specifier must be non-empty');
    }
    if (/[\u0000-\u001f\u007f]/u.test(specifier)) {
      throw new Error(
        'runtime dependency import specifier must not contain control characters',
      );
    }
    if (typeof url !== 'string') {
      throw new Error(
        'runtimeDependencies.importMap.imports values must be strings',
      );
    }
    imports[specifier] = normalizeDependencyUrl(url);
  }

  return Object.keys(imports).length > 0 ? { imports } : undefined;
}

function normalizeRuntimeStylesheets(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('runtimeDependencies.stylesheets must be an array');
  }

  const stylesheets = value.map((url) => {
    if (typeof url !== 'string') {
      throw new Error(
        'runtimeDependencies.stylesheets entries must be strings',
      );
    }
    return normalizeDependencyUrl(url);
  });
  return stylesheets.length > 0 ? stylesheets : undefined;
}

export async function prepareReactBundleExplicitCdnDependencies(args: {
  workspaceRoot: string;
  store: SandboxAttemptStore;
  request: ReactBundleDependencyPrepareRequest;
  timeoutMs?: number;
  signal?: AbortSignal;
  processRunner?: DependencyPrepareProcessRunner;
}): Promise<ReactBundleDependencyPrepareSummary> {
  const request = validateReactBundleDependencyPrepareRequest(args.request);
  const attempt = args.store.createAttempt({
    jobKind: 'react_bundle_dependency_prepare',
    adapterKind: 'react_bundle_explicit_cdn_dependency_prepare',
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
        `react bundle dependency prepare sandbox_root_failed: ${message}`,
      );
    },
    run: async (root) => {
      const env = buildSandboxEnvironment({
        homeDir: root.homeDir,
        tempDir: root.tempDir,
        adapterEnv: {
          GEULBAT_REACT_BUNDLE_DEPENDENCY_PREPARE: '1',
          GEULBAT_SANDBOX_NETWORK_POLICY: 'none',
        },
      });

      const processResult = await runDependencyPrepareProcess({
        cwd: root.rootPath,
        outputDir: root.outputDir,
        env,
        request,
        ...(args.signal ? { signal: args.signal } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(args.processRunner ? { processRunner: args.processRunner } : {}),
      });
      const status = classifyDependencyPrepareResult(processResult);
      if (status !== 'succeeded') {
        args.store.markTerminal(attempt.attemptId, {
          status,
          exitCode:
            processResult.kind === 'exit' ? processResult.exitCode : null,
          diagnostics: joinDiagnostics(
            processResult.stdout,
            processResult.stderr,
          ),
        });
        throw new Error(`react bundle dependency prepare failed: ${status}`);
      }
      if (processResult.kind !== 'exit') {
        throw new Error('succeeded dependency prepare did not exit');
      }

      return await importDependencyPrepareOutput({
        workspaceRoot: args.workspaceRoot,
        store: args.store,
        attemptId: attempt.attemptId,
        request,
        processResult,
        outputDir: root.outputDir,
      });
    },
  });
}

async function runDependencyPrepareProcess(args: {
  processRunner?: DependencyPrepareProcessRunner;
  cwd: string;
  outputDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  request: ValidatedReactBundleDependencyPrepareRequest;
}): Promise<DependencyPrepareProcessResult> {
  const writeOutput = async (
    relativePath: string,
    content: string,
  ): Promise<void> => {
    const targetPath = join(args.outputDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
  };

  return (args.processRunner ?? runDefaultDependencyPrepareProcess)({
    cwd: args.cwd,
    outputDir: args.outputDir,
    env: args.env,
    request: args.request,
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    writeOutput,
  });
}

async function runDefaultDependencyPrepareProcess(
  args: DependencyPrepareProcessRunnerArgs,
): Promise<DependencyPrepareProcessResult> {
  if (args.signal?.aborted) {
    return {
      kind: 'cancelled',
      stdout: '',
      stderr: 'dependency prepare cancelled',
    };
  }

  const candidate = buildCandidate(args.request);
  await args.writeOutput(
    'candidate.json',
    JSON.stringify(candidate, null, 2) + '\n',
  );
  return {
    kind: 'exit',
    exitCode: 0,
    stdout: 'react bundle dependency prepare ok',
    stderr: '',
  };
}
function buildCandidate(request: ValidatedReactBundleDependencyPrepareRequest) {
  return {
    schemaVersion: 1 as const,
    adapterKind: 'react_bundle_explicit_cdn_dependency_prepare' as const,
    entryUrl: request.entryUrl,
    runtimeDependencies: request.runtimeDependencies,
    provenance: {
      inputHash: request.inputHash,
      generatedAt: new Date(0).toISOString(),
      provider: 'explicit_cdn' as const,
      resolvedUrls: request.dependencyRefs.map((dependency) => dependency.url),
      dependencyRefs: request.dependencyRefs,
      lifecycleScripts: 'not_applicable' as const,
      networkPolicy: 'none' as const,
    },
  };
}

function classifyDependencyPrepareResult(
  result: DependencyPrepareProcessResult,
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

async function importDependencyPrepareOutput(args: {
  workspaceRoot: string;
  store: SandboxAttemptStore;
  attemptId: string;
  request: ValidatedReactBundleDependencyPrepareRequest;
  processResult: Extract<DependencyPrepareProcessResult, { kind: 'exit' }>;
  outputDir: string;
}): Promise<ReactBundleDependencyPrepareSummary> {
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
      `react bundle dependency prepare output_collection_failed: ${message}`,
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
      `react bundle dependency prepare evidence_import_failed: ${message}`,
    );
  }

  let candidate: DependencyPrepareCandidate;
  try {
    candidate = await readAndValidateCandidate({
      outputRef,
      request: args.request,
    });
  } catch (error: unknown) {
    args.store.markTerminal(args.attemptId, {
      status: 'failed',
      exitCode: args.processResult.exitCode,
      diagnostics: `candidate_validation_failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    throw error;
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
}): Promise<DependencyPrepareCandidate> {
  const candidateText = await readFile(
    join(args.outputRef.rootPath, 'candidate.json'),
    'utf8',
  );
  const candidate = JSON.parse(candidateText) as DependencyPrepareCandidate;
  if (candidate.schemaVersion !== 1) {
    throw new Error('candidate schemaVersion must be 1');
  }
  if (
    candidate.adapterKind !== 'react_bundle_explicit_cdn_dependency_prepare'
  ) {
    throw new Error('candidate adapterKind mismatch');
  }
  if (candidate.provenance.inputHash !== args.request.inputHash) {
    throw new Error('candidate input hash mismatch');
  }
  if (candidate.provenance.networkPolicy !== 'none') {
    throw new Error('candidate networkPolicy must be none');
  }
  if (candidate.provenance.lifecycleScripts !== 'not_applicable') {
    throw new Error('candidate lifecycleScripts must be not_applicable');
  }
  return candidate;
}

function toSummary(args: {
  attempt: { jobId: string; attemptId: string };
  outputRef: SandboxOutputRef;
  candidate: DependencyPrepareCandidate;
}): ReactBundleDependencyPrepareSummary {
  return {
    ok: true,
    jobId: args.attempt.jobId,
    attemptId: args.attempt.attemptId,
    evidenceRef: args.outputRef.evidenceRef,
    candidateHash: sha256StableJson(args.candidate),
    manifest: {
      entryUrl: args.candidate.entryUrl,
      runtimeDependencies: args.candidate.runtimeDependencies,
    },
    provenanceSummary: {
      provider: 'explicit_cdn',
      resolvedUrls: args.candidate.provenance.resolvedUrls,
      dependencyCount: args.candidate.provenance.dependencyRefs.length,
      lifecycleScripts: 'not_applicable',
      networkPolicy: 'none',
      dependencyEvidence: args.candidate.provenance.dependencyRefs.map(
        (dependency) => ({
          kind: dependency.kind,
          ...(dependency.specifier ? { specifier: dependency.specifier } : {}),
          ...(dependency.packageName
            ? { packageName: dependency.packageName }
            : {}),
          ...(dependency.version ? { version: dependency.version } : {}),
          url: dependency.url,
          integrityStatus: dependency.integrityStatus,
        }),
      ),
    },
  };
}

function joinDiagnostics(stdout: string, stderr: string): string {
  return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}

function normalizeDependencyRef(
  ref: ReactBundleExplicitDependencyRef,
): ValidatedReactBundleDependencyRef {
  if (ref.provider !== 'explicit_cdn') {
    throw new Error('dependency provider must be explicit_cdn');
  }
  normalizeDependencyUrl(ref.url);

  if (ref.kind === 'esm_import') {
    assertNonEmptyString(ref.specifier, 'dependency specifier');
    assertNonEmptyString(ref.packageName, 'dependency packageName');
    assertExactVersion(ref.version);
    assertUrlContainsVersion(ref.url, ref.version);
    return {
      ...ref,
      integrityStatus: ref.integrity ? 'provided' : 'missing_allowed',
    };
  }

  if (ref.version !== undefined) {
    assertExactVersion(ref.version);
    assertUrlContainsVersion(ref.url, ref.version);
  }
  return {
    ...ref,
    integrityStatus: ref.integrity ? 'provided' : 'missing_allowed',
  };
}

function assertEsmImportConsistency(
  imports: Record<string, string>,
  refs: readonly ValidatedReactBundleDependencyRef[],
): void {
  for (const [specifier, url] of Object.entries(imports)) {
    normalizeDependencyUrl(url);
    const matches = refs.filter(
      (ref) =>
        ref.kind === 'esm_import' &&
        ref.specifier === specifier &&
        normalizeDependencyUrl(ref.url) === normalizeDependencyUrl(url),
    );
    if (matches.length !== 1) {
      throw new Error(
        `missing dependency provenance for import-map specifier: ${specifier}`,
      );
    }
  }

  for (const ref of refs.filter((item) => item.kind === 'esm_import')) {
    if (
      !ref.specifier ||
      normalizeDependencyUrl(imports[ref.specifier] ?? '') !==
        normalizeDependencyUrl(ref.url)
    ) {
      throw new Error(
        `dependency provenance does not match import map: ${
          ref.specifier ?? ref.url
        }`,
      );
    }
  }
}

function assertStylesheetConsistency(
  stylesheets: readonly string[],
  refs: readonly ValidatedReactBundleDependencyRef[],
): void {
  for (const stylesheet of stylesheets) {
    normalizeDependencyUrl(stylesheet);
    const matches = refs.filter(
      (ref) =>
        ref.kind === 'stylesheet' &&
        normalizeDependencyUrl(ref.url) === normalizeDependencyUrl(stylesheet),
    );
    if (matches.length !== 1) {
      throw new Error(
        `missing dependency provenance for stylesheet: ${stylesheet}`,
      );
    }
  }

  const stylesheetUrls = new Set(
    stylesheets.map((stylesheet) => normalizeDependencyUrl(stylesheet)),
  );
  for (const ref of refs.filter((item) => item.kind === 'stylesheet')) {
    if (!stylesheetUrls.has(normalizeDependencyUrl(ref.url))) {
      throw new Error(`dependency provenance does not match stylesheets`);
    }
  }
}

function assertExactVersion(version: string): void {
  assertNonEmptyString(version, 'dependency version');
  if (
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version) ||
    version === 'latest' ||
    version === '*' ||
    /[<>=~^*xX|]/u.test(version) ||
    version.includes(' ')
  ) {
    throw new Error(`dependency version must be exact: ${version}`);
  }
}

function assertUrlContainsVersion(url: string, version: string): void {
  if (!url.includes(`@${version}`) && !url.includes(`/${version}/`)) {
    throw new Error(`dependency URL must include exact version: ${version}`);
  }
}

export function normalizeReactBundleEntryUrl(url: string): string {
  const result = validateReactBundleRuntimeUrlPolicy(url);
  if (!result.ok) {
    throw new Error(entryUrlPolicyFailureMessage(result.reasonCode));
  }

  return result.url;
}

function entryUrlPolicyFailureMessage(
  reasonCode: ReactBundleRuntimeUrlPolicyFailureReason,
): string {
  switch (reasonCode) {
    case 'empty':
      return 'entryUrl must be a non-empty absolute URL';
    case 'malformed':
      return 'entryUrl must be an absolute URL';
    case 'unsupported_scheme':
      return 'entryUrl must use http or https';
    case 'shell_owned_privileged':
      return 'entryUrl points at a shell-owned privileged path';
  }
  throw new Error(`unsupported entryUrl policy failure: ${reasonCode}`);
}

export function normalizeDependencyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`dependency URL must be http or https: ${url}`);
    }
    if (hasUserinfoDelimiter(url) || parsed.username || parsed.password) {
      throw new Error(`dependency URL must not include credentials: ${url}`);
    }
    if (isUnsafeDependencyHostname(parsed.hostname)) {
      throw new Error(`dependency URL host is not allowed: ${url}`);
    }
    if (parsed.pathname.includes('/.geulbat/')) {
      throw new Error(
        `dependency URL must not point at .geulbat paths: ${url}`,
      );
    }
    return parsed.toString();
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('dependency URL')) {
      throw error;
    }
    throw new Error(`dependency URL must be absolute: ${url}`);
  }
}

function hasUserinfoDelimiter(url: string): boolean {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(url)?.[1];
  return authority?.includes('@') ?? false;
}

function isUnsafeDependencyHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/u, '$1');
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.startsWith('10.') ||
    normalized.startsWith('169.254.') ||
    normalized.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./u.test(normalized)
  );
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertSupportedKeys(
  value: Record<string, unknown>,
  supportedKeys: readonly string[],
  fail: (key: string) => never,
): void {
  const unsupportedKey = Object.keys(value).find(
    (key) => !supportedKeys.includes(key),
  );
  if (unsupportedKey) {
    fail(unsupportedKey);
  }
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
