import {
  PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
} from './lab-package-cache.js';
import type {
  PtcLabAdmittedProfile,
  PtcLabPolicyProjection,
} from './lab-profile.js';
import {
  runPtcSessionDockerCommand,
  type PtcSessionDockerCommandResult,
} from './session-docker.js';

const PTC_LAB_NPM_INSTALL_MAX_PACKAGES = 8;
const PTC_LAB_NPM_INSTALL_WORKDIR_ROOT = '/tmp/geulbat-package-installs';

export type PtcLabPackageInstallFailureReason =
  | 'ptc_lab_package_install_admission_required'
  | 'ptc_lab_package_install_policy_disabled'
  | 'ptc_lab_package_install_policy_mismatch'
  | 'ptc_lab_package_install_request_invalid'
  | 'ptc_lab_package_install_workdir_exists'
  | 'ptc_lab_package_manager_unavailable'
  | 'ptc_lab_package_install_timeout'
  | 'ptc_lab_package_install_cancelled'
  | 'ptc_lab_package_install_failed'
  | 'ptc_lab_package_install_output_invalid';

export type PtcLabPackageInstallResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcLabPackageInstallFailureReason;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

export interface PtcLabNpmExactPackage {
  name: string;
  version: string;
}

export interface PtcLabCacheOnlyNpmInstallRequest {
  manager: 'npm';
  installId: string;
  packages: PtcLabNpmExactPackage[];
  timeoutMs?: number;
  outputExcerptByteLimit?: number;
}

export interface PtcLabPackageInstallSessionHandle {
  profile: 'lab';
  policyId: string;
  labSessionId: string;
  containerId: string;
  packageCacheRootContainerPath: string;
  packageCacheMountPolicyId: string;
  packageCacheId: string;
  packageCacheIdentityHash: string;
}

export interface PtcLabPackageInstallRunnerInvocation {
  executable: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export type PtcLabPackageInstallRunnerResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | {
      kind: 'timeout';
      stdout: string;
      stderr: string;
      processTerminated: boolean;
    }
  | {
      kind: 'cancelled';
      stdout: string;
      stderr: string;
      processTerminated: boolean;
    }
  | { kind: 'package_manager_unavailable'; stdout: string; stderr: string }
  | { kind: 'workdir_exists'; stdout: string; stderr: string }
  | { kind: 'failed'; stdout: string; stderr: string };

export type PtcLabPackageInstallRunner = (
  invocation: PtcLabPackageInstallRunnerInvocation,
) => Promise<PtcLabPackageInstallRunnerResult>;

export interface PtcLabPackageInstallSessionTaint {
  reasonCode:
    | 'ptc_lab_package_install_timeout'
    | 'ptc_lab_package_install_cancelled';
  installId: string;
  containerId: string;
}

export interface RunPtcLabCacheOnlyNpmInstallSmokeArgs {
  admission: PtcLabAdmittedProfile | undefined;
  session: PtcLabPackageInstallSessionHandle | undefined;
  request: PtcLabCacheOnlyNpmInstallRequest;
  runner?: PtcLabPackageInstallRunner;
  dockerPath?: string;
  now?: () => number;
  signal?: AbortSignal;
  onSessionTainted?: (
    taint: PtcLabPackageInstallSessionTaint,
  ) => Promise<void> | void;
}

export interface PtcLabCacheOnlyNpmInstallSummary {
  manager: 'npm';
  installMode: 'cache_only';
  installId: string;
  packageCount: number;
  packages: PtcLabNpmExactPackage[];
  cacheIdentityHash: string;
  packageCacheId: string;
  packageCacheMountPolicyId: string;
  lifecycleScriptsPolicyId: string;
  networkInstallPolicyId: string;
  telemetryPolicyId: string;
  offline: true;
  lifecycleScripts: 'disabled';
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  cacheObservation: 'not_measured' | 'npm_reported_cache_miss_possible';
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export async function runPtcLabCacheOnlyNpmInstallSmoke(
  args: RunPtcLabCacheOnlyNpmInstallSmokeArgs,
): Promise<PtcLabPackageInstallResult<PtcLabCacheOnlyNpmInstallSummary>> {
  const policy = readAdmittedCacheOnlyNpmPolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }

  const session = validatePackageInstallSession({
    session: args.session,
    policy: policy.value,
  });
  if (!session.ok) {
    return session;
  }

  const request = validatePackageInstallRequest({
    request: args.request,
    policy: policy.value,
  });
  if (!request.ok) {
    return request;
  }

