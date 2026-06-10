import {
  type PtcLabCacheOnlyNpmInstallSummary,
  type PtcLabNetworkNpmInstallSummary,
  type PtcLabPackageInstallResult,
  type PtcLabPackageInstallRunnerResult,
  type RunPtcLabCacheOnlyNpmInstallSmokeArgs,
  type RunPtcLabNetworkNpmInstallSmokeArgs,
  packageInstallFailure,
} from './lab-package-install-contract.js';
import {
  buildNpmInstallArgs,
  readAdmittedCacheOnlyNpmPolicy,
  readAdmittedNetworkNpmPolicy,
  validateCacheOnlyPackageInstallSession,
  validateNetworkPackageInstallSession,
  validatePackageInstallRequest,
} from './lab-package-install-policy.js';
import {
  mapCacheOnlyRunnerResult,
  mapNetworkRunnerResult,
  runDefaultPackageInstallRunner,
} from './lab-package-install-result.js';

export async function runPtcLabCacheOnlyNpmInstallSmoke(
  args: RunPtcLabCacheOnlyNpmInstallSmokeArgs,
): Promise<PtcLabPackageInstallResult<PtcLabCacheOnlyNpmInstallSummary>> {
  const policy = readAdmittedCacheOnlyNpmPolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }

  const session = validateCacheOnlyPackageInstallSession({
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
        installMode: 'cache_only',
        containerId: session.value.containerId,
        installId: request.value.installId,
        packages: request.value.packages,
      }),
      timeoutMs: request.value.effectiveTimeoutMs,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch {
    return packageInstallFailure(
      'ptc_lab_package_install_failed',
      'PTC lab package install runner failed',
    );
  }

  return await mapCacheOnlyRunnerResult({
    runnerResult,
    runArgs: args,
    session: session.value,
    policy: policy.value,
    request: request.value,
    durationMs: Math.max(0, (args.now ?? Date.now)() - start),
  });
}

export async function runPtcLabNetworkNpmInstallSmoke(
  args: RunPtcLabNetworkNpmInstallSmokeArgs,
): Promise<PtcLabPackageInstallResult<PtcLabNetworkNpmInstallSummary>> {
  const policy = readAdmittedNetworkNpmPolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }

  const session = validateNetworkPackageInstallSession({
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
        installMode: 'open_network',
        containerId: session.value.containerId,
        installId: request.value.installId,
        packages: request.value.packages,
      }),
      timeoutMs: request.value.effectiveTimeoutMs,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch {
    return packageInstallFailure(
      'ptc_lab_package_install_failed',
      'PTC lab package install runner failed',
    );
  }

  return await mapNetworkRunnerResult({
    runnerResult,
    runArgs: args,
    session: session.value,
    policy: policy.value,
    request: request.value,
    durationMs: Math.max(0, (args.now ?? Date.now)() - start),
  });
}
