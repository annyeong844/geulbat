import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

exports.chromium = {
  launch: async () => ({
    newContext: async () => ({
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
      close: async () => undefined,
    }),
    close: async () => undefined,
  }),
};
`;

export interface PtcBrowserRuntimeScriptRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  jsonLines: unknown[];
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
      const playwrightEntry = requireFromHere.resolve('playwright');
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
