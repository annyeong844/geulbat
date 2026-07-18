import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from '../../lab/packages/lab-package-cache-contract.js';
import { isSafeNpmPackageName } from '../../lab/packages/lab-package-install-policy.js';
import type { PtcLabAdmittedProfile } from '../../lab/profile/lab-profile.js';
import { adaptPtcSessionDockerCommandRunner } from '../../lab/shell/lab-command-execution.js';
import type {
  PtcSessionDockerCommandRunner,
  PtcSessionDockerIdentity,
} from '../../lab/session/session-docker-contract.js';
import { isPtcRecord } from '../../shared/record-shape.js';
import type { PtcExecuteCodePlacementBatchRunner } from './execute-code-placement.js';
import type { PtcExecuteCodePackageInstallRuntimeConfig } from './execute-code-package-install-config.js';
import {
  PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH,
  PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX,
  PTC_PACKAGE_INSTALL_TOOL_NAME,
  type PtcPackageInstallRequestedPackage,
  type PtcPackageInstallResolvedPackage,
  type PtcPackageInstallRuntimeRequest,
  type PtcPackageInstallRuntimeResult,
} from './execute-code-runtime-contract.js';

const PTC_PACKAGE_INSTALL_PROVENANCE_DIRNAME = 'package-provenance';
const PTC_NPM_VERSION_SPEC_MAX_LEN = 256;
const PTC_NPM_DEFAULT_VERSION_SPEC = 'latest';

// Registry version ranges and dist-tags only. The charset excludes ':' and '/'
// (which blocks file:/git+https:/github:owner/repo/./local source specifiers)
// and quotes/backticks/'$'/';' (which keeps the value safe inside the
// single-quoted npm argv). Slice 2 relaxes the slice-1 exact-semver-only rule
// to exact versions, ranges (^1.3.0, 1.x, ">=1 <2", "^1 || ^2"), and dist-tags
// (latest, next, beta).
export function isSafeNpmVersionSpec(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= PTC_NPM_VERSION_SPEC_MAX_LEN &&
    /^[A-Za-z0-9.^~><=|*\-+_ ]+$/u.test(value)
  );
}

type EnabledPtcExecuteCodePackageInstallConfig = Extract<
  PtcExecuteCodePackageInstallRuntimeConfig,
  { enabled: true }
>;

interface PtcPackageInstallProvenanceEntry {
  path: string;
  name: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  role: 'prod' | 'dev' | 'optional';
}

export function decodePtcPackageInstallProvenanceEntries(
  value: unknown,
): PtcPackageInstallProvenanceEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const candidates: unknown[] = value;
  const entries: PtcPackageInstallProvenanceEntry[] = [];
  for (const candidate of candidates) {
    if (!isPtcPackageInstallProvenanceEntry(candidate)) {
      return undefined;
    }
    entries.push({
      path: candidate.path,
      name: candidate.name,
      ...(candidate.version === undefined
        ? {}
        : { version: candidate.version }),
      ...(candidate.resolved === undefined
        ? {}
        : { resolved: candidate.resolved }),
      ...(candidate.integrity === undefined
        ? {}
        : { integrity: candidate.integrity }),
      role: candidate.role,
    });
  }
  return entries;
}

function isPtcPackageInstallProvenanceEntry(
  value: unknown,
): value is PtcPackageInstallProvenanceEntry {
  return (
    isPtcRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.name === 'string' &&
    (value.version === undefined || typeof value.version === 'string') &&
    (value.resolved === undefined || typeof value.resolved === 'string') &&
    (value.integrity === undefined || typeof value.integrity === 'string') &&
    (value.role === 'prod' || value.role === 'dev' || value.role === 'optional')
  );
}

interface RunPtcExecuteCodePackageInstallArgs {
  admission: PtcLabAdmittedProfile;
  identity: PtcSessionDockerIdentity;
  batchRunner: PtcExecuteCodePlacementBatchRunner;
  request: PtcPackageInstallRuntimeRequest;
  config: EnabledPtcExecuteCodePackageInstallConfig;
  runtimeRoot: string;
  commandRunner?: PtcSessionDockerCommandRunner;
  dockerPath?: string;
  signal?: AbortSignal;
  now?: () => number;
}

// Effective spec sent to npm: the requested version or 'latest' when omitted.
export interface PtcValidatedInstallPackage {
  name: string;
  spec: string;
}

