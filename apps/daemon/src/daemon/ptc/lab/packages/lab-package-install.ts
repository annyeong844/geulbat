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

type PtcLabNpmInstallSmokeArgs =
  | RunPtcLabCacheOnlyNpmInstallSmokeArgs
  | RunPtcLabNetworkNpmInstallSmokeArgs;

type PtcLabNpmInstallPolicy = Parameters<
  typeof validatePackageInstallRequest
>[0]['policy'];

type PtcLabNpmInstallMode = Parameters<
  typeof buildNpmInstallArgs
>[0]['installMode'];

// Inactive npm-install smoke scaffold: package-cache substrate may be reused,
// but these entrypoints need a product lane owner before promotion.
export async function runPtcLabCacheOnlyNpmInstallSmoke(
  args: RunPtcLabCacheOnlyNpmInstallSmokeArgs,
): Promise<PtcLabPackageInstallResult<PtcLabCacheOnlyNpmInstallSummary>> {
  return await runPtcLabNpmInstallSmoke({
    args,
    installMode: 'cache_only',
    readPolicy: readAdmittedCacheOnlyNpmPolicy,
    validateSession: validateCacheOnlyPackageInstallSession,
    mapRunnerResult: mapCacheOnlyRunnerResult,
  });
}

export async function runPtcLabNetworkNpmInstallSmoke(
  args: RunPtcLabNetworkNpmInstallSmokeArgs,
): Promise<PtcLabPackageInstallResult<PtcLabNetworkNpmInstallSummary>> {
  return await runPtcLabNpmInstallSmoke({
    args,
    installMode: 'open_network',
    readPolicy: readAdmittedNetworkNpmPolicy,
    validateSession: validateNetworkPackageInstallSession,
    mapRunnerResult: mapNetworkRunnerResult,
  });
}

async function runPtcLabNpmInstallSmoke<
  Args extends PtcLabNpmInstallSmokeArgs,
  Policy extends PtcLabNpmInstallPolicy,
  Session extends { containerId: string },
  Summary,
>(config: {
  args: Args;
  installMode: PtcLabNpmInstallMode;
  readPolicy: (
    admission: Args['admission'],
  ) => PtcLabPackageInstallResult<Policy>;
  validateSession: (args: {
    session: Args['session'];
    policy: Policy;
  }) => PtcLabPackageInstallResult<Session>;
  mapRunnerResult: (args: {
    runnerResult: PtcLabPackageInstallRunnerResult;
    runArgs: Args;
    session: Session;
    policy: Policy;
    request: Parameters<typeof mapCacheOnlyRunnerResult>[0]['request'];
    durationMs: number;
  }) => Promise<PtcLabPackageInstallResult<Summary>>;
}): Promise<PtcLabPackageInstallResult<Summary>> {
  const { args } = config;
  const policy = config.readPolicy(args.admission);
  if (!policy.ok) {
    return policy;
  }

  const session = config.validateSession({
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
        installMode: config.installMode,
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

  return await config.mapRunnerResult({
    runnerResult,
    runArgs: args,
    session: session.value,
    policy: policy.value,
    request: request.value,
    durationMs: Math.max(0, (args.now ?? Date.now)() - start),
  });
}
