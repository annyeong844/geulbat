#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

export const DEFAULT_PTC_SESSION_IMAGE_REF =
  'local/geulbat-ptc-session:2026-05-31';
export const DEFAULT_PTC_SESSION_IMAGE_DOCKERFILE =
  'apps/daemon/docker/ptc-session/Dockerfile';
export const DEFAULT_PTC_SESSION_IMAGE_CONTEXT =
  'apps/daemon/docker/ptc-session';
export const DEFAULT_PLAYWRIGHT_IMAGE_FLAVOR = 'noble';

const DOCKER_CLIENT_ENV_KEYS = [
  'DOCKER_API_VERSION',
  'DOCKER_CERT_PATH',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_BUILDKIT',
];

const VERIFY_SCRIPT = `set -eu
command -v bash >/dev/null
command -v base64 >/dev/null
command -v python3 >/dev/null
python3 -m pip --version >/dev/null
node --version >/dev/null
node <<'NODE'
(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('data:text/html,<title>geulbat ptc browser image</title>');
  const title = await page.title();
  await browser.close();
  if (title !== 'geulbat ptc browser image') {
    throw new Error('ptc session browser image verification title mismatch');
  }
  console.log(JSON.stringify({
    ok: true,
    playwright: require.resolve('playwright'),
    chromium: chromium.executablePath(),
  }));
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
NODE`;

export function parseBuildPtcSessionImageArgs(input, defaults) {
  const options = {
    contextDir: defaults.contextDir,
    dockerfilePath: defaults.dockerfilePath,
    dryRun: false,
    imageRef: defaults.imageRef,
    playwrightImageFlavor: defaults.playwrightImageFlavor,
    playwrightVersion: defaults.playwrightVersion,
    skipBuild: false,
    verify: false,
  };

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];

    switch (current) {
      case '--image-ref':
        options.imageRef = readOptionValue(current, next);
        index += 1;
        break;
      case '--playwright-version':
        options.playwrightVersion = readOptionValue(current, next);
        index += 1;
        break;
      case '--playwright-image-flavor':
        options.playwrightImageFlavor = readOptionValue(current, next);
        index += 1;
        break;
      case '--dockerfile':
        options.dockerfilePath = readOptionValue(current, next);
        index += 1;
        break;
      case '--context':
        options.contextDir = readOptionValue(current, next);
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--skip-build':
        options.skipBuild = true;
        break;
      case '--verify':
        options.verify = true;
        break;
      case '--help':
        throw new Error(readUsage());
      default:
        throw new Error(`unknown argument: ${current}\n${readUsage()}`);
    }
  }

  return validateBuildPtcSessionImageOptions(options);
}

function validateBuildPtcSessionImageOptions(options) {
  const imageRef = String(options.imageRef).trim();
  if (!imageRef || /\s/u.test(imageRef)) {
    throw new Error(
      'invalid --image-ref; expected a non-empty Docker image ref',
    );
  }

  const playwrightVersion = String(options.playwrightVersion).trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(playwrightVersion)) {
    throw new Error(
      'invalid --playwright-version; expected a package version like 1.59.1',
    );
  }

  const playwrightImageFlavor = String(options.playwrightImageFlavor).trim();
  if (!/^[a-z][a-z0-9.-]*$/u.test(playwrightImageFlavor)) {
    throw new Error(
      'invalid --playwright-image-flavor; expected a Docker tag suffix like noble',
    );
  }

  return {
    contextDir: requireNonEmptyPath(options.contextDir, '--context'),
    dockerfilePath: requireNonEmptyPath(options.dockerfilePath, '--dockerfile'),
    dryRun: options.dryRun,
    imageRef,
    playwrightImageFlavor,
    playwrightVersion,
    skipBuild: options.skipBuild,
    verify: options.verify,
  };
}

export function buildPtcSessionImageDockerArgs(options) {
  return [
    'build',
    '--build-arg',
    `PLAYWRIGHT_VERSION=${options.playwrightVersion}`,
    '--build-arg',
    `PLAYWRIGHT_IMAGE_FLAVOR=${options.playwrightImageFlavor}`,
    '-t',
    options.imageRef,
    '-f',
    options.dockerfilePath,
    options.contextDir,
  ];
}

