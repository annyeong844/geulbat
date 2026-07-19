import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

const DEFAULT_SMOKE_DEV_TOKEN = 'geulbat-smoke-token-123456';
const DAEMON_READY_TIMEOUT_MS = 30_000;
const DAEMON_READY_POLL_MS = 250;
const MAX_CAPTURED_LOG_LINES = 80;
const STOP_TIMEOUT_MS = 5_000;
const PUBLIC_WEB_CONFORMANCE_FIXTURES_ENV_NAME =
  'GEULBAT_PUBLIC_WEB_CONFORMANCE_FIXTURES';

const PLAYWRIGHT_RUNTIME_LIBRARY_PACKAGES = {
  'libnspr4.so': 'libnspr4',
  'libnss3.so': 'libnss3',
  'libnssutil3.so': 'libnss3',
  'libasound.so.2': 'libasound2t64',
};

export function startDaemon(args) {
  const {
    repoRoot,
    logs,
    port,
    watch = false,
    enablePublicWebConformanceFixtures = false,
  } = args;
  const daemonArgs = watch
    ? ['--watch', '--import', 'tsx', 'src/index.ts']
    : ['--import', 'tsx', 'src/index.ts'];
  const daemonEnvironment = { ...process.env };
  if (enablePublicWebConformanceFixtures) {
    daemonEnvironment[PUBLIC_WEB_CONFORMANCE_FIXTURES_ENV_NAME] = '1';
  } else {
    delete daemonEnvironment[PUBLIC_WEB_CONFORMANCE_FIXTURES_ENV_NAME];
  }
  const daemon = spawn('node', daemonArgs, {
    cwd: path.join(repoRoot, 'apps', 'daemon'),
    env: {
      ...daemonEnvironment,
      GEULBAT_DEV_TOKEN:
        process.env['GEULBAT_DEV_TOKEN'] ?? DEFAULT_SMOKE_DEV_TOKEN,
      GEULBAT_REPO_ROOT: repoRoot,
      ...(port === undefined ? {} : { PORT: String(port) }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  daemon.stdout?.on('data', (chunk) => pushLog(logs, String(chunk)));
  daemon.stderr?.on('data', (chunk) => pushLog(logs, String(chunk)));

  return daemon;
}

function pushLog(logs, chunk) {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    logs.push(line);
    if (logs.length > MAX_CAPTURED_LOG_LINES) {
      logs.shift();
    }
  }
}

export async function waitForDaemonReady(daemonHostUrl, logs) {
  const readyUrl =
    daemonHostUrl instanceof URL ? daemonHostUrl : new URL(daemonHostUrl);
  const timeoutAt = Date.now() + DAEMON_READY_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < timeoutAt) {
    try {
      const response = await fetch(readyUrl);
      if (response.ok) {
        return;
      }
      lastError = new Error(`daemon responded with ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(DAEMON_READY_POLL_MS);
  }

  const detail = logs.length > 0 ? `\n${logs.slice(-20).join('\n')}` : '';
  throw new Error(
    `daemon did not become ready at ${readyUrl.toString()}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }${detail}`,
  );
}

export async function resolveChromiumLaunchEnv(args) {
  const { repoRoot, tolerateMissingExecutable = false } = args;
  if (process.platform !== 'linux') {
    return process.env;
  }

  const executablePath = chromium.executablePath();
  if (tolerateMissingExecutable) {
    try {
      await fs.access(executablePath);
    } catch {
      return process.env;
    }
  }

  const missingLibraries = await readMissingSharedLibraries(executablePath);
  if (missingLibraries.length === 0) {
    return process.env;
  }

  const libraryRoot = await ensurePlaywrightRuntimeLibraries(
    repoRoot,
    missingLibraries,
  );
  return {
    ...process.env,
    LD_LIBRARY_PATH: joinLibrarySearchPath(
      libraryRoot,
      process.env['LD_LIBRARY_PATH'],
    ),
  };
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with code ${code}\n${stderr || stdout}`.trim(),
        ),
      );
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(undefined);
    });
  });
}

export async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(undefined))),
    delay(STOP_TIMEOUT_MS).then(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }),
  ]);
}

async function readMissingSharedLibraries(executablePath) {
  const { stdout } = await runCommand('ldd', [executablePath]);
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.includes('=> not found'))
    .map((line) => line.trim().split(/\s+/)[0]);
}

async function ensurePlaywrightRuntimeLibraries(repoRoot, missingLibraries) {
  const packageNames = Array.from(
    new Set(
      missingLibraries
        .map((library) => PLAYWRIGHT_RUNTIME_LIBRARY_PACKAGES[library])
        .filter(Boolean),
    ),
  );

  if (packageNames.length === 0) {
    throw new Error(
      `Playwright Chromium is missing unsupported runtime libraries: ${missingLibraries.join(', ')}`,
    );
  }

  const runtimeRoot = path.join(
    repoRoot,
    '.geulbat',
    'playwright-runtime-libs',
  );
  const debRoot = path.join(runtimeRoot, 'debs');
  const extractRoot = path.join(runtimeRoot, 'root');
  const libraryRoot = path.join(extractRoot, 'usr', 'lib', 'x86_64-linux-gnu');

  if (await hasAllRuntimeLibraries(libraryRoot, missingLibraries)) {
    return libraryRoot;
  }

  await fs.mkdir(debRoot, { recursive: true });
  await fs.mkdir(extractRoot, { recursive: true });

  await runCommand('apt', ['download', ...packageNames], { cwd: debRoot });

  const entries = await fs.readdir(debRoot);
  const debFiles = entries
    .filter((entry) =>
      packageNames.some((packageName) => entry.startsWith(`${packageName}_`)),
    )
    .map((entry) => path.join(debRoot, entry));

  for (const debFile of debFiles) {
    await runCommand('dpkg-deb', ['-x', debFile, extractRoot]);
  }

  if (!(await hasAllRuntimeLibraries(libraryRoot, missingLibraries))) {
    throw new Error(
      `Playwright Chromium runtime library extraction did not provide: ${missingLibraries.join(', ')}`,
    );
  }

  return libraryRoot;
}

async function hasAllRuntimeLibraries(libraryRoot, missingLibraries) {
  const checks = await Promise.all(
    missingLibraries.map((library) =>
      fs
        .access(path.join(libraryRoot, library))
        .then(() => true)
        .catch(() => false),
    ),
  );
  return checks.every(Boolean);
}

function joinLibrarySearchPath(libraryRoot, existing) {
  if (!existing || existing.trim() === '') {
    return libraryRoot;
  }
  return `${libraryRoot}:${existing}`;
}