export function validatePtcPackageInstallRequest(args: {
  request: PtcPackageInstallRuntimeRequest;
  maxPackages: number;
}):
  | { ok: true; value: PtcValidatedInstallPackage[] }
  | Extract<PtcPackageInstallRuntimeResult, { ok: false }> {
  const packages = args.request.packages;
  if (
    !Array.isArray(packages) ||
    packages.length === 0 ||
    packages.length > args.maxPackages
  ) {
    return requestInvalid();
  }

  const seenNames = new Set<string>();
  const validated: PtcValidatedInstallPackage[] = [];
  for (const pkg of packages) {
    if (typeof pkg?.name !== 'string' || !isSafeNpmPackageName(pkg.name)) {
      return requestInvalid();
    }
    if (pkg.version !== undefined && typeof pkg.version !== 'string') {
      return requestInvalid();
    }
    const spec =
      pkg.version === undefined || pkg.version.length === 0
        ? PTC_NPM_DEFAULT_VERSION_SPEC
        : pkg.version;
    if (!isSafeNpmVersionSpec(spec) || seenNames.has(pkg.name)) {
      return requestInvalid();
    }
    seenNames.add(pkg.name);
    validated.push({ name: pkg.name, spec });
  }
  validated.sort((first, second) => first.name.localeCompare(second.name));
  return { ok: true, value: validated };
}

export function buildPtcPackageInstallCommand(
  packages: PtcValidatedInstallPackage[],
): string {
  const prefix = PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX;
  return [
    'set -eu',
    `mkdir -p '${prefix}'`,
    `: > '${prefix}/.empty-npmrc'`,
    `: > '${prefix}/.empty-global-npmrc'`,
    [
      'npm install',
      '--prefer-online',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `--cache '${PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT}/npm'`,
      `--userconfig '${prefix}/.empty-npmrc'`,
      `--globalconfig '${prefix}/.empty-global-npmrc'`,
      `--prefix '${prefix}'`,
      ...packages.map((pkg) => `'${pkg.name}@${pkg.spec}'`),
    ].join(' '),
  ].join('\n');
}

// Reads the cumulative prefix lockfile inside the container and emits the full
// installed dependency closure as one JSON line (child spec §6.3: closure, not
// only top-level requests). Daemon-authored; double quotes only so the shell
// single-quote envelope stays intact.
export function buildPtcPackageInstallProvenanceCommand(): string {
  const script = [
    `const lock = require("${PTC_EXECUTE_CODE_INSTALLED_PACKAGES_PREFIX}/package-lock.json");`,
    'const entries = Object.entries(lock.packages || {})',
    '  .filter(([path]) => path !== "")',
    '  .map(([path, meta]) => ({',
    '    path,',
    '    name: (meta && meta.name) || path.split("node_modules/").pop(),',
    '    version: meta && meta.version,',
    '    resolved: meta && meta.resolved,',
    '    integrity: meta && meta.integrity,',
    '    role: meta && meta.dev ? "dev" : meta && meta.optional ? "optional" : "prod",',
    '  }));',
    'process.stdout.write(JSON.stringify(entries));',
  ].join('\n');
  return `node -e '${script}'`;
}

// Model-visible npm excerpts must not expose URLs or hostnames (contract §6.2).
// Redact full URLs first, then bare registry hostnames that npm can print in
// diagnostics such as `getaddrinfo ENOTFOUND registry.npmjs.org`. The hostname
// pattern requires two or more dotted labels plus a letter TLD, so it does not
// touch versions (1.3.0) or single-dot package names (lodash.merge).
export function redactNetworkIdentifiersFromExcerpt(excerpt: string): string {
  return excerpt
    .replaceAll(/https?:\/\/\S+/gu, '[redacted-url]')
    .replaceAll(
      /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){2,}[a-z]{2,24}\b/giu,
      '[redacted-host]',
    );
}

