#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { collectNpmPackageValidationViolations } from './npm-installable-distribution-validation.mjs';
import {
  MODULE_RESOLUTION_ENV_OVERRIDES,
  PROVIDER_AUTH_ENV_OVERRIDES,
} from './provider-auth-release-validation.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

const PACKAGE_WORKSPACES = [
  {
    manifestPath: 'packages/agent-loop/package.json',
    name: '@geulbat/agent-loop',
    workspacePath: 'packages/agent-loop',
    xharnessRelease: true,
  },
  {
    manifestPath: 'packages/xharness/package.json',
    name: '@geulbat/xharness',
    workspacePath: 'packages/xharness',
    xharnessRelease: true,
  },
  {
    manifestPath: 'packages/artifact-runtime-policy/package.json',
    name: '@geulbat/artifact-runtime-policy',
    workspacePath: 'packages/artifact-runtime-policy',
  },
  {
    manifestPath: 'packages/content-identity/package.json',
    name: '@geulbat/content-identity',
    workspacePath: 'packages/content-identity',
    xharnessRelease: true,
  },
  {
    manifestPath: 'packages/daemon-lifecycle/package.json',
    name: '@geulbat/daemon-lifecycle',
    workspacePath: 'packages/daemon-lifecycle',
  },
  {
    manifestPath: 'packages/structured-logger/package.json',
    name: '@geulbat/structured-logger',
    workspacePath: 'packages/structured-logger',
  },
  {
    manifestPath: 'packages/protocol/package.json',
    name: '@geulbat/protocol',
    workspacePath: 'packages/protocol',
  },
  {
    manifestPath: 'packages/tool-library/package.json',
    name: '@geulbat/tool-library',
    workspacePath: 'packages/tool-library',
    xharnessRelease: true,
  },
  {
    manifestPath: 'packages/tool-sdk/package.json',
    name: '@geulbat/tool-sdk',
    workspacePath: 'packages/tool-sdk',
    xharnessRelease: true,
  },
  {
    manifestPath: 'apps/daemon/package.json',
    name: '@geulbat/daemon',
    workspacePath: 'apps/daemon',
  },
];

// 검증기가 "설정되어 있으면 위반"이라고 판정하는 값들은 그대로 위생 처리
// 대상이다. 두 목록이 갈라지면 개발자 환경의 정상 설정이 게이트를 깨뜨리므로
// 목록을 복제하지 않고 검증기에서 가져온다.
const ENV_KEYS_TO_SANITIZE = [
  ...PROVIDER_AUTH_ENV_OVERRIDES,
  ...MODULE_RESOLUTION_ENV_OVERRIDES,
];

export function parseCheckNpmInstallableDistributionArgs(input) {
  let approvedClientIdFile = null;
  const approvedClientIds = [];
  let keepTemp = false;
  let scope = 'all';
  let skipBuild = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];

    switch (current) {
      case '--approved-client-id':
        approvedClientIds.push(readOptionValue(current, next));
        index += 1;
        break;
      case '--approved-client-id-file':
        approvedClientIdFile = readOptionValue(current, next);
        index += 1;
        break;
      case '--keep-temp':
        keepTemp = true;
        break;
      case '--scope':
        scope = readOptionValue(current, next);
        index += 1;
        break;
      case '--skip-build':
        skipBuild = true;
        break;
      case '--help':
        throw new Error(readUsage());
      default:
        throw new Error(`unknown argument: ${current}\n${readUsage()}`);
    }
  }

  if (scope !== 'all' && scope !== 'xharness') {
    throw new Error(`--scope must be all or xharness\n${readUsage()}`);
  }
  if (
    scope === 'all' &&
    approvedClientIds.length === 0 &&
    !approvedClientIdFile
  ) {
    throw new Error(
      `--approved-client-id or --approved-client-id-file is required\n${readUsage()}`,
    );
  }
  if (
    scope === 'xharness' &&
    (approvedClientIds.length > 0 || approvedClientIdFile)
  ) {
    throw new Error(
      `--scope xharness does not accept provider auth release options\n${readUsage()}`,
    );
  }

  return {
    approvedClientIdFile,
    approvedClientIds,
    keepTemp,
    scope,
    skipBuild,
  };
}

