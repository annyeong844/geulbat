#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { spawnOwnedChildProcess } from '../../../scripts/owned-child-process.mjs';
import {
  collectPerformanceEnvironment,
  summarizePerformanceNumbers,
  writePrivatePerformanceReport,
} from '../../../scripts/performance-report-support.mjs';
import { DAEMON_HOT_PATH_MEMORY_SCENARIOS } from './daemon-hot-path-memory-worker.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const workerPath = fileURLToPath(
  new URL('./daemon-hot-path-memory-worker.mjs', import.meta.url),
);
const repoRoot = path.resolve(path.dirname(scriptPath), '../../..');
const activeWorkers = new Set();

export async function runDaemonHotPathMemoryProbe(options) {
  options.signal?.throwIfAborted();
  const startedAt = performance.now();
  const executions = [];
  for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
    const scenarios = {};
    for (const scenario of DAEMON_HOT_PATH_MEMORY_SCENARIOS) {
      options.signal?.throwIfAborted();
      console.error(
        `[daemon-hot-path-memory] run ${String(runIndex + 1)}/${String(
          options.runs,
        )} ${scenario}`,
      );
      scenarios[scenario] = await runWorkerProcess({
        scenario,
        sampleCounts: options.sampleCounts,
        payloadBytes: options.payloadBytes,
      });
      options.signal?.throwIfAborted();
    }
    executions.push({ runNumber: runIndex + 1, scenarios });
  }

  const report = buildDaemonHotPathMemoryReport({
    environment: collectPerformanceEnvironment({
      repoRoot,
      runtime: {
        loader: 'tsx',
        memoryMeasurement: 'isolated_workers_with_explicit_gc',
      },
    }),
    executions,
    sampleCounts: options.sampleCounts,
    payloadBytes: options.payloadBytes,
    durationMs: performance.now() - startedAt,
  });
  options.signal?.throwIfAborted();
  await writePrivatePerformanceReport(options.outputPath, report);
  options.signal?.throwIfAborted();
  return report;
}

export function buildDaemonHotPathMemoryReport({
  environment,
  executions,
  sampleCounts,
  payloadBytes,
  durationMs,
}) {
  if (executions.length === 0) {
    throw new Error('daemon hot-path memory probe produced no executions');
  }
  for (const execution of executions) {
    for (const scenario of DAEMON_HOT_PATH_MEMORY_SCENARIOS) {
      assertScenarioSamples(
        scenario,
        execution.scenarios[scenario],
        sampleCounts,
      );
    }
  }
  return {
    schemaVersion: 'daemon_hot_path_memory_v1',
    environment,
    workload: {
      runs: executions.length,
      sampleCounts,
      payloadBytes,
      scenarioIsolation: 'one fresh Node process per owner and run',
      gcMode: 'two explicit full-GC requests before retained snapshots',
    },
    executions,
    aggregates: Object.fromEntries(
      DAEMON_HOT_PATH_MEMORY_SCENARIOS.map((scenario) => [
        scenario,
        aggregateScenario(executions, scenario, sampleCounts),
      ]),
    ),
    invariants: {
      exactRequestedItemCount: true,
      liveReplayRemainedResident: true,
      checkpointHydrationMatchedJournal: true,
      transcriptCacheMatchedDurableTranscript: true,
      workerProcessTreesSettled: true,
      noProductMemoryThresholdDefined: true,
    },
    durationMs: round(durationMs),
  };
}

function assertScenarioSamples(scenario, result, sampleCounts) {
  if (
    result?.scenario !== scenario ||
    result.samples?.length !== sampleCounts.length
  ) {
    throw new Error(`invalid memory probe result for ${scenario}`);
  }
  for (const [index, itemCount] of sampleCounts.entries()) {
    const sample = result.samples[index];
    if (sample?.itemCount !== itemCount) {
      throw new Error(`${scenario} sample count mismatch at ${itemCount}`);
    }
    if (
      scenario === 'live_event_history' &&
      (sample.owner.residentReplayEventCount !== itemCount ||
        sample.owner.durableReplayReadCount !== 0)
    ) {
      throw new Error(`live event history was not resident at ${itemCount}`);
    }
    if (
      scenario === 'checkpoint_hydration' &&
      sample.owner.eventHistoryCount !== itemCount
    ) {
      throw new Error(`checkpoint hydration count mismatch at ${itemCount}`);
    }
    if (
      scenario === 'transcript_cache' &&
      (sample.owner.cachedEntryCount !== itemCount ||
        sample.owner.cachedThreadCount !== (itemCount === 0 ? 0 : 1))
    ) {
      throw new Error(`transcript cache count mismatch at ${itemCount}`);
    }
  }
}

function aggregateScenario(executions, scenario, sampleCounts) {
  const sampleAggregates = sampleCounts.map((itemCount, index) => {
    const samples = executions.map(
      (execution) => execution.scenarios[scenario].samples[index],
    );
    return {
      itemCount,
      retainedHeapDeltaBytes: summarizePerformanceNumbers(
        samples.map((sample) => sample.retainedHeapDeltaBytes),
      ),
      rssDeltaBytes: summarizePerformanceNumbers(
        samples.map((sample) => sample.rssDeltaBytes),
      ),
    };
  });
  const finalSamples = executions.map((execution) =>
    execution.scenarios[scenario].samples.at(-1),
  );
  const finalItemCount = sampleCounts.at(-1);
  const owner = {
    durableFileBytes: summarizePerformanceNumbers(
      finalSamples.map((sample) => sample.owner.durableFileBytes),
    ),
  };
  if (scenario === 'checkpoint_hydration') {
    owner.hydratedHeapDeltaBytes = summarizePerformanceNumbers(
      finalSamples.map((sample) => sample.owner.hydratedHeapDeltaBytes),
    );
    owner.hydratedHeapBytesPerItem = summarizePerformanceNumbers(
      finalSamples.map(
        (sample) => sample.owner.hydratedHeapDeltaBytes / finalItemCount,
      ),
    );
  }
  return {
    samples: sampleAggregates,
    final: {
      itemCount: finalItemCount,
      retainedHeapBytesPerItem: summarizePerformanceNumbers(
        finalSamples.map(
          (sample) => sample.retainedHeapDeltaBytes / finalItemCount,
        ),
      ),
      owner,
    },
  };
}

