#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writePrivatePerformanceReport } from '../../../scripts/performance-report-support.mjs';
import { buildFlowGateUserVisiblePerformanceBaseline } from './flow-gate-user-visible-performance-report.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const flowGatePath = fileURLToPath(new URL('./flow-gate.mjs', import.meta.url));
const runCount = readPositiveIntegerOption('--runs', 3);
const outputPath = readRequiredPathOption('--output');

function readPositiveIntegerOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function readRequiredPathOption(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--') || value.trim() === '') {
    throw new Error(`${name} requires a path`);
  }
  return path.resolve(repoRoot, value);
}

function runFlowGate(samplePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [flowGatePath, '--user-visible-performance-output', samplePath],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: 'inherit',
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(
        new Error(
          `flow-gate sample failed (${signal ?? `exit ${String(code)}`})`,
        ),
      );
    });
  });
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'geulbat-user-visible-performance-'),
  );
  try {
    const samples = [];
    for (let index = 0; index < runCount; index += 1) {
      const samplePath = path.join(
        temporaryRoot,
        `sample-${String(index + 1)}.json`,
      );
      console.log(
        `\n[user-visible-performance] isolated cold sample ${String(index + 1)}/${String(runCount)}`,
      );
      await runFlowGate(samplePath);
      samples.push(JSON.parse(await fs.readFile(samplePath, 'utf8')));
    }
    await writePrivatePerformanceReport(
      outputPath,
      buildFlowGateUserVisiblePerformanceBaseline(samples),
    );
    console.log(
      `\n[user-visible-performance] wrote ${String(samples.length)} samples to ${outputPath}`,
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