export function createNpmInstallableDistributionChildEnv(options) {
  const env = { ...(options.env ?? process.env) };
  for (const key of ENV_KEYS_TO_SANITIZE) {
    delete env[key];
  }
  env.HOME = options.homeDir;
  env.USERPROFILE = options.homeDir;
  env.npm_config_cache = path.join(options.homeDir, '.npm-cache');
  return env;
}

async function runNpmInstallableDistributionCheck(options) {
  const xharnessOnly = options.scope === 'xharness';
  const packageWorkspaces = xharnessOnly
    ? PACKAGE_WORKSPACES.filter(
        (workspace) => workspace.xharnessRelease === true,
      )
    : PACKAGE_WORKSPACES;
  const tempRoot = await mkdtemp(
    path.join(tmpdir(), 'geulbat-npm-installable-'),
  );
  const packDir = path.join(tempRoot, 'pack');
  const installDir = path.join(tempRoot, 'install');
  const xharnessInstallDir = path.join(tempRoot, 'xharness-consumer');
  const toolSdkInstallDir = path.join(tempRoot, 'tool-sdk-consumer');
  const homeDir = path.join(tempRoot, 'home');
  const childEnv = createNpmInstallableDistributionChildEnv({
    env: options.env,
    homeDir,
  });

  try {
    await mkdir(packDir, { recursive: true });
    await mkdir(installDir, { recursive: true });
    await mkdir(xharnessInstallDir, { recursive: true });
    await mkdir(toolSdkInstallDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });

    if (!options.skipBuild) {
      await runCommand(
        'npm',
        ['run', xharnessOnly ? 'build:xharness-release' : 'build:packages'],
        {
          cwd: REPO_ROOT,
          env: childEnv,
        },
      );
      if (!xharnessOnly) {
        await runCommand('npm', ['run', 'build:app', '-w', 'apps/daemon'], {
          cwd: REPO_ROOT,
          env: childEnv,
        });
      }
    }

    const packedPackages = await packWorkspacePackages(
      packDir,
      childEnv,
      packageWorkspaces,
    );
    await validatePackedPackages(packedPackages, packageWorkspaces);
    await installPackedXHarness({
      childEnv,
      installDir: xharnessInstallDir,
      packDir,
      packedPackages,
    });
    await validateInstalledXHarnessConsumer({
      childEnv,
      installDir: xharnessInstallDir,
    });

    if (xharnessOnly) {
      return {
        installDir: xharnessInstallDir,
        packDir,
      };
    }

    await installPackedPackages({
      childEnv,
      installDir,
      packDir,
      packedPackages,
    });
    await installPackedToolSdk({
      childEnv,
      installDir: toolSdkInstallDir,
      packDir,
      packedPackages,
    });
    await validateInstalledDaemonProviderAuth({
      approvedClientIds: options.approvedClientIds,
      childEnv,
      homeDir,
      installDir,
    });
    await validateInstalledRuntimeImports({
      childEnv,
      installDir,
    });
    await validateInstalledToolSdkConsumer({
      childEnv,
      installDir: toolSdkInstallDir,
    });

    return {
      installDir,
      packDir,
    };
  } finally {
    if (!options.keepTemp) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function packWorkspacePackages(packDir, env, packageWorkspaces) {
  const { stdout } = await runCommand(
    'npm',
    [
      'pack',
      '--json',
      '--pack-destination',
      packDir,
      ...packageWorkspaces.flatMap((workspace) => [
        '-w',
        workspace.workspacePath,
      ]),
    ],
    {
      cwd: REPO_ROOT,
      env,
    },
  );
  const packageInfos = JSON.parse(stdout);
  if (!Array.isArray(packageInfos)) {
    throw new Error('npm pack did not return a package list');
  }
  return packageInfos;
}

async function validatePackedPackages(packageInfos, packageWorkspaces) {
  for (const workspace of packageWorkspaces) {
    const packageInfo = readPackageInfo(packageInfos, workspace.name);
    const manifest = await readJson(
      path.join(REPO_ROOT, workspace.manifestPath),
    );
    const violations = collectNpmPackageValidationViolations({
      files: packageInfo.files.map((file) => file.path),
      manifest,
    });

    if (violations.length > 0) {
      throw new Error(
        `${workspace.name} npm package validation failed:\n${formatViolations(
          violations,
        )}`,
      );
    }

    console.log(
      `${workspace.name}: ${packageInfo.entryCount} packed files validated`,
    );
  }
}

async function installPackedPackages(args) {
  await runCommand('npm', ['init', '-y'], {
    cwd: args.installDir,
    env: args.childEnv,
  });
  await runCommand(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--package-lock=false',
      readTarballPath(args.packedPackages, '@geulbat/agent-loop', args.packDir),
      readTarballPath(args.packedPackages, '@geulbat/xharness', args.packDir),
      readTarballPath(
        args.packedPackages,
        '@geulbat/artifact-runtime-policy',
        args.packDir,
      ),
      readTarballPath(
        args.packedPackages,
        '@geulbat/content-identity',
        args.packDir,
      ),
      readTarballPath(
        args.packedPackages,
        '@geulbat/structured-logger',
        args.packDir,
      ),
      readTarballPath(args.packedPackages, '@geulbat/protocol', args.packDir),
      readTarballPath(
        args.packedPackages,
        '@geulbat/tool-library',
        args.packDir,
      ),
      readTarballPath(args.packedPackages, '@geulbat/tool-sdk', args.packDir),
      readTarballPath(args.packedPackages, '@geulbat/daemon', args.packDir),
    ],
    {
      cwd: args.installDir,
      env: args.childEnv,
    },
  );
}

