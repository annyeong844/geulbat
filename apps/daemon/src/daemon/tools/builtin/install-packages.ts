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
import type { AgentRuntimePtcServices } from '../../daemon-runtime-contract.js';

// This tool depends only on its own PTC runtime; keep the declared
// service surface that narrow.
type InstallPackagesToolServices = {
  ptc: Pick<AgentRuntimePtcServices, 'packageInstall'>;
};

// No timeoutMs field by contract (child spec §3.4): time budgets are operator
// env-knob territory, never model/schema territory.
const installPackagesArgsSchema = z.strictObject({
  language: z
    .enum(['javascript', 'python'])
    .optional()
    .describe(
      'Omit or use "javascript" for npm. Use "python" for wheel-only PyPI installation that becomes importable by Python exec in the same PTC session.',
    ),
  packages: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1, 'package name is required.')
          .describe(
            'Registry package name. npm scoped names are supported for JavaScript; Python accepts bare PyPI distribution names.',
          ),
        version: z
          .string()
          .optional()
          .describe(
            'Optional registry version spec. npm accepts exact/range/dist-tag forms. Python accepts an exact version or a comma-separated PEP 440 comparison such as ">=1.3,<2". Omitted resolves to latest. URL/file/git/workspace/direct-reference specifiers are rejected.',
          ),
      }),
    )
    .min(1, 'at least one package is required.')
    .describe('Packages to install from npm or PyPI.'),
});

type InstallPackagesArgs = z.output<typeof installPackagesArgsSchema>;

export const installPackagesTool = defineZodTool({
  name: PTC_PACKAGE_INSTALL_TOOL_NAME,
  description:
    'Install npm or wheel-only PyPI packages from the live registry into this PTC lab session. JavaScript exec loads npm packages with CommonJS require() or explicit-ESM static imports; Python exec imports installed wheels normally. Requires the operator opt-in. npm lifecycle scripts and Python source distributions stay disabled.',
  argsSchema: installPackagesArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  recoveryStrategy: 'replay_safe',
  catalogSearchMetadata: {
    family: 'ptc',
    searchHints: [
      'install npm package',
      'add dependency',
      'npm install',
      'install python package',
      'pip install',
      'pypi wheel',
      'install packages for exec',
      'esm package import',
    ],
    tags: ['ptc', 'package', 'npm', 'pip', 'python', 'install'],
    whenToUse:
      'Install npm packages for JavaScript exec or wheel-backed PyPI packages for Python exec in the same PTC session.',
    notFor:
      'URL/file/git/workspace/direct-reference specifiers, Python source distributions, Playwright installs, lifecycle scripts, or host installs.',
  },
  async executeParsed(args: InstallPackagesArgs, ctx) {
    if (!ctx.threadId || !ctx.stateRoot) {
      return toolError(
        'execution_failed',
        'run context is required for install_packages.',
      );
    }
    const services: InstallPackagesToolServices | undefined =
      ctx.runtimeServices;
    const runtime = services?.ptc.packageInstall;
    if (!runtime) {
      return toolError(
        'execution_failed',
        'PTC package install runtime is required.',
      );
    }
    const sdkProjectionResult =
      args.language === 'python'
        ? ({ ok: true, projection: undefined } as const)
        : await resolvePtcExecuteCodeToolSdkProjection(ctx);
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
        ...(args.language === undefined ? {} : { language: args.language }),
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
    ...(summary.manager === 'npm'
      ? { installedPackagesNodePath: summary.installedPackagesNodePath }
      : {
          installedPackagesPythonPath: summary.installedPackagesPythonPath,
        }),
    language: summary.language,
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
