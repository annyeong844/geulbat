import {
  PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID,
  PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID,
} from './lab-package-cache-contract.js';
import type { PtcLabAdmittedProfile } from './lab-profile.js';
import type { PtcLabPolicyProjection } from './lab-profile.js';
import {
  PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_EXIT_CODE,
  PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_MARKER,
  type PtcLabCacheOnlyNpmInstallRequest,
  type PtcLabCacheOnlyPackageInstallSessionHandle,
  type PtcLabNetworkNpmInstallRequest,
  type PtcLabNetworkPackageInstallSessionHandle,
  type PtcLabNpmExactPackage,
  type PtcLabOpenNetworkPolicyProjection,
  type PtcLabPackageInstallModeForSmoke,
  type PtcLabPackageInstallResult,
  type PtcLabPackageInstallSessionHandle,
  type PtcLabValidatedNpmInstallRequest,
  packageInstallFailure,
} from './lab-package-install-contract.js';

const PTC_LAB_NPM_INSTALL_MAX_PACKAGES = 8;
const PTC_LAB_NPM_INSTALL_WORKDIR_ROOT = '/tmp/geulbat-package-installs';

export function readAdmittedCacheOnlyNpmPolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabPackageInstallResult<PtcLabPolicyProjection> {
  const policy = readAdmittedLabPolicy(admission);
  if (!policy.ok) {
    return policy;
  }

  if (
    !hasEnabledNpmInstallPolicy(policy.value) ||
    policy.value.packageManager.installMode !== 'cache_only' ||
    policy.value.network.mode !== 'disabled'
  ) {
    return packageInstallFailure(
      'ptc_lab_package_install_policy_disabled',
      'PTC lab cache-only npm install policy is disabled',
    );
  }

  return policy;
}

export function readAdmittedNetworkNpmPolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabPackageInstallResult<PtcLabOpenNetworkPolicyProjection> {
  const policy = readAdmittedLabPolicy(admission);
  if (!policy.ok) {
    return policy;
  }

  if (
    !hasEnabledNpmInstallPolicy(policy.value) ||
    policy.value.packageManager.installMode !== 'open_network' ||
    policy.value.network.mode !== 'open'
  ) {
    return packageInstallFailure(
      'ptc_lab_package_install_policy_disabled',
      'PTC lab network npm install policy is disabled',
    );
  }

  return {
    ok: true,
    value: {
      ...policy.value,
      network: policy.value.network,
    },
  };
}

export function validateCacheOnlyPackageInstallSession(args: {
  session: PtcLabPackageInstallSessionHandle | undefined;
  policy: PtcLabPolicyProjection;
}): PtcLabPackageInstallResult<PtcLabCacheOnlyPackageInstallSessionHandle> {
  const session = validateCommonPackageInstallSession(args);
  if (!session.ok) {
    return session;
  }

  if (
    session.value.installMode !== 'cache_only' ||
    session.value.networkMode !== 'disabled' ||
    args.policy.network.mode !== 'disabled' ||
    session.value.networkPolicyId !== args.policy.network.networkPolicyId ||
    session.value.networkInstallPolicyId !==
      PTC_LAB_NETWORK_INSTALL_DISABLED_POLICY_ID
  ) {
    return packageInstallFailure(
      'ptc_lab_package_install_policy_mismatch',
      'PTC lab package install session does not match admitted package install policy',
    );
  }

  return { ok: true, value: session.value };
}

export function validateNetworkPackageInstallSession(args: {
  session: PtcLabPackageInstallSessionHandle | undefined;
  policy: PtcLabPolicyProjection;
}): PtcLabPackageInstallResult<PtcLabNetworkPackageInstallSessionHandle> {
  const session = validateCommonPackageInstallSession(args);
  if (!session.ok) {
    return session;
  }

  if (
    session.value.installMode !== 'open_network' ||
    session.value.networkMode !== 'open' ||
    args.policy.network.mode !== 'open' ||
    session.value.networkPolicyId !== args.policy.network.networkPolicyId ||
    session.value.networkExplicitOptInPolicyId !==
      args.policy.network.explicitOptInPolicyId ||
    session.value.networkInstallPolicyId !== args.policy.network.networkPolicyId
  ) {
    return packageInstallFailure(
      'ptc_lab_package_install_policy_mismatch',
      'PTC lab package install session does not match admitted package install policy',
    );
  }

  return { ok: true, value: session.value };
}

export function validatePackageInstallRequest(args: {
  request: PtcLabCacheOnlyNpmInstallRequest | PtcLabNetworkNpmInstallRequest;
  policy: PtcLabPolicyProjection;
}): PtcLabPackageInstallResult<PtcLabValidatedNpmInstallRequest> {
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

export function buildNpmInstallArgs(args: {
  installMode: PtcLabPackageInstallModeForSmoke;
  containerId: string;
  installId: string;
  packages: PtcLabNpmExactPackage[];
}): string[] {
  const installWorkdir = `${PTC_LAB_NPM_INSTALL_WORKDIR_ROOT}/${args.installId}`;
  const npmArgs = [
    'npm',
    'install',
    ...(args.installMode === 'cache_only'
      ? ['--offline']
      : ['--prefer-online']),
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
  return [
    'exec',
    args.containerId,
    'sh',
    '-eu',
    '-c',
    [
      'install_workdir="$1"',
      'if [ -e "$install_workdir" ]; then',
      `  printf '%s\\n' '${PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_MARKER}' >&2`,
      `  exit ${PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_EXIT_CODE}`,
      'fi',
      'mkdir -p "$install_workdir"',
      ': > "$install_workdir/empty-npmrc"',
      ': > "$install_workdir/empty-global-npmrc"',
      'shift',
      'exec "$@"',
    ].join('\n'),
    'geulbat-package-install-preflight',
    installWorkdir,
    ...npmArgs,
  ];
}

function readAdmittedLabPolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabPackageInstallResult<PtcLabPolicyProjection> {
  if (
    admission === undefined ||
    admission.metadata.selectedProfile !== 'lab' ||
    admission.labPolicy === undefined
  ) {
    return packageInstallFailure(
      'ptc_lab_package_install_admission_required',
      'PTC lab package install requires an admitted lab profile',
    );
  }

  return { ok: true, value: admission.labPolicy };
}

function hasEnabledNpmInstallPolicy(policy: PtcLabPolicyProjection): boolean {
  return (
    policy.packageCache.enabled === true &&
    policy.packageCache.containerRoot ===
      PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT &&
    policy.packageCache.mountPolicyId ===
      PTC_SESSION_DOCKER_PACKAGE_CACHE_MOUNT_POLICY_ID &&
    policy.packageManager.enabled === true &&
    policy.packageManager.managers.includes('npm') &&
    policy.packageManager.lifecycleScripts.policy === 'disabled' &&
    policy.packageManager.lifecycleScripts.policyId ===
      PTC_LAB_LIFECYCLE_SCRIPTS_DISABLED_POLICY_ID &&
    policy.packageManager.maxInstallMs > 0 &&
    policy.packageManager.maxInstallOutputBytes > 0
  );
}

function validateCommonPackageInstallSession(args: {
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
    return packageInstallFailure(
      'ptc_lab_package_install_policy_mismatch',
      'PTC lab package install session does not match admitted package cache policy',
    );
  }

  return { ok: true, value: args.session };
}

function requestInvalid(): PtcLabPackageInstallResult<never> {
  return packageInstallFailure(
    'ptc_lab_package_install_request_invalid',
    'PTC lab npm install request is invalid',
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