async function installPackedToolSdk(args) {
  await runCommand('npm', ['init', '-y'], {
    cwd: args.installDir,
    env: args.childEnv,
  });
  await runCommand(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--package-lock=false',
      readTarballPath(args.packedPackages, '@geulbat/tool-sdk', args.packDir),
    ],
    {
      cwd: args.installDir,
      env: args.childEnv,
    },
  );
}

async function installPackedXHarness(args) {
  await runCommand('npm', ['init', '-y'], {
    cwd: args.installDir,
    env: args.childEnv,
  });
  await runCommand(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--package-lock=false',
      readTarballPath(
        args.packedPackages,
        '@geulbat/content-identity',
        args.packDir,
      ),
      readTarballPath(args.packedPackages, '@geulbat/agent-loop', args.packDir),
      readTarballPath(
        args.packedPackages,
        '@geulbat/tool-library',
        args.packDir,
      ),
      readTarballPath(args.packedPackages, '@geulbat/tool-sdk', args.packDir),
      readTarballPath(args.packedPackages, '@geulbat/xharness', args.packDir),
    ],
    {
      cwd: args.installDir,
      env: args.childEnv,
    },
  );
}

async function validateInstalledDaemonProviderAuth(args) {
  const { validateProviderAuthReleaseArtifact } =
    await import('./provider-auth-release-validation.mjs');
  await validateProviderAuthReleaseArtifact({
    approvedClientIds: args.approvedClientIds,
    artifactRoot: path.join(
      args.installDir,
      'node_modules',
      '@geulbat',
      'daemon',
    ),
    bundledConfigPath: 'provider-auth.config.json',
    env: args.childEnv,
    homeDir: args.homeDir,
  });
  console.log('provider auth release validation passed');
}

async function validateInstalledRuntimeImports(args) {
  await runCommand(
    process.execPath,
    [
      '-e',
      [
        "await import('@geulbat/agent-loop/kernel');",
        "await import('@geulbat/xharness/harness-snapshot');",
        "await import('@geulbat/xharness/harness-run-store');",
        "await import('@geulbat/xharness/run-trace');",
        "await import('@geulbat/xharness/run-trace-comparison');",
        "const { runXHarnessComparison } = await import('@geulbat/xharness/runner');",
        "if (typeof runXHarnessComparison !== 'function') throw new Error('installed xHarness comparison runner is unavailable');",
        "await import('@geulbat/artifact-runtime-policy/react-bundle-url');",
        "await import('@geulbat/content-identity/sha256');",
        "await import('@geulbat/content-identity/stable-json');",
        "await import('@geulbat/protocol/provider-auth');",
        "await import('@geulbat/structured-logger/logger');",
        "await import('@geulbat/tool-sdk');",
        "await import('@geulbat/daemon/run-evidence');",
        "await import('./node_modules/@geulbat/daemon/dist/daemon/auth/bootstrap/config.js');",
      ].join(' '),
    ],
    {
      cwd: args.installDir,
      env: args.childEnv,
    },
  );
  console.log('installed runtime imports passed');
}