export function buildPtcSessionImageVerifyArgs(imageRef) {
  return ['run', '--rm', '--entrypoint', 'sh', imageRef, '-lc', VERIFY_SCRIPT];
}

export function createDockerClientEnv(sourceEnv = process.env) {
  return {
    PATH: sourceEnv.PATH ?? '',
    ...Object.fromEntries(
      DOCKER_CLIENT_ENV_KEYS.flatMap((key) => {
        const value = sourceEnv[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  };
}

export function readPlaywrightVersionFromPackageLock(lockfile) {
  const playwrightVersion =
    lockfile.packages?.['node_modules/playwright']?.version;
  const playwrightCoreVersion =
    lockfile.packages?.['node_modules/playwright-core']?.version;

  if (typeof playwrightVersion !== 'string') {
    throw new Error(
      'package-lock.json does not contain node_modules/playwright',
    );
  }
  if (playwrightCoreVersion !== playwrightVersion) {
    throw new Error(
      'package-lock.json playwright and playwright-core versions must match',
    );
  }
  return playwrightVersion;
}

async function readWorkspacePlaywrightVersion(repoRoot = REPO_ROOT) {
  const lockfile = JSON.parse(
    await readFile(path.join(repoRoot, 'package-lock.json'), 'utf8'),
  );
  return readPlaywrightVersionFromPackageLock(lockfile);
}

async function runBuildPtcSessionImageCli({
  argv = process.argv.slice(2),
  env = process.env,
  repoRoot = REPO_ROOT,
} = {}) {
  const playwrightVersion = await readWorkspacePlaywrightVersion(repoRoot);
  const options = parseBuildPtcSessionImageArgs(argv, {
    contextDir: path.join(repoRoot, DEFAULT_PTC_SESSION_IMAGE_CONTEXT),
    dockerfilePath: path.join(repoRoot, DEFAULT_PTC_SESSION_IMAGE_DOCKERFILE),
    imageRef: DEFAULT_PTC_SESSION_IMAGE_REF,
    playwrightImageFlavor: DEFAULT_PLAYWRIGHT_IMAGE_FLAVOR,
    playwrightVersion,
  });
  const dockerEnv = createDockerClientEnv(env);
  const commands = [];

  if (!options.skipBuild) {
    commands.push(buildPtcSessionImageDockerArgs(options));
  }
  if (options.verify) {
    commands.push(buildPtcSessionImageVerifyArgs(options.imageRef));
  }
  if (commands.length === 0) {
    throw new Error(
      '--skip-build was provided without --verify; nothing would run',
    );
  }

  if (options.dryRun) {
    for (const args of commands) {
      console.log(formatCommand('docker', args));
    }
    return;
  }

  for (const args of commands) {
    await runDockerCommand(args, dockerEnv);
  }
}

function requireNonEmptyPath(value, optionName) {
  const normalized = String(value).trim();
  if (!normalized) {
    throw new Error(`${optionName} is required`);
  }
  return normalized;
}

function readOptionValue(optionName, value) {
  if (typeof value !== 'string' || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function readUsage() {
  return [
    'usage: node scripts/build-ptc-session-image.mjs [options]',
    '',
    'Options:',
    `  --image-ref <ref>                 Docker tag to build (default: ${DEFAULT_PTC_SESSION_IMAGE_REF})`,
    '  --playwright-version <version>    Override package-lock Playwright version',
    `  --playwright-image-flavor <name>  Playwright image flavor (default: ${DEFAULT_PLAYWRIGHT_IMAGE_FLAVOR})`,
    `  --dockerfile <path>               Dockerfile path (default: ${DEFAULT_PTC_SESSION_IMAGE_DOCKERFILE})`,
    `  --context <path>                  Docker build context (default: ${DEFAULT_PTC_SESSION_IMAGE_CONTEXT})`,
    '  --verify                          Launch Chromium in the built image after build',
    '  --skip-build                      Only run verification against an existing image',
    '  --dry-run                         Print docker commands without running them',
  ].join('\n');
}

async function runDockerCommand(args, env) {
  console.log(formatCommand('docker', args));
  await new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `docker exited from signal ${signal}`
            : `docker exited with status ${code ?? 'unknown'}`,
        ),
      );
    });
  });
}

function formatCommand(command, args) {
  return [command, ...args].map(shellQuote).join(' ');
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBuildPtcSessionImageCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
