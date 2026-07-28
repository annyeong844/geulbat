#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runRuntimeStateFaultSoak } from './runtime-state-fault-soak-coordinator.mjs';
import { runtimeStateFaultEvidence } from './runtime-state-fault-soak-evidence.mjs';

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive safe integer`);
  }
  return parsed;
}

function parseMainArgs(argv) {
  if (argv.includes('--help')) {
    return { help: true };
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      option === undefined ||
      !option.startsWith('--') ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new Error(`invalid option/value pair near ${option ?? '<end>'}`);
    }
    if (values.has(option)) {
      throw new Error(`${option} was provided more than once`);
    }
    values.set(option, value);
  }
  const required = [
    '--batch-size',
    '--duration-ms',
    '--kill-interval-ms',
    '--label',
    '--operation-delay-ms',
    '--output-dir',
    '--progress-every',
    '--reopen-interval-ms',
    '--rollback-every',
    '--shutdown-grace-ms',
    '--workers',
  ];
  for (const option of required) {
    if (!values.has(option)) {
      throw new Error(`missing required option: ${option}`);
    }
  }
  const label = values.get('--label');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(label)) {
    throw new Error(
      '--label must contain only lowercase letters, digits, and hyphens',
    );
  }
  const config = {
    batchSize: parsePositiveInteger(values.get('--batch-size'), '--batch-size'),
    durationMs: parsePositiveInteger(
      values.get('--duration-ms'),
      '--duration-ms',
    ),
    killIntervalMs: parsePositiveInteger(
      values.get('--kill-interval-ms'),
      '--kill-interval-ms',
    ),
    label,
    operationDelayMs: parsePositiveInteger(
      values.get('--operation-delay-ms'),
      '--operation-delay-ms',
    ),
    outputDirectory: resolve(values.get('--output-dir')),
    progressEvery: parsePositiveInteger(
      values.get('--progress-every'),
      '--progress-every',
    ),
    reopenIntervalMs: parsePositiveInteger(
      values.get('--reopen-interval-ms'),
      '--reopen-interval-ms',
    ),
    rollbackEvery: parsePositiveInteger(
      values.get('--rollback-every'),
      '--rollback-every',
    ),
    shutdownGraceMs: parsePositiveInteger(
      values.get('--shutdown-grace-ms'),
      '--shutdown-grace-ms',
    ),
    workers: parsePositiveInteger(values.get('--workers'), '--workers'),
  };
  if (config.workers < 2) {
    throw new Error('--workers must be at least 2');
  }
  if (config.killIntervalMs >= config.durationMs) {
    throw new Error('--kill-interval-ms must be shorter than --duration-ms');
  }
  if (config.reopenIntervalMs >= config.durationMs) {
    throw new Error('--reopen-interval-ms must be shorter than --duration-ms');
  }
  return config;
}

function printUsage() {
  console.log(`Usage:
  npm run probe:runtime-state-fault-soak -w apps/daemon -- \\
    --label <artifact-label> --output-dir <directory> \\
    --duration-ms <ms> --workers <count> --batch-size <count> \\
    --operation-delay-ms <ms> --rollback-every <operations> \\
    --progress-every <operations> --kill-interval-ms <ms> \\
    --reopen-interval-ms <ms> --shutdown-grace-ms <ms>

All workload values are explicit. Existing state, log, and summary artifacts
are never overwritten.`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const config = parseMainArgs(process.argv.slice(2));
    if (config.help) {
      printUsage();
    } else {
      await runRuntimeStateFaultSoak(config);
    }
  } catch (error) {
    console.error(
      `[runtime-state-fault-soak] ${runtimeStateFaultEvidence.formatError(error)}`,
    );
    process.exitCode = 1;
  }
}