async function validateInstalledXHarnessConsumer(args) {
  const consumerSource = `
import type { AgentLoopKernelPorts } from '@geulbat/agent-loop/kernel';
import {
  TOOL_SDK_RELEASE,
  createToolSdkClient,
  type ListFilesInput,
  type ToolSdkTransport,
} from '@geulbat/tool-sdk';
import { createXHarnessFileRunStore } from '@geulbat/xharness/harness-run-store';
import { createHarnessConfigSnapshot } from '@geulbat/xharness/harness-snapshot';
import { compareHarnessRunTraces } from '@geulbat/xharness/run-trace-comparison';
import {
  parseHarnessRunTrace,
  serializeHarnessRunTrace,
} from '@geulbat/xharness/run-trace';
import {
  runXHarness,
  runXHarnessComparison,
} from '@geulbat/xharness/runner';

interface RunResult {
  readonly ok: boolean;
  readonly text: string;
}

interface ToolCall {
  readonly publicTool: 'files.list';
  readonly input: ListFilesInput;
}

type ConsumerPorts = AgentLoopKernelPorts<RunResult, never, never, never>;
type ToolConsumerPorts = AgentLoopKernelPorts<
  RunResult,
  ToolCall,
  never,
  string
>;

const ignore = () => undefined;

function createPorts(result: RunResult): ConsumerPorts {
  return {
    getHistoryItemCount: () => 0,
    async runModelRound() {
      if (!result.ok) {
        return { ok: false, result };
      }
      return {
        ok: true,
        value: {
          assistantText: result.text,
          terminalResult: result,
          functionCalls: [],
        },
      };
    },
    async processStructuredOutputs() {
      return { ok: true, handled: false };
    },
    appendAssistantText: ignore,
    appendHistoryItems: ignore,
    appendFunctionCalls: ignore,
    async processFunctionCalls() {
      return { ok: true, value: undefined };
    },
    createTerminalFailure(failure) {
      return { ok: false, text: failure.message };
    },
    settleTerminal: ignore,
  };
}

const toolCredential = 'ephemeral-xharness-consumer';
const projection = {
  schemaVersion: TOOL_SDK_RELEASE.projectionSchemaVersion,
  sdkProjectionHash: ${JSON.stringify(`sha256:${'d'.repeat(64)}`)},
  policyId: 'xharness-consumer-v1',
} as const;
const toolTransport: ToolSdkTransport = {
  async handshake(request) {
    return {
      ok: true,
      value: {
        compatibility: request.compatibility,
        capabilities: ['tool.invoke'],
        publicTools: [...request.requestedPublicTools],
      },
    };
  },
  async invoke(request) {
    if (request.publicTool !== 'files.list') {
      throw new Error('unexpected public tool');
    }
    return {
      ok: true,
      value: {
        kind: 'inline',
        value: {
          path: request.input.path ?? '.',
          total: 1,
          entries: [
            { name: 'consumer.txt', path: 'consumer.txt', type: 'file' },
          ],
          internalBinding: 'must-not-escape',
        },
      },
    };
  },
};
const toolClient = createToolSdkClient({
  projection,
  requestedPublicTools: ['files.list'],
  transport: toolTransport,
  credentialProvider: {
    async getCredential() {
      return { scheme: 'Bearer', value: toolCredential };
    },
  },
});
const connection = await toolClient.connect();
if (!connection.ok) {
  throw new Error(connection.error.code);
}

const history: string[] = [];
let invocationCount = 0;
let listedPath: string | undefined;
const toolPorts: ToolConsumerPorts = {
  getHistoryItemCount: () => history.length,
  async runModelRound(context) {
    if (context.round === 0) {
      return {
        ok: true,
        value: {
          assistantText: 'listing files',
          terminalResult: { ok: true, text: 'tool pending' },
          functionCalls: [
            {
              publicTool: 'files.list',
              input: { path: '.', recursive: false },
            },
          ],
        },
      };
    }
    if (context.round === 1 && listedPath !== undefined) {
      return {
        ok: true,
        value: {
          assistantText: 'listing complete',
          terminalResult: { ok: true, text: listedPath },
          functionCalls: [],
        },
      };
    }
    return {
      ok: false,
      result: { ok: false, text: 'unexpected model round' },
    };
  },
  async processStructuredOutputs() {
    return { ok: true, handled: false };
  },
  appendAssistantText({ text }) {
    history.push('assistant:' + text);
  },
  appendHistoryItems(items) {
    history.push(...items);
  },
  appendFunctionCalls(functionCalls) {
    history.push(...functionCalls.map((call) => 'tool:' + call.publicTool));
  },
  async processFunctionCalls({ functionCalls }) {
    for (const call of functionCalls) {
      const listing = await toolClient.listFiles(call.input);
      if (
        !listing.ok ||
        listing.value.total !== 1 ||
        listing.value.entries[0]?.path !== 'consumer.txt' ||
        'internalBinding' in listing.value
      ) {
        return {
          ok: false,
          result: {
            ok: false,
            text: listing.ok ? 'unexpected listing' : listing.error.code,
          },
        };
      }
      invocationCount += 1;
      listedPath = listing.value.entries[0].path;
      history.push('tool-result:' + listedPath);
    }
    return { ok: true, value: undefined };
  },
  createTerminalFailure(failure) {
    return { ok: false, text: failure.message };
  },
  settleTerminal: ignore,
};

const harnessSnapshot = createHarnessConfigSnapshot({
  harnessId: 'standalone-consumer',
  harnessVersion: 'v1',
  config: { traceMode: 'portable_events' },
});
const integratedRun = await runXHarness({
  harnessSnapshot,
  traceIdentity: {
    taskId: 'external-tool-task',
    attemptId: 'external-tool-attempt',
    modelConfigId: 'external-model-config',
  },
  ports: toolPorts,
});
if (
  !integratedRun.result.ok ||
  integratedRun.result.text !== 'consumer.txt' ||
  invocationCount !== 1
) {
  throw new Error('standalone xHarness Tool SDK result is invalid');
}
const eventKinds = integratedRun.trace.events.map((event) => event.kind);
const expectedEventKinds = [
  'round_started',
  'model_call_started',
  'model_call_completed',
  'structured_outputs_started',
  'structured_outputs_completed',
  'tool_calls_started',
  'tool_calls_completed',
  'round_completed',
  'round_started',
  'model_call_started',
  'model_call_completed',
  'structured_outputs_started',
  'structured_outputs_completed',
  'round_completed',
];
if (JSON.stringify(eventKinds) !== JSON.stringify(expectedEventKinds)) {
  throw new Error('standalone xHarness Tool SDK event order is invalid');
}
const serializedTrace = JSON.stringify(integratedRun.trace);
if (
  serializedTrace.includes('files.list') ||
  serializedTrace.includes('consumer.txt') ||
  serializedTrace.includes(toolCredential) ||
  serializedTrace.includes('must-not-escape')
) {
  throw new Error('standalone xHarness trace leaked Tool SDK content');
}
const reparsedTrace = parseHarnessRunTrace(
  serializeHarnessRunTrace(integratedRun.trace),
);
const directTraceComparison = compareHarnessRunTraces(
  integratedRun.trace,
  reparsedTrace,
);
if (
  reparsedTrace.traceId !== integratedRun.trace.traceId ||
  !directTraceComparison.identical ||
  directTraceComparison.identityDifferences.length !== 0 ||
  directTraceComparison.eventDifferences.length !== 0 ||
  directTraceComparison.outcomeDifferences.length !== 0 ||
  typeof createXHarnessFileRunStore !== 'function'
) {
  throw new Error('standalone xHarness public subpath contract is invalid');
}

const comparison = await runXHarnessComparison({
  baseline: {
    harnessSnapshot,
    traceIdentity: {
      taskId: 'external-task',
      attemptId: 'external-baseline',
      modelConfigId: 'external-model-config',
    },
    ports: createPorts({ ok: true, text: 'baseline success' }),
  },
  candidate: {
    harnessSnapshot,
    traceIdentity: {
      taskId: 'external-task',
      attemptId: 'external-candidate',
      modelConfigId: 'external-model-config',
    },
    ports: createPorts({ ok: false, text: 'candidate failure' }),
  },
});
if (!comparison.baseline.result.ok || comparison.candidate.result.ok) {
  throw new Error('standalone xHarness results are invalid');
}
if (
  comparison.traceComparison.identityDifferences.length !== 1 ||
  comparison.traceComparison.identityDifferences[0] !== 'attemptId' ||
  comparison.traceComparison.eventDifferences.length === 0 ||
  comparison.traceComparison.outcomeDifferences.join(',') !==
    'ok,terminalSource'
) {
  throw new Error('standalone xHarness trace comparison is invalid');
}
`;
  await writeFile(
    path.join(args.installDir, 'consumer.mts'),
    consumerSource,
    'utf8',
  );
  await writeFile(
    path.join(args.installDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          outDir: 'consumer-dist',
          skipLibCheck: false,
          strict: true,
          target: 'ES2022',
          types: [],
        },
        files: ['consumer.mts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await runCommand(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc'),
      '--project',
      'tsconfig.json',
    ],
    { cwd: args.installDir, env: args.childEnv },
  );
  await runCommand(
    process.execPath,
    [path.join(args.installDir, 'consumer-dist', 'consumer.mjs')],
    { cwd: args.installDir, env: args.childEnv },
  );
  console.log('standalone xHarness + Tool SDK typed consumer passed');
}

