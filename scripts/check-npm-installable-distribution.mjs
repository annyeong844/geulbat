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
  readApprovedProviderAuthClientIdFile,
  validateProviderAuthReleaseArtifact,
} from './provider-auth-release-validation.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

const PACKAGE_WORKSPACES = [
  {
    manifestPath: 'packages/agent-loop/package.json',
    name: '@geulbat/agent-loop',
  },
  {
    manifestPath: 'packages/artifact-runtime-policy/package.json',
    name: '@geulbat/artifact-runtime-policy',
  },
  {
    manifestPath: 'packages/content-identity/package.json',
    name: '@geulbat/content-identity',
  },
  {
    manifestPath: 'packages/structured-logger/package.json',
    name: '@geulbat/structured-logger',
  },
  {
    manifestPath: 'packages/protocol/package.json',
    name: '@geulbat/protocol',
  },
  {
    manifestPath: 'packages/tool-library/package.json',
    name: '@geulbat/tool-library',
  },
  {
    manifestPath: 'packages/tool-sdk/package.json',
    name: '@geulbat/tool-sdk',
  },
  {
    manifestPath: 'apps/daemon/package.json',
    name: '@geulbat/daemon',
  },
];

const ENV_KEYS_TO_SANITIZE = [
  'PROVIDER_AUTH_CLIENT_ID',
  'PROVIDER_AUTH_CLIENT_SECRET',
  'GEULBAT_PROVIDER_AUTH_INSTALLED_CONFIG_PATH',
  'GEULBAT_PROVIDER_AUTH_BUNDLED_CONFIG_PATH',
  'GEULBAT_PROVIDER_AUTH_FILE_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'TS_NODE_PROJECT',
  'TS_NODE_TRANSPILE_ONLY',
];

export function parseCheckNpmInstallableDistributionArgs(input) {
  let approvedClientIdFile = null;
  const approvedClientIds = [];
  let keepTemp = false;
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
      case '--skip-build':
        skipBuild = true;
        break;
      case '--help':
        throw new Error(readUsage());
      default:
        throw new Error(`unknown argument: ${current}\n${readUsage()}`);
    }
  }

  if (approvedClientIds.length === 0 && !approvedClientIdFile) {
    throw new Error(
      `--approved-client-id or --approved-client-id-file is required\n${readUsage()}`,
    );
  }

  return {
    approvedClientIdFile,
    approvedClientIds,
    keepTemp,
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
  const tempRoot = await mkdtemp(
    path.join(tmpdir(), 'geulbat-npm-installable-'),
  );
  const packDir = path.join(tempRoot, 'pack');
  const installDir = path.join(tempRoot, 'install');
  const toolSdkInstallDir = path.join(tempRoot, 'tool-sdk-consumer');
  const homeDir = path.join(tempRoot, 'home');
  const childEnv = createNpmInstallableDistributionChildEnv({
    env: options.env,
    homeDir,
  });

  try {
    await mkdir(packDir, { recursive: true });
    await mkdir(installDir, { recursive: true });
    await mkdir(toolSdkInstallDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });

    if (!options.skipBuild) {
      await runCommand('npm', ['run', 'build:packages'], {
        cwd: REPO_ROOT,
        env: childEnv,
      });
      await runCommand('npm', ['run', 'build:app', '-w', 'apps/daemon'], {
        cwd: REPO_ROOT,
        env: childEnv,
      });
    }

    const packedPackages = await packWorkspacePackages(packDir, childEnv);
    await validatePackedPackages(packedPackages);
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

async function packWorkspacePackages(packDir, env) {
  const { stdout } = await runCommand(
    'npm',
    [
      'pack',
      '--json',
      '--pack-destination',
      packDir,
      '-w',
      'packages/agent-loop',
      '-w',
      'packages/artifact-runtime-policy',
      '-w',
      'packages/content-identity',
      '-w',
      'packages/structured-logger',
      '-w',
      'packages/protocol',
      '-w',
      'packages/tool-library',
      '-w',
      'packages/tool-sdk',
      '-w',
      'apps/daemon',
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

async function validatePackedPackages(packageInfos) {
  for (const workspace of PACKAGE_WORKSPACES) {
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

async function validateInstalledDaemonProviderAuth(args) {
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
        "await import('@geulbat/artifact-runtime-policy/react-bundle-url');",
        "await import('@geulbat/content-identity/sha256');",
        "await import('@geulbat/content-identity/stable-json');",
        "await import('@geulbat/protocol/provider-auth');",
        "await import('@geulbat/structured-logger/logger');",
        "await import('@geulbat/tool-sdk');",
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

async function validateInstalledToolSdkConsumer(args) {
  const consumerSource = `
import {
  TOOL_SDK_RELEASE,
  createToolSdkClient,
  type ListFilesInput,
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
const result = await client.readFile({ path: 'consumer.txt', limit: 1 });
if (!result.ok || result.value.content !== 'clean consumer\\n') {
  throw new Error(result.ok ? 'unexpected output' : result.error.code);
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
    '  node scripts/check-npm-installable-distribution.mjs (--approved-client-id <client-id> | --approved-client-id-file <path>) [--skip-build] [--keep-temp]',
    '',
    'Repeat --approved-client-id for each approved release-channel client id.',
    'Use --approved-client-id-file to read tracked release metadata.',
  ].join('\n');
}

async function main() {
  const options = parseCheckNpmInstallableDistributionArgs(
    process.argv.slice(2),
  );
  const approvedClientIds = [
    ...options.approvedClientIds,
    ...(options.approvedClientIdFile
      ? await readApprovedProviderAuthClientIdFile(options.approvedClientIdFile)
      : []),
  ];
  const result = await runNpmInstallableDistributionCheck({
    approvedClientIds,
    env: process.env,
    keepTemp: options.keepTemp,
    skipBuild: options.skipBuild,
  });

  console.log('npm installable distribution validation passed');
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