export async function runPtcExecuteCodePackageInstall(
  args: RunPtcExecuteCodePackageInstallArgs,
): Promise<PtcPackageInstallRuntimeResult> {
  const validated = validatePtcPackageInstallRequest({
    request: args.request,
    maxPackages: args.config.maxPackages,
  });
  if (!validated.ok) {
    return validated;
  }

  const now = args.now ?? Date.now;
  const start = now();
  const runner =
    args.commandRunner === undefined
      ? undefined
      : adaptPtcSessionDockerCommandRunner(args.commandRunner);
  let execution: Awaited<
    ReturnType<
      PtcExecuteCodePlacementBatchRunner['runPtcLabSessionBatchCommand']
    >
  >;
  try {
    execution = await args.batchRunner.runPtcLabSessionBatchCommand({
      admission: args.admission,
      identity: args.identity,
      request: {
        command: buildPtcPackageInstallCommand(validated.value),
        timeoutMs: args.config.maxInstallMs,
      },
      ...(runner === undefined ? {} : { runner }),
      ...(args.dockerPath === undefined ? {} : { dockerPath: args.dockerPath }),
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
  } catch {
    return {
      ok: false,
      reasonCode: 'ptc_lab_command_failed',
      message: 'PTC package install command failed',
      diagnostics: { packageInstallRuntimeThrew: true },
    };
  }
  if (!execution.ok) {
    return execution;
  }

  const requestedPackages: PtcPackageInstallRequestedPackage[] =
    validated.value.map((pkg) => ({ name: pkg.name, version: pkg.spec }));
  const closure = await observePtcPackageInstallClosure({
    ...args,
    installSucceeded: execution.value.exitCode === 0,
  });
  const provenance = await writePtcPackageInstallProvenanceRecord({
    runtimeRoot: args.runtimeRoot,
    labPolicyId: args.admission.labPolicy?.policyId,
    requestedPackages,
    installSucceeded: execution.value.exitCode === 0,
    closure,
  });

  return {
    ok: true,
    value: {
      ok: true,
      capabilityId: PTC_PACKAGE_INSTALL_TOOL_NAME,
      labPolicyId: execution.value.policyId,
      profile: 'lab',
      manager: 'npm',
      installMode: 'open_network',
      packages: requestedPackages,
      resolvedPackages: derivePtcResolvedPackages({
        packages: validated.value,
        closure: closure.entries,
      }),
      exitCode: execution.value.exitCode,
      stdout: redactNetworkIdentifiersFromExcerpt(execution.value.stdout),
      stderr: redactNetworkIdentifiersFromExcerpt(execution.value.stderr),
      effectiveTimeoutMs: execution.value.effectiveTimeoutMs,
      durationMs: Math.max(0, now() - start),
      installedPackagesNodePath: PTC_EXECUTE_CODE_INSTALLED_PACKAGES_NODE_PATH,
      sessionLifecycle: {
        mode: 'runtime_owned_reusable',
        retainedAfterExecution: true,
      },
      provenance,
    },
  };
}

interface PtcPackageInstallClosure {
  observation: 'observed' | 'observation_failed' | 'skipped_failed_install';
  entries: PtcPackageInstallProvenanceEntry[];
}

// Maps each requested top-level package to the exact version npm resolved it to,
// read from the installed dependency closure (path === node_modules/<name>).
export function derivePtcResolvedPackages(args: {
  packages: PtcValidatedInstallPackage[];
  closure: PtcPackageInstallProvenanceEntry[];
}): PtcPackageInstallResolvedPackage[] {
  return args.packages.map((pkg) => {
    const entry = args.closure.find(
      (candidate) => candidate.path === `node_modules/${pkg.name}`,
    );
    return {
      name: pkg.name,
      requestedSpec: pkg.spec,
      resolvedVersion: entry?.version ?? null,
      integrity: entry?.integrity ?? null,
    };
  });
}

async function observePtcPackageInstallClosure(
  args: RunPtcExecuteCodePackageInstallArgs & { installSucceeded: boolean },
): Promise<PtcPackageInstallClosure> {
  if (!args.installSucceeded) {
    return { observation: 'skipped_failed_install', entries: [] };
  }
  const runner =
    args.commandRunner === undefined
      ? undefined
      : adaptPtcSessionDockerCommandRunner(args.commandRunner);
  try {
    const observed = await args.batchRunner.runPtcLabSessionBatchCommand({
      admission: args.admission,
      identity: args.identity,
      request: {
        command: buildPtcPackageInstallProvenanceCommand(),
        timeoutMs: args.config.maxInstallMs,
      },
      ...(runner === undefined ? {} : { runner }),
      ...(args.dockerPath === undefined ? {} : { dockerPath: args.dockerPath }),
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (observed.ok && observed.value.exitCode === 0) {
      const parsed: unknown = JSON.parse(observed.value.stdout);
      const entries = decodePtcPackageInstallProvenanceEntries(parsed);
      if (entries !== undefined) {
        return {
          observation: 'observed',
          entries,
        };
      }
    }
  } catch {
    return { observation: 'observation_failed', entries: [] };
  }
  return { observation: 'observation_failed', entries: [] };
}

async function writePtcPackageInstallProvenanceRecord(args: {
  runtimeRoot: string;
  labPolicyId: string | undefined;
  requestedPackages: PtcPackageInstallRequestedPackage[];
  installSucceeded: boolean;
  closure: PtcPackageInstallClosure;
}): Promise<{ recorded: boolean; dependencyClosureCount: number }> {
  const installId = `install-${randomUUID()}`;
  try {
    const provenanceDir = join(
      args.runtimeRoot,
      PTC_PACKAGE_INSTALL_PROVENANCE_DIRNAME,
    );
    await mkdir(provenanceDir, { recursive: true });
    await writeFile(
      join(provenanceDir, `${installId}.json`),
      `${JSON.stringify(
        {
          installId,
          labPolicyId: args.labPolicyId,
          requestedPackages: args.requestedPackages,
          installSucceeded: args.installSucceeded,
          closureObservation: args.closure.observation,
          dependencyClosure: args.closure.entries,
          recordedAt: new Date().toISOString(),
        },
        undefined,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    return {
      recorded: true,
      dependencyClosureCount: args.closure.entries.length,
    };
  } catch {
    return { recorded: false, dependencyClosureCount: 0 };
  }
}

function requestInvalid(): Extract<
  PtcPackageInstallRuntimeResult,
  { ok: false }
> {
  return {
    ok: false,
    reasonCode: 'ptc_package_install_request_invalid',
    message: 'PTC package install request is invalid',
  };
}