async function validateInstalledToolSdkConsumer(args) {
  const consumerSource = `
import {
  TOOL_SDK_RELEASE,
  createToolSdkClient,
  type ListFilesInput,
  type SearchFilesInput,
  type ToolSdkTransport,
} from '@geulbat/tool-sdk';

const projection = {
  schemaVersion: TOOL_SDK_RELEASE.projectionSchemaVersion,
  sdkProjectionHash: ${JSON.stringify(`sha256:${'e'.repeat(64)}`)},
  policyId: 'clean-consumer-v1',
} as const;
const transport: ToolSdkTransport = {
  async handshake(request) {
    return {
      ok: true,
      value: {
        compatibility: request.compatibility,
        capabilities: ['tool.invoke'],
        publicTools: [...request.requestedPublicTools],
      },
    };
  },
  async invoke(request) {
    if (request.publicTool === 'files.read') {
      return {
        ok: true,
        value: {
          kind: 'inline',
          value: {
            path: request.input.path ?? '',
            content: 'clean consumer\\n',
            versionToken: 'clean-consumer-version',
            totalLines: 1,
            pageLimit: request.input.limit ?? 0,
            startLine: 1,
            endLine: 1,
            hasMore: false,
            nextOffset: null,
          },
        },
      };
    }
    if (request.publicTool === 'files.list') {
      return {
        ok: true,
        value: {
          kind: 'inline',
          value: {
            path: request.input.path ?? '.',
            total: 1,
            entries: [
              { name: 'consumer.txt', path: 'consumer.txt', type: 'file' },
            ],
            internalBinding: 'must-not-escape',
          },
        },
      };
    }
    if (request.publicTool === 'files.search') {
      return {
        ok: true,
        value: {
          kind: 'inline',
          value: {
            path: request.input.path ?? '.',
            type: 'content',
            consistency: 'filesystem_snapshot',
            total: 1,
            totalRelation: 'exact',
            truncated: false,
            results: [
              { path: 'consumer.txt', line: 1, text: 'clean consumer' },
            ],
            backend: 'must-not-escape',
          },
        },
      };
    }
    throw new Error('unexpected public tool');
  },
};
const client = createToolSdkClient({
  projection,
  transport,
  credentialProvider: {
    async getCredential() {
      return { scheme: 'Bearer', value: 'ephemeral-clean-consumer' };
    },
  },
});
const connection = await client.connect();
if (!connection.ok) {
  throw new Error(connection.error.code);
}
const listInput: ListFilesInput = { recursive: false };
const listing = await client.listFiles(listInput);
if (
  !listing.ok ||
  listing.value.total !== 1 ||
  listing.value.entries[0]?.path !== 'consumer.txt' ||
  'internalBinding' in listing.value
) {
  throw new Error(listing.ok ? 'unexpected listing' : listing.error.code);
}
const searchInput: SearchFilesInput = {
  pattern: 'clean consumer',
  path: '.',
  type: 'content',
  maxResults: 1,
};
const search = await client.searchFiles(searchInput);
if (
  !search.ok ||
  search.value.total !== 1 ||
  search.value.results[0]?.path !== 'consumer.txt' ||
  'backend' in search.value
) {
  throw new Error(search.ok ? 'unexpected search' : search.error.code);
}
const result = await client.readFile({ path: 'consumer.txt', limit: 1 });
if (!result.ok || result.value.content !== 'clean consumer\\n') {
  throw new Error(result.ok ? 'unexpected output' : result.error.code);
}
`;
  await writeFile(
    path.join(args.installDir, 'consumer.mts'),
    consumerSource,
    'utf8',
  );
  await writeFile(
    path.join(args.installDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          outDir: 'consumer-dist',
          skipLibCheck: false,
          strict: true,
          target: 'ES2022',
          types: [],
        },
        files: ['consumer.mts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await runCommand(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc'),
      '--project',
      'tsconfig.json',
    ],
    { cwd: args.installDir, env: args.childEnv },
  );
  await runCommand(
    process.execPath,
    [path.join(args.installDir, 'consumer-dist', 'consumer.mjs')],
    { cwd: args.installDir, env: args.childEnv },
  );
  console.log('standalone Tool SDK typed consumer passed');
}