  const start = (args.now ?? Date.now)();
  let runnerResult: PtcLabPackageInstallRunnerResult;
  try {
    runnerResult = await (args.runner ?? runDefaultPackageInstallRunner)({
      executable: args.dockerPath ?? 'docker',
      args: buildNpmInstallArgs({
        containerId: session.value.containerId,
        installId: request.value.installId,
        packages: request.value.packages,
      }),
      timeoutMs: request.value.effectiveTimeoutMs,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch {
    return failure(
      'ptc_lab_package_install_failed',
      'PTC lab package install runner failed',
    );
  }

  const durationMs = Math.max(0, (args.now ?? Date.now)() - start);
  return await mapRunnerResult({
    runnerResult,
    args,
    session: session.value,
    policy: policy.value,
    request: request.value,
    durationMs,
  });
}

function readAdmittedCacheOnlyNpmPolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabPackageInstallResult<PtcLabPolicyProjection> {
  if (
    admission === undefined ||
    admission.metadata.selectedProfile !== 'lab' ||
    admission.labPolicy === undefined
  ) {
    return failure(
      'ptc_lab_package_install_admission_required',
      'PTC lab package install requires an admitted lab profile',
    );
  }

  const policy = admission.labPolicy;
  if (
    policy.packageCache.enabled !== true ||
    policy.packageCache.containerRoot !==
      PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT ||
    policy.packageCache.mountPolicyId !==
      PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID ||
    policy.packageManager.enabled !== true ||
    !policy.packageManager.managers.includes('npm') ||
    policy.packageManager.installMode !== 'cache_only' ||
    policy.packageManager.lifecycleScripts.policy !== 'disabled' ||
    policy.packageManager.lifecycleScripts.policyId !==
      PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID ||
    policy.packageManager.maxInstallMs <= 0 ||
    policy.packageManager.maxInstallOutputBytes <= 0 ||
    policy.network.mode !== 'disabled'
  ) {
    return failure(
      'ptc_lab_package_install_policy_disabled',
      'PTC lab cache-only npm install policy is disabled',
    );
  }

  return { ok: true, value: policy };
}

function validatePackageInstallSession(args: {
  session: PtcLabPackageInstallSessionHandle | undefined;
  policy: PtcLabPolicyProjection;
}): PtcLabPackageInstallResult<PtcLabPackageInstallSessionHandle> {
  if (
    args.session === undefined ||
    args.session.profile !== 'lab' ||
    args.session.policyId !== args.policy.policyId ||
    args.session.packageCacheRootContainerPath !==
      PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT ||
    args.session.packageCacheMountPolicyId !==
      args.policy.packageCache.mountPolicyId ||
    args.session.packageCacheId !== args.policy.packageCache.cacheId ||
    !/^[a-f0-9]{64}$/u.test(args.session.packageCacheIdentityHash)
  ) {
    return failure(
      'ptc_lab_package_install_policy_mismatch',
      'PTC lab package install session does not match admitted package cache policy',
    );
  }

  return { ok: true, value: args.session };
}

function validatePackageInstallRequest(args: {
  request: PtcLabCacheOnlyNpmInstallRequest;
  policy: PtcLabPolicyProjection;
}): PtcLabPackageInstallResult<{
  installId: string;
  packages: PtcLabNpmExactPackage[];
  effectiveTimeoutMs: number;
  outputExcerptByteLimit: number;
}> {
  if (
    args.request.manager !== 'npm' ||
    !isSafeInstallId(args.request.installId)
  ) {
    return requestInvalid();
  }

  if (
    !Array.isArray(args.request.packages) ||
    args.request.packages.length === 0 ||
    args.request.packages.length > PTC_LAB_NPM_INSTALL_MAX_PACKAGES
  ) {
    return requestInvalid();
  }

  const seenNames = new Set<string>();
  const packages: PtcLabNpmExactPackage[] = [];
  for (const pkg of args.request.packages) {
    if (!isSafeNpmPackageName(pkg.name) || !isExactSemver(pkg.version)) {
      return requestInvalid();
    }
    if (seenNames.has(pkg.name)) {
      return requestInvalid();
    }
    seenNames.add(pkg.name);
    packages.push({ name: pkg.name, version: pkg.version });
  }
  packages.sort((first, second) =>
    first.name === second.name
      ? first.version.localeCompare(second.version)
      : first.name.localeCompare(second.name),
  );

  const effectiveTimeoutMs =
    args.request.timeoutMs ?? args.policy.packageManager.maxInstallMs;
  if (
    !Number.isFinite(effectiveTimeoutMs) ||
    !Number.isInteger(effectiveTimeoutMs) ||
    effectiveTimeoutMs <= 0 ||
    effectiveTimeoutMs > args.policy.packageManager.maxInstallMs
  ) {
    return requestInvalid();
  }

  const outputExcerptByteLimit =
    args.request.outputExcerptByteLimit ??
    args.policy.packageManager.maxInstallOutputBytes;
  if (
    !Number.isFinite(outputExcerptByteLimit) ||
    !Number.isInteger(outputExcerptByteLimit) ||
    outputExcerptByteLimit <= 0 ||
    outputExcerptByteLimit > args.policy.packageManager.maxInstallOutputBytes
  ) {
    return requestInvalid();
  }

  return {
    ok: true,
    value: {
      installId: args.request.installId,
      packages,
      effectiveTimeoutMs,
      outputExcerptByteLimit,
    },
  };
}

function requestInvalid(): PtcLabPackageInstallResult<never> {
  return failure(
    'ptc_lab_package_install_request_invalid',
    'PTC lab cache-only npm install request is invalid',
  );
}

function isSafeInstallId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(value);
}

function isSafeNpmPackageName(value: string): boolean {
  const unscoped = '[a-z0-9][a-z0-9._-]{0,213}';
  const scoped = `@[a-z0-9][a-z0-9._-]{0,213}\\/${unscoped}`;
  if (!new RegExp(`^(?:${unscoped}|${scoped})$`, 'u').test(value)) {
    return false;
  }
  return (
    !value.includes('..') &&
    !value.includes('@', value.startsWith('@') ? 1 : 0) &&
    !/^(?:file|git|https?|workspace|link):/u.test(value)
  );
}

function isExactSemver(value: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/u.test(
    value,
  );
}

function buildNpmInstallArgs(args: {
  containerId: string;
  installId: string;
  packages: PtcLabNpmExactPackage[];
}): string[] {
  const installWorkdir = `${PTC_LAB_NPM_INSTALL_WORKDIR_ROOT}/${args.installId}`;
  return [
    'exec',
    args.containerId,
    'npm',
    'install',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    `${PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT}/npm`,
    '--userconfig',
    `${installWorkdir}/empty-npmrc`,
    '--globalconfig',
    `${installWorkdir}/empty-global-npmrc`,
    '--prefix',
    installWorkdir,
    ...args.packages.map((pkg) => `${pkg.name}@${pkg.version}`),
  ];
}

async function runDefaultPackageInstallRunner(
  invocation: PtcLabPackageInstallRunnerInvocation,
): Promise<PtcLabPackageInstallRunnerResult> {
  const result: PtcSessionDockerCommandResult =
    await runPtcSessionDockerCommand(invocation);
  if (result.kind === 'exit') {
    if (result.exitCode === 126 || result.exitCode === 127) {
      return {
        kind: 'package_manager_unavailable',
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    return {
      kind: 'exit',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  if (result.kind === 'timeout') {
    return {
      kind: 'timeout',
      stdout: result.stdout,
      stderr: result.stderr,
      processTerminated: false,
    };
  }
  if (result.kind === 'cancelled') {
    return {
      kind: 'cancelled',
      stdout: result.stdout,
      stderr: result.stderr,
      processTerminated: false,
    };
  }
  return { kind: 'failed', stdout: result.stdout, stderr: result.stderr };
}

async function mapRunnerResult(args: {
  runnerResult: PtcLabPackageInstallRunnerResult;
  args: RunPtcLabCacheOnlyNpmInstallSmokeArgs;
  session: PtcLabPackageInstallSessionHandle;
  policy: PtcLabPolicyProjection;
  request: {
    installId: string;
    packages: PtcLabNpmExactPackage[];
    effectiveTimeoutMs: number;
    outputExcerptByteLimit: number;
  };
  durationMs: number;
}): Promise<PtcLabPackageInstallResult<PtcLabCacheOnlyNpmInstallSummary>> {
  switch (args.runnerResult.kind) {
    case 'exit': {
      const stdout = sanitizeOutput(
        args.runnerResult.stdout,
        args.request.outputExcerptByteLimit,
      );
      const stderr = sanitizeOutput(
        args.runnerResult.stderr,
        args.request.outputExcerptByteLimit,
      );
      return {
        ok: true,
        value: {
          manager: 'npm',
          installMode: 'cache_only',
          installId: args.request.installId,
          packageCount: args.request.packages.length,
          packages: args.request.packages.map((pkg) => ({ ...pkg })),
          cacheIdentityHash: args.session.packageCacheIdentityHash,
          packageCacheId: args.session.packageCacheId,
          packageCacheMountPolicyId: args.session.packageCacheMountPolicyId,
          lifecycleScriptsPolicyId:
            args.policy.packageManager.lifecycleScripts.policyId,
          networkInstallPolicyId:
            args.policy.network.mode === 'disabled'
              ? args.policy.network.policyVersion
              : 'unsupported',
          telemetryPolicyId: args.policy.packageManager.telemetryPolicyId,
          offline: true,
          lifecycleScripts: 'disabled',
          exitCode: args.runnerResult.exitCode,
          timedOut: false,
          durationMs: args.durationMs,
          cacheObservation: describeCacheObservation(
            `${args.runnerResult.stdout}\n${args.runnerResult.stderr}`,
          ),
          stdout: stdout.value,
          stderr: stderr.value,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        },
      };
    }
    case 'timeout': {
      const taint = await maybeTaintSession({
        args: args.args,
        session: args.session,
        installId: args.request.installId,
        reasonCode: 'ptc_lab_package_install_timeout',
        processTerminated: args.runnerResult.processTerminated,
      });
      return failure(
        'ptc_lab_package_install_timeout',
        'PTC lab cache-only npm install timed out',
        taint.ok ? undefined : { sessionTaintCleanupFailed: true },
      );
    }
    case 'cancelled': {
      const taint = await maybeTaintSession({
        args: args.args,
        session: args.session,
        installId: args.request.installId,
        reasonCode: 'ptc_lab_package_install_cancelled',
        processTerminated: args.runnerResult.processTerminated,
      });
      return failure(
        'ptc_lab_package_install_cancelled',
        'PTC lab cache-only npm install was cancelled',
        taint.ok ? undefined : { sessionTaintCleanupFailed: true },
      );
    }
    case 'package_manager_unavailable':
      return failure(
        'ptc_lab_package_manager_unavailable',
        'PTC lab npm package manager is unavailable',
      );
    case 'workdir_exists':
      return failure(
        'ptc_lab_package_install_workdir_exists',
        'PTC lab package install workdir already exists',
      );
    case 'failed':
      return failure(
        'ptc_lab_package_install_failed',
        'PTC lab cache-only npm install failed',
      );
  }
}

function describeCacheObservation(
  output: string,
): PtcLabCacheOnlyNpmInstallSummary['cacheObservation'] {
  return /(?:cache miss|not.*cache|enotcached|offline)/iu.test(output)
    ? 'npm_reported_cache_miss_possible'
    : 'not_measured';
}

async function maybeTaintSession(args: {
  args: RunPtcLabCacheOnlyNpmInstallSmokeArgs;
  session: PtcLabPackageInstallSessionHandle;
  installId: string;
  reasonCode:
    | 'ptc_lab_package_install_timeout'
    | 'ptc_lab_package_install_cancelled';
  processTerminated: boolean;
}): Promise<{ ok: true } | { ok: false }> {
  if (args.processTerminated) {
    return { ok: true };
  }
  try {
    await args.args.onSessionTainted?.({
      reasonCode: args.reasonCode,
      installId: args.installId,
      containerId: args.session.containerId,
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function sanitizeOutput(
  value: string,
  limit: number,
): { value: string; truncated: boolean } {
  const redacted = sanitizePrivateMarkers(value);
  if (Buffer.byteLength(redacted, 'utf8') <= limit) {
    return { value: redacted, truncated: false };
  }
  const sliced = Buffer.from(redacted, 'utf8')
    .subarray(0, Math.max(0, limit))
    .toString('utf8');
  return { value: `${sliced}\n[truncated]`, truncated: true };
}

function sanitizePrivateMarkers(value: string): string {
  return value
    .replaceAll(
      /\/geulbat\/package-cache\/?[^"' \n\r\t]*/gu,
      '[redacted:package-cache-path]',
    )
    .replaceAll(
      /\/tmp\/geulbat-package-installs\/?[^"' \n\r\t]*/gu,
      '[redacted:install-workdir]',
    )
    .replaceAll(
      /\/geulbat\/callbacks\/[^"' \n\r\t]*/gu,
      '[redacted:callback-path]',
    )
    .replaceAll(
      /[^"' \n\r\t]*callback\.sock[^"' \n\r\t]*/gu,
      '[redacted:callback-socket]',
    )
    .replaceAll(/\/var\/run\/docker\.sock/gu, '[redacted:docker-socket]')
    .replaceAll(
      /(?:[A-Za-z]:\\|\/)[^"' \n\r\t]*\.geulbat[^"' \n\r\t]*/gu,
      '[redacted:path]',
    )
    .replaceAll(
      /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/|\/mnt\/c\/Users\/|\/tmp\/|\/var\/folders\/)[^"' \n\r\t]*/gu,
      '[redacted:path]',
    )
    .replaceAll(
      /(?:NPM_TOKEN|NODE_AUTH_TOKEN|npmrc|\.npmrc|registry|provider|oauth|session|token)[_-]?(?:secret|token|material)?=["':]?[^"'\s]*/giu,
      '[redacted:secret]',
    );
}

function failure(
  reasonCode: PtcLabPackageInstallFailureReason,
  message: string,
  diagnostics?: Record<string, string | number | boolean>,
): PtcLabPackageInstallResult<never> {
  return diagnostics === undefined
    ? { ok: false, reasonCode, message }
    : { ok: false, reasonCode, message, diagnostics };
}
