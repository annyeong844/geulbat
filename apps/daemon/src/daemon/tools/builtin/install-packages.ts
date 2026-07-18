import { z } from 'zod';
import {
  PTC_PACKAGE_INSTALL_TOOL_NAME,
  type PtcPackageInstallRuntimeFailureReason,
  type PtcPackageInstallRuntimeResult,
  type PtcPackageInstallRuntimeSummary,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { createRunContext } from '../../run-context.js';
import type { ErrorCode } from '../../error-codes.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';
import { resolvePtcExecuteCodeToolSdkProjection } from './execute-code-tool-callback.js';

// No timeoutMs field by contract (child spec §3.4): time budgets are operator
// env-knob territory, never model/schema territory.
const installPackagesArgsSchema = z.strictObject({
  packages: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1, 'package name is required.')
          .describe('npm package name (scoped names allowed).'),
        version: z
          .string()
          .optional()
          .describe(
            'Optional npm version spec: exact ("1.3.0"), range ("^1.3.0", "1.x", ">=1 <2"), or dist-tag ("latest", "next"). Omitted resolves to latest. URL/file/git/workspace specifiers are rejected.',
          ),
      }),
    )
    .min(1, 'at least one package is required.')
    .describe('npm packages to install from the live registry.'),
});

type InstallPackagesArgs = z.output<typeof installPackagesArgsSchema>;

export const installPackagesTool = defineZodTool({
  name: PTC_PACKAGE_INSTALL_TOOL_NAME,
  description:
    'Install exact-version npm packages from the live registry into the PTC lab session. Installed packages become available to exec code through CommonJS require(). Requires the operator package-install opt-in; lifecycle scripts stay disabled.',
  argsSchema: installPackagesArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  catalogSearchMetadata: {
    family: 'ptc',
    searchHints: [
      'install npm package',
      'add dependency',
      'npm install',
      'install packages for exec',
    ],
    tags: ['ptc', 'package', 'npm', 'install'],
    whenToUse:
      'Install npm packages so later exec code can require() them in the same PTC session.',
    notFor:
      'Version ranges or "latest" tags, pip/Playwright installs, or installing into the host filesystem.',
  },
  async executeParsed(args: InstallPackagesArgs, ctx) {
    if (!ctx.threadId || !ctx.stateRoot) {
      return toolError(
        'execution_failed',
        'run context is required for install_packages.',
      );
    }
    const runtime = ctx.agentSpawnRuntime?.ptcPackageInstall;
    if (!runtime) {
      return toolError(
        'execution_failed',
        'PTC package install runtime is required.',
      );
    }
    const sdkProjectionResult =
      await resolvePtcExecuteCodeToolSdkProjection(ctx);
    if (!sdkProjectionResult.ok) {
      return toolError('execution_failed', sdkProjectionResult.message);
    }

    const runtimeArgs = {
      runContext: createRunContext({
        threadId: ctx.threadId,
        stateRoot: ctx.stateRoot,
        workingDirectory: ctx.workingDirectory ?? '',
      }),
      request: {
        packages: args.packages.map((pkg) => ({
          name: pkg.name,
          ...(pkg.version === undefined ? {} : { version: pkg.version }),
        })),
      },
      ...(sdkProjectionResult.projection === undefined
        ? {}
        : { sdkProjection: sdkProjectionResult.projection }),
    };
    const result = await runtime.installPackages(
      ctx.signal === undefined
        ? runtimeArgs
        : { ...runtimeArgs, signal: ctx.signal },
    );
    if (!result.ok) {
      return {
        ok: false,
        output: stringifyInstallPackagesFailure(result),
        errorCode: installPackagesFailureToToolErrorCode(result.reasonCode),
        error: result.message,
      };
    }

    return {
      ok: true,
      output: stringifyInstallPackagesSummary(result.value),
    };
  },
});

function stringifyInstallPackagesSummary(
  summary: PtcPackageInstallRuntimeSummary,
): string {
  return JSON.stringify({
    kind: 'ptc_package_install_result',
    capabilityId: summary.capabilityId,
    labPolicyId: summary.labPolicyId,
    profile: summary.profile,
    manager: summary.manager,
    installMode: summary.installMode,
    packages: summary.packages,
    resolvedPackages: summary.resolvedPackages,
    exitCode: summary.exitCode,
    stdout: summary.stdout,
    stderr: summary.stderr,
    effectiveTimeoutMs: summary.effectiveTimeoutMs,
    durationMs: summary.durationMs,
    installedPackagesNodePath: summary.installedPackagesNodePath,
    sessionLifecycle: summary.sessionLifecycle,
    provenance: summary.provenance,
  });
}

function stringifyInstallPackagesFailure(
  failure: Extract<PtcPackageInstallRuntimeResult, { ok: false }>,
): string {
  return JSON.stringify({
    kind: 'ptc_package_install_error',
    reasonCode: failure.reasonCode,
    message: failure.message,
    diagnostics: sanitizeInstallFailureDiagnostics(failure.diagnostics),
  });
}

function sanitizeInstallFailureDiagnostics(
  diagnostics: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }
  const safe: Record<string, string | number | boolean> = {};
  for (const key of [
    'admissionReasonCode',
    'sessionReasonCode',
    'cleanupReasonCode',
    'requestAborted',
    'taintHookFailed',
    'sessionCloseFailed',
    'packageInstallRuntimeThrew',
    'stateRootRealpathFailed',
  ]) {
    const value = diagnostics[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function installPackagesFailureToToolErrorCode(
  reasonCode: PtcPackageInstallRuntimeFailureReason,
): ErrorCode {
  switch (reasonCode) {
    case 'ptc_package_install_request_invalid':
    case 'ptc_package_install_lab_admission_failed':
    case 'ptc_lab_admission_required':
    case 'ptc_lab_shell_disabled':
    case 'ptc_lab_policy_mismatch':
    case 'ptc_lab_command_invalid':
      return 'invalid_args';
    case 'ptc_package_install_disabled':
      return 'unsupported_mode';
    case 'ptc_lab_command_timeout':
      return 'timeout';
    case 'ptc_lab_command_cancelled':
      return 'aborted';
    case 'ptc_lab_session_busy':
      return 'conflict';
    case 'ptc_lab_interpreter_unavailable':
    case 'ptc_package_install_sdk_projection_invalid':
    case 'ptc_lab_session_unavailable':
    case 'ptc_lab_command_output_rejected':
    case 'ptc_lab_command_failed':
      return 'execution_failed';
  }
}