function readTarballPath(packageInfos, packageName, packDir) {
  const packageInfo = readPackageInfo(packageInfos, packageName);
  return path.join(packDir, packageInfo.filename);
}

function readPackageInfo(packageInfos, packageName) {
  const packageInfo = packageInfos.find((info) => info.name === packageName);
  if (!packageInfo) {
    throw new Error(`npm pack output is missing ${packageName}`);
  }
  return packageInfo;
}

async function runCommand(command, args, options) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: 1024 * 1024 * 20,
  });
  return result;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function readOptionValue(name, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value\n${readUsage()}`);
  }
  return value;
}

function formatViolations(violations) {
  return violations
    .map((violation) => `${violation.code}: ${violation.message}`)
    .join('\n');
}

function readUsage() {
  return [
    'Usage:',
    '  node scripts/check-npm-installable-distribution.mjs --scope xharness [--skip-build] [--keep-temp]',
    '  node scripts/check-npm-installable-distribution.mjs [--scope all] (--approved-client-id <client-id> | --approved-client-id-file <path>) [--skip-build] [--keep-temp]',
    '',
    'The xharness scope builds, packs, installs, type-checks, and runs only the external xHarness chain plus its direct Tool SDK consumer dependency.',
    'Repeat --approved-client-id for each approved release-channel client id.',
    'Use --approved-client-id-file to read tracked release metadata.',
  ].join('\n');
}

async function main() {
  const options = parseCheckNpmInstallableDistributionArgs(
    process.argv.slice(2),
  );
  const approvedClientIds = [...options.approvedClientIds];
  if (options.approvedClientIdFile) {
    const { readApprovedProviderAuthClientIdFile } =
      await import('./provider-auth-release-validation.mjs');
    approvedClientIds.push(
      ...(await readApprovedProviderAuthClientIdFile(
        options.approvedClientIdFile,
      )),
    );
  }
  const result = await runNpmInstallableDistributionCheck({
    approvedClientIds,
    env: process.env,
    keepTemp: options.keepTemp,
    scope: options.scope,
    skipBuild: options.skipBuild,
  });

  console.log(
    options.scope === 'xharness'
      ? 'xHarness npm installable distribution validation passed'
      : 'npm installable distribution validation passed',
  );
  if (options.keepTemp) {
    console.log(`packdir=${result.packDir}`);
    console.log(`installdir=${result.installDir}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
