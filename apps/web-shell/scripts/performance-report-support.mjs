import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const playwrightPackage = require('playwright/package.json');

export function collectBrowserPerformanceEnvironment({
  repoRoot,
  browserVersion,
}) {
  const gitHead = runGit(repoRoot, ['rev-parse', 'HEAD']);
  const dirtyPaths = runGit(repoRoot, ['status', '--short'])
    .split('\n')
    .filter((line) => line.length > 0);
  const cpus = os.cpus();
  return {
    capturedAt: new Date().toISOString(),
    git: {
      head: gitHead,
      dirty: dirtyPaths.length > 0,
      changedPathCount: dirtyPaths.length,
    },
    runtime: {
      node: process.version,
      playwright: playwrightPackage.version,
      browser: browserVersion,
    },
    host: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model ?? 'unknown',
      totalMemoryBytes: os.totalmem(),
    },
  };
}

export async function writePrivatePerformanceReport(outputPath, report) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function runGit(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}
