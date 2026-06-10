import { buildPtcLabNetworkTelemetrySummary } from './lab-network-policy.js';
import type { PtcLabPolicyProjection } from './lab-profile.js';
import { sanitizePtcOutput } from './output-redaction.js';
import { runPtcSessionDockerCommand } from './session-docker-command.js';
import type { PtcSessionDockerCommandResult } from './session-docker-contract.js';
import {
  PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_EXIT_CODE,
  PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_MARKER,
  type PtcLabCacheOnlyNpmInstallSummary,
  type PtcLabCacheOnlyPackageInstallSessionHandle,
  type PtcLabNetworkNpmInstallSummary,
  type PtcLabNetworkPackageInstallSessionHandle,
  type PtcLabOpenNetworkPolicyProjection,
  type PtcLabPackageInstallResult,
  type PtcLabPackageInstallRunnerInvocation,
  type PtcLabPackageInstallRunnerResult,
  type PtcLabPackageInstallSessionHandle,
  type PtcLabValidatedNpmInstallRequest,
  type RunPtcLabCacheOnlyNpmInstallSmokeArgs,
  type RunPtcLabNetworkNpmInstallSmokeArgs,
  packageInstallFailure,
} from './lab-package-install-contract.js';

export async function runDefaultPackageInstallRunner(
  invocation: PtcLabPackageInstallRunnerInvocation,
): Promise<PtcLabPackageInstallRunnerResult> {
  const result: PtcSessionDockerCommandResult =
    await runPtcSessionDockerCommand(invocation);
  if (result.kind === 'exit') {
    if (
      result.exitCode === PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_EXIT_CODE &&
      result.stderr.includes(PTC_LAB_PACKAGE_INSTALL_WORKDIR_EXISTS_MARKER)
    ) {
      return {
        kind: 'workdir_exists',
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
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

export async function mapCacheOnlyRunnerResult(args: {
  runnerResult: PtcLabPackageInstallRunnerResult;
  runArgs: RunPtcLabCacheOnlyNpmInstallSmokeArgs;
  session: PtcLabCacheOnlyPackageInstallSessionHandle;
  policy: PtcLabPolicyProjection;
  request: PtcLabValidatedNpmInstallRequest;
  durationMs: number;
}): Promise<PtcLabPackageInstallResult<PtcLabCacheOnlyNpmInstallSummary>> {
  if (args.runnerResult.kind !== 'exit') {
    return await mapNonExitRunnerResult({
      runnerResult: args.runnerResult,
      runArgs: args.runArgs,
      session: args.session,
      installId: args.request.installId,
      installLabel: 'cache-only',
    });
  }

  const stdout = sanitizePtcOutput(
    args.runnerResult.stdout,
    args.request.outputExcerptByteLimit,
    { redactUrls: true },
  );
  const stderr = sanitizePtcOutput(
    args.runnerResult.stderr,
    args.request.outputExcerptByteLimit,
    { redactUrls: true },
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
      networkInstallPolicyId: args.session.networkInstallPolicyId,
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

export async function mapNetworkRunnerResult(args: {
  runnerResult: PtcLabPackageInstallRunnerResult;
  runArgs: RunPtcLabNetworkNpmInstallSmokeArgs;
  session: PtcLabNetworkPackageInstallSessionHandle;
  policy: PtcLabOpenNetworkPolicyProjection;
  request: PtcLabValidatedNpmInstallRequest;
  durationMs: number;
}): Promise<PtcLabPackageInstallResult<PtcLabNetworkNpmInstallSummary>> {
  if (args.runnerResult.kind !== 'exit') {
    return await mapNonExitRunnerResult({
      runnerResult: args.runnerResult,
      runArgs: args.runArgs,
      session: args.session,
      installId: args.request.installId,
      installLabel: 'network',
    });
  }

  const stdout = sanitizePtcOutput(
    args.runnerResult.stdout,
    args.request.outputExcerptByteLimit,
    { redactUrls: true },
  );
  const stderr = sanitizePtcOutput(
    args.runnerResult.stderr,
    args.request.outputExcerptByteLimit,
    { redactUrls: true },
  );
  const networkTelemetry = buildPtcLabNetworkTelemetrySummary({
    policy: args.policy.network,
    ownerKind: 'package_install',
    outcome: args.runnerResult.exitCode === 0 ? 'completed' : 'failed',
    networkOpened: true,
    durationMs: args.durationMs,
    metricsCoverage: 'owner_outcome_only',
  });

  return {
    ok: true,
    value: {
      manager: 'npm',
      installMode: 'open_network',
      installId: args.request.installId,
      packageCount: args.request.packages.length,
      packages: args.request.packages.map((pkg) => ({ ...pkg })),
      cacheIdentityHash: args.session.packageCacheIdentityHash,
      packageCacheId: args.session.packageCacheId,
      packageCacheMountPolicyId: args.session.packageCacheMountPolicyId,
      lifecycleScriptsPolicyId:
        args.policy.packageManager.lifecycleScripts.policyId,
      networkInstallPolicyId: args.session.networkInstallPolicyId,
      telemetryPolicyId: args.policy.packageManager.telemetryPolicyId,
      offline: false,
      lifecycleScripts: 'disabled',
      exitCode: args.runnerResult.exitCode,
      timedOut: false,
      durationMs: args.durationMs,
      networkTelemetry,
      stdout: stdout.value,
      stderr: stderr.value,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    },
  };
}

async function mapNonExitRunnerResult(args: {
  runnerResult: Exclude<PtcLabPackageInstallRunnerResult, { kind: 'exit' }>;
  runArgs:
    | RunPtcLabCacheOnlyNpmInstallSmokeArgs
    | RunPtcLabNetworkNpmInstallSmokeArgs;
  session: PtcLabPackageInstallSessionHandle;
  installId: string;
  installLabel: 'cache-only' | 'network';
}): Promise<PtcLabPackageInstallResult<never>> {
  switch (args.runnerResult.kind) {
    case 'timeout': {
      const taint = await maybeTaintSession({
        runArgs: args.runArgs,
        session: args.session,
        installId: args.installId,
        reasonCode: 'ptc_lab_package_install_timeout',
        processTerminated: args.runnerResult.processTerminated,
      });
      return packageInstallFailure(
        'ptc_lab_package_install_timeout',
        `PTC lab ${args.installLabel} npm install timed out`,
        taint.ok ? undefined : { sessionTaintCleanupFailed: true },
      );
    }
    case 'cancelled': {
      const taint = await maybeTaintSession({
        runArgs: args.runArgs,
        session: args.session,
        installId: args.installId,
        reasonCode: 'ptc_lab_package_install_cancelled',
        processTerminated: args.runnerResult.processTerminated,
      });
      return packageInstallFailure(
        'ptc_lab_package_install_cancelled',
        `PTC lab ${args.installLabel} npm install was cancelled`,
        taint.ok ? undefined : { sessionTaintCleanupFailed: true },
      );
    }
    case 'package_manager_unavailable':
      return packageInstallFailure(
        'ptc_lab_package_manager_unavailable',
        'PTC lab npm package manager is unavailable',
      );
    case 'workdir_exists':
      return packageInstallFailure(
        'ptc_lab_package_install_workdir_exists',
        'PTC lab package install workdir already exists',
      );
    case 'failed':
      return packageInstallFailure(
        'ptc_lab_package_install_failed',
        `PTC lab ${args.installLabel} npm install failed`,
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
  runArgs:
    | RunPtcLabCacheOnlyNpmInstallSmokeArgs
    | RunPtcLabNetworkNpmInstallSmokeArgs;
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
    await args.runArgs.onSessionTainted?.({
      reasonCode: args.reasonCode,
      installId: args.installId,
      containerId: args.session.containerId,
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
