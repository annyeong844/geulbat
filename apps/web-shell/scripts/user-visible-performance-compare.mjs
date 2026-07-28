#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writePrivatePerformanceReport } from '../../../scripts/performance-report-support.mjs';
import { buildFlowGateUserVisiblePerformanceComparison } from './flow-gate-user-visible-performance-report.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function readRequiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--') || value.trim() === '') {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function readReport(optionName) {
  const reportPath = path.resolve(repoRoot, readRequiredOption(optionName));
  return JSON.parse(await fs.readFile(reportPath, 'utf8'));
}

const outputPath = path.resolve(repoRoot, readRequiredOption('--output'));
const targetMetric = readRequiredOption('--target-metric');
const comparison = buildFlowGateUserVisiblePerformanceComparison({
  baseline: await readReport('--baseline'),
  candidate: await readReport('--candidate'),
  targetMetric,
});

await writePrivatePerformanceReport(outputPath, comparison);
console.log(
  `[user-visible-performance] candidate ${comparison.target.accepted ? 'accepted' : 'rejected'} for ${targetMetric}; comparison written to ${outputPath}`,
);
