import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface PlaywrightChromiumRuntime {
  chromium: {
    executablePath(): string;
  };
}

let nativePlaywrightEntryPromise: Promise<string> | undefined;
let nativePlaywrightRuntimeRoot: string | undefined;

process.once('exit', () => {
  if (nativePlaywrightRuntimeRoot !== undefined) {
    rmSync(nativePlaywrightRuntimeRoot, { recursive: true, force: true });
  }
});

export const PTC_BROWSER_RUNTIME_SCRIPT_FAKE_PLAYWRIGHT_MODULE = `
let currentUrl = 'about:blank';

function responseFor(url) {
  return {
    status: () => 204,
    request: () => ({
      url: () => url,
      redirectedFrom: () => null,
    }),
  };
}

function createContext() {
  return {
    on: () => undefined,
    newPage: async () => ({
      on: () => undefined,
      goto: async (url) => {
        currentUrl = url;
        return responseFor(url);
      },
      waitForLoadState: async () => undefined,
      url: () => currentUrl,
      title: async () => 'Example Title',
      evaluate: async () => 'Example visible text',
      close: async () => undefined,
    }),
    pages: () => [],
    close: async () => undefined,
  };
}

exports.chromium = {
  launch: async () => ({
    newContext: async () => createContext(),
    close: async () => undefined,
  }),
};
`;

interface PtcBrowserRuntimeScriptRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  jsonLines: unknown[];
}

async function resolveWorkspaceChromiumExecutablePath(): Promise<
  string | undefined
> {
  const requireFromHere = createRequire(import.meta.url);
  let playwright: PlaywrightChromiumRuntime;
  try {
    const workspaceEntry = requireFromHere.resolve('playwright');
    const runtimeEntry =
      await resolveWorkspacePlaywrightRuntimeEntry(workspaceEntry);
    playwright = requireFromHere(runtimeEntry) as PlaywrightChromiumRuntime;
  } catch {
    return undefined;
  }
  const defaultPath = playwright.chromium.executablePath();
  if (exists(defaultPath)) {
    return defaultPath;
  }
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0,
  );
  return candidates.find((candidate) => exists(candidate));
}

export async function hasWorkspacePlaywrightChromium(): Promise<boolean> {
  return (await resolveWorkspaceChromiumExecutablePath()) !== undefined;
}

async function resolveWorkspacePlaywrightRuntimeEntry(
  workspaceEntry: string,
): Promise<string> {
  if (!isWslMountedPath(workspaceEntry)) {
    return workspaceEntry;
  }
  nativePlaywrightEntryPromise ??=
    materializePlaywrightModulesOnNativeFilesystem(workspaceEntry);
  return await nativePlaywrightEntryPromise;
}

function isWslMountedPath(path: string): boolean {
  return (
    process.platform === 'linux' &&
    (process.env['WSL_DISTRO_NAME'] !== undefined ||
      existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) &&
    /^\/mnt\/[a-z]\//iu.test(path)
  );
}

async function materializePlaywrightModulesOnNativeFilesystem(
  workspaceEntry: string,
): Promise<string> {
  const playwrightRoot = dirname(workspaceEntry);
  const sourceNodeModulesRoot = dirname(playwrightRoot);
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-playwright-runtime-'),
  );
  const targetNodeModulesRoot = join(runtimeRoot, 'node_modules');
  await mkdir(targetNodeModulesRoot, { recursive: true });
  const copied = await copyPlaywrightModulesWithTar({
    sourceNodeModulesRoot,
    targetNodeModulesRoot,
  });
  if (!copied) {
    await rm(runtimeRoot, { recursive: true, force: true });
    return workspaceEntry;
  }
  nativePlaywrightRuntimeRoot = runtimeRoot;
  return join(targetNodeModulesRoot, 'playwright', 'index.js');
}

async function copyPlaywrightModulesWithTar(args: {
  sourceNodeModulesRoot: string;
  targetNodeModulesRoot: string;
}): Promise<boolean> {
  const pack = spawn(
    'tar',
    [
      '-C',
      args.sourceNodeModulesRoot,
      '-cf',
      '-',
      'playwright',
      'playwright-core',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const unpack = spawn('tar', ['-C', args.targetNodeModulesRoot, '-xf', '-'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  pack.stdout.pipe(unpack.stdin);
  const [packExitCode, unpackExitCode] = await Promise.all([
    waitForProcessExit(pack),
    waitForProcessExit(unpack),
  ]);
  return packExitCode === 0 && unpackExitCode === 0;
}

async function waitForProcessExit(
  child: ReturnType<typeof spawn>,
): Promise<number> {
  return await new Promise<number>((resolve) => {
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
}

export async function runPtcBrowserRuntimeScript(args: {
  script: string;
  input: unknown;
  playwrightModuleSource?: string;
  useWorkspacePlaywright?: boolean;
  timeoutMs?: number;
}): Promise<PtcBrowserRuntimeScriptRunResult> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'geulbat-ptc-browser-'));
  try {
    const inputPath = join(runtimeRoot, 'input.json');
    await writeFile(inputPath, JSON.stringify(args.input), 'utf8');
    if (args.playwrightModuleSource !== undefined) {
      const playwrightModuleRoot = join(
        runtimeRoot,
        'node_modules',
        'playwright',
      );
      await mkdir(playwrightModuleRoot, { recursive: true });
      await writeFile(
        join(playwrightModuleRoot, 'index.js'),
        args.playwrightModuleSource,
        'utf8',
      );
    } else if (args.useWorkspacePlaywright === true) {
      const playwrightModuleRoot = join(
        runtimeRoot,
        'node_modules',
        'playwright',
      );
      const requireFromHere = createRequire(import.meta.url);
      const playwrightEntry = await resolveWorkspacePlaywrightRuntimeEntry(
        requireFromHere.resolve('playwright'),
      );
      await mkdir(playwrightModuleRoot, { recursive: true });
      await writeFile(
        join(playwrightModuleRoot, 'index.js'),
        `const { existsSync } = require('node:fs');
const playwright = require(${JSON.stringify(playwrightEntry)});

function resolveChromiumExecutablePath() {
  const defaultPath = playwright.chromium.executablePath();
  if (existsSync(defaultPath)) {
    return undefined;
  }
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  return candidates.find((candidate) => existsSync(candidate));
}

const chromium = {
  ...playwright.chromium,
  executablePath: () => {
    return resolveChromiumExecutablePath() ?? playwright.chromium.executablePath();
  },
  launch: async (options = {}) => {
    const executablePath = resolveChromiumExecutablePath();
    return await playwright.chromium.launch(
      executablePath === undefined ? options : { ...options, executablePath },
    );
  },
};

module.exports = { ...playwright, chromium };
`,
        'utf8',
      );
    }

    const child = spawn(process.execPath, ['-e', args.script, inputPath], {
      cwd: runtimeRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    child.stdout.on('data', (chunk: Uint8Array) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Uint8Array) => stderrChunks.push(chunk));

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, args.timeoutMs ?? 5_000);
    const outcome = await new Promise<{
      exitCode: number | null;
      signal: string | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => {
        resolve({ exitCode, signal });
      });
    });
    clearTimeout(killTimer);
    if (timedOut) {
      throw new Error('PTC browser runtime script timed out');
    }

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    return {
      ...outcome,
      stdout,
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      jsonLines: stdout
        .split(/\r?\n/u)
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown),
    };
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

function exists(path: string): boolean {
  return existsSync(path);
}