async function runWorkerProcess({ scenario, sampleCounts, payloadBytes }) {
  const owner = spawnOwnedChildProcess(
    process.execPath,
    [
      '--expose-gc',
      '--import',
      'tsx',
      workerPath,
      '--scenario',
      scenario,
      '--sample-counts',
      sampleCounts.join(','),
      '--payload-bytes',
      String(payloadBytes),
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  activeWorkers.add(owner);
  const stdout = [];
  const stderr = [];
  owner.child.stdout.on('data', (chunk) => stdout.push(chunk));
  owner.child.stderr.on('data', (chunk) => stderr.push(chunk));
  const result = await owner.waitForExit();
  let settlementError;
  try {
    await owner.settleTree();
  } catch (error) {
    settlementError = error;
  } finally {
    activeWorkers.delete(owner);
  }
  if (settlementError === undefined) {
    await owner.waitForClose();
  } else {
    owner.child.stdout.destroy();
    owner.child.stderr.destroy();
    throw new Error(`memory probe worker tree did not settle: ${scenario}`, {
      cause: settlementError,
    });
  }
  const stderrText = Buffer.concat(stderr).toString('utf8').trim();
  if (result.code !== 0) {
    throw new Error(
      `memory probe worker ${scenario} failed (${String(
        result.code ?? result.signal,
      )})${stderrText === '' ? '' : `: ${stderrText}`}`,
      result.error === undefined ? undefined : { cause: result.error },
    );
  }
  const lines = Buffer.concat(stdout)
    .toString('utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (lastLine === undefined) {
    throw new Error(`memory probe worker ${scenario} returned no result`);
  }
  return JSON.parse(lastLine);
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
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
  const allowed = new Set([
    '--output',
    '--payload-bytes',
    '--runs',
    '--sample-counts',
  ]);
  for (const option of values.keys()) {
    if (!allowed.has(option)) {
      throw new Error(`unknown option: ${option}`);
    }
  }
  return {
    sampleCounts: parseSampleCounts(
      readRequiredOption(values, '--sample-counts'),
    ),
    payloadBytes: parsePositiveInteger(
      readRequiredOption(values, '--payload-bytes'),
      '--payload-bytes',
    ),
    runs: parsePositiveInteger(readRequiredOption(values, '--runs'), '--runs'),
    outputPath: path.resolve(repoRoot, readRequiredOption(values, '--output')),
  };
}

function parseSampleCounts(value) {
  const counts = value.split(',').map((part) => Number(part));
  if (
    counts.length < 2 ||
    counts[0] !== 0 ||
    counts.some(
      (count, index) =>
        !Number.isSafeInteger(count) ||
        count < 0 ||
        (index > 0 && count <= counts[index - 1]),
    )
  ) {
    throw new Error(
      '--sample-counts must be a strictly increasing list beginning with 0',
    );
  }
  return counts;
}

function parsePositiveInteger(value, optionName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive safe integer`);
  }
  return parsed;
}

function readRequiredOption(values, option) {
  const value = values.get(option);
  if (value === undefined || value.trim() === '') {
    throw new Error(`missing required option: ${option}`);
  }
  return value;
}

function round(value) {
  return Number(value.toFixed(3));
}

function printHelp() {
  console.log(`Usage:
  npm run probe:hot-path-memory -w apps/daemon -- \\
    --sample-counts 0,1000,5000,10000 \\
    --payload-bytes 512 \\
    --runs 3 \\
    --output .audit/<task-id>/daemon-hot-path-memory.json`);
}

async function terminateActiveWorkers(signal) {
  await Promise.allSettled(
    [...activeWorkers].map((owner) => owner.terminateTree(signal)),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  let stopSignal;
  const controller = new AbortController();
  const stop = (signal) => {
    if (stopSignal !== undefined) {
      return;
    }
    stopSignal = signal;
    controller.abort(
      new Error(`daemon hot-path memory probe received ${signal}`),
    );
    void terminateActiveWorkers(signal);
  };
  const signalHandlers = [
    ['SIGINT', () => stop('SIGINT')],
    ['SIGTERM', () => stop('SIGTERM')],
  ];
  for (const [signal, handler] of signalHandlers) {
    process.once(signal, handler);
  }
  try {
    const report = await runDaemonHotPathMemoryProbe({
      ...options,
      signal: controller.signal,
    });
    console.log(
      `[daemon-hot-path-memory] ${JSON.stringify({
        outputPath: options.outputPath,
        runs: report.workload.runs,
        finalItemCount: report.workload.sampleCounts.at(-1),
        durationMs: report.durationMs,
      })}`,
    );
    return 0;
  } catch (error) {
    if (stopSignal === undefined) {
      throw error;
    }
    const signalNumber = os.constants.signals[stopSignal];
    return signalNumber === undefined ? 1 : 128 + signalNumber;
  } finally {
    await terminateActiveWorkers(stopSignal ?? 'SIGTERM');
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
