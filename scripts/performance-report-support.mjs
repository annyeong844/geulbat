import { execFileSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function collectPerformanceEnvironment({ repoRoot, runtime = {} }) {
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
      ...runtime,
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

export function summarizePerformanceNumbers(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mean =
    values.reduce((total, value) => total + value, 0) / values.length;
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) /
    values.length;
  return {
    min: round(sorted[0]),
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1)),
    mean: round(mean),
    standardDeviation: round(Math.sqrt(variance)),
  };
}

export async function writePrivatePerformanceReport(outputPath, report) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await chmod(outputPath, 0o600);
}

function percentile(sorted, ratio) {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

function round(value) {
  return Number(value.toFixed(3));
}

function runGit(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}
