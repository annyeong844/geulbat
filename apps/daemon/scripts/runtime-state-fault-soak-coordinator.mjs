import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { runtimeStateFaultEvidence } from './runtime-state-fault-soak-evidence.mjs';
import { runtimeStateFaultWorkerSupport } from './runtime-state-fault-soak-worker.mjs';

const execFile = promisify(execFileCallback);

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

async function readEnvironment() {
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD']),
    execFile('git', ['status', '--porcelain=v1']),
  ]);
  const changedPaths = status
    .split(/\r?\n/u)
    .filter((line) => line !== '').length;
  return {
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? null,
    freeMemoryBytes: freemem(),
    git: {
      changedPaths,
      dirty: changedPaths > 0,
      head: head.trim(),
    },
    host: hostname(),
    kernel: release(),
    node: process.version,
    platform: platform(),
    totalMemoryBytes: totalmem(),
  };
}

function createJsonlLogger(logPath) {
  let eventCount = 0;
  let writes = Promise.resolve();
  return {
    append(type, details = {}) {
      eventCount += 1;
      const entry = {
        sequence: eventCount,
        timestamp: new Date().toISOString(),
        type,
        ...details,
      };
      writes = writes.then(() =>
        appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8'),
      );
      return writes;
    },
    count: () => eventCount,
    flush: () => writes,
  };
}

async function runWorkload({
  config,
  createDaemonRuntimeStateStore,
  deadline,
  failures,
  homeStateRoot,
  logger,
  monotonicStart,
  workerOwner,
}) {
  let nextKillAt = monotonicStart + config.killIntervalMs;
  let nextReopenAt = monotonicStart + config.reopenIntervalMs;
  let deliberateDeaths = 0;
  let replacements = 0;
  let reopenAttempts = 0;
  let reopenSuccesses = 0;
  let killCursor = 0;

  while (performance.now() < deadline) {
    const now = performance.now();
    if (now >= nextKillAt) {
      const slot = killCursor % config.workers;
      killCursor += 1;
      const record = workerOwner.active.get(slot);
      if (record === undefined || record.ended) {
        failures.push(
          `worker slot ${slot} was unavailable for death injection`,
        );
      } else {
        record.expectedTermination = true;
        await logger.append('worker_death_injected', {
          generation: record.generation,
          slot,
          stats: record.latestStats,
        });
        await record.worker.terminate();
        await record.exitPromise;
        workerOwner.active.delete(slot);
        deliberateDeaths += 1;
        if (performance.now() < deadline) {
          await workerOwner.spawn(slot, record.generation + 1, true);
          replacements += 1;
          await logger.append('worker_replaced', {
            generation: record.generation + 1,
            slot,
          });
        }
      }
      nextKillAt += config.killIntervalMs;
      continue;
    }
    if (now >= nextReopenAt) {
      reopenAttempts += 1;
      try {
        const reopened = await createDaemonRuntimeStateStore({
          homeStateRoot,
          deferSubagentRestartReconciliation: true,
        });
        const diagnostics = reopened.readDiagnostics();
        reopened.close();
        reopenSuccesses += 1;
        await logger.append('store_reopened', {
          diagnostics,
          reopenAttempts,
        });
      } catch (error) {
        const detail = runtimeStateFaultEvidence.formatError(error);
        failures.push(`store reopen ${reopenAttempts} failed: ${detail}`);
        await logger.append('store_reopen_failed', {
          error: detail,
          reopenAttempts,
        });
      }
      nextReopenAt += config.reopenIntervalMs;
      continue;
    }
    const untilNextAction = Math.min(deadline, nextKillAt, nextReopenAt) - now;
    await delay(Math.max(1, Math.min(100, Math.ceil(untilNextAction))));
  }
  return {
    deliberateDeaths,
    reopenAttempts,
    reopenSuccesses,
    replacements,
  };
}

export async function runRuntimeStateFaultSoak(config) {
  await mkdir(config.outputDirectory, { recursive: true, mode: 0o700 });
  const artifactBase = `runtime-state-fault-soak-${config.label}`;
  const logPath = resolve(config.outputDirectory, `${artifactBase}.jsonl`);
  const summaryPath = resolve(
    config.outputDirectory,
    `${artifactBase}-summary.json`,
  );
  const homeStateRoot = resolve(
    config.outputDirectory,
    `${artifactBase}-state`,
  );
  await mkdir(homeStateRoot, { mode: 0o700 });
  await writeFile(logPath, '', { flag: 'wx', mode: 0o600 });
  const logger = createJsonlLogger(logPath);

  const { createDaemonRuntimeStateStore, childModelRegistration } =
    await runtimeStateFaultWorkerSupport.loadModules();
  const collisionParentRunId = `collision-parent-${config.label}`;
  const collisionToolCallId = `collision-tool-${config.label}`;
  const initialStore = await createDaemonRuntimeStateStore({
    homeStateRoot,
    deferSubagentRestartReconciliation: true,
  });
  const initialDiagnostics = initialStore.readDiagnostics();
  const databasePath = initialStore.databasePath;
  initialStore.enqueueSubagentLaunchBatch([
    runtimeStateFaultWorkerSupport.makeLaunchRequest({
      childModelRegistration,
      label: config.label,
      ownerThreadId: randomUUID(),
      parentRunId: collisionParentRunId,
      taskKind: 'collision seed',
      toolCallId: collisionToolCallId,
    }),
  ]);
  initialStore.close();

  const startedAt = new Date();
  const startMemory = process.memoryUsage();
  const startResources = process.getActiveResourcesInfo();
  const environment = await readEnvironment();
  await logger.append('soak_started', {
    config,
    databasePath,
    environment,
    initialDiagnostics,
  });
  console.log(
    `[runtime-state-fault-soak] started ${config.label} for ${config.durationMs}ms`,
  );

  const failures = [];
  const workerOwner = runtimeStateFaultWorkerSupport.createWorkerOwner({
    commonWorkerData: {
      batchSize: config.batchSize,
      collisionParentRunId,
      collisionToolCallId,
      homeStateRoot,
      label: config.label,
      operationDelayMs: config.operationDelayMs,
      progressEvery: config.progressEvery,
      rollbackEvery: config.rollbackEvery,
    },
    failures,
    logger,
  });
  for (let slot = 0; slot < config.workers; slot += 1) {
    await workerOwner.spawn(slot, 0, false);
  }
  for (const record of workerOwner.active.values()) {
    record.worker.postMessage({ type: 'start' });
  }

  const monotonicStart = performance.now();
  const deadline = monotonicStart + config.durationMs;
  const workload = await runWorkload({
    config,
    createDaemonRuntimeStateStore,
    deadline,
    failures,
    homeStateRoot,
    logger,
    monotonicStart,
    workerOwner,
  });
  const requestedEnd = performance.now();
  const forcedShutdowns = await runtimeStateFaultWorkerSupport.stopWorkers(
    workerOwner,
    config.shutdownGraceMs,
  );
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

  const databaseEvidence =
    runtimeStateFaultEvidence.readRuntimeStateFaultSoakEvidence(
      databasePath,
      config.batchSize,
    );
  const observedWorkerStats = runtimeStateFaultWorkerSupport.emptyWorkerStats();
  for (const stats of workerOwner.snapshots.values()) {
    runtimeStateFaultWorkerSupport.addWorkerStats(observedWorkerStats, stats);
  }
  const endMemory = process.memoryUsage();
  const endResources = process.getActiveResourcesInfo();
  const fileBytes = {
    database: await runtimeStateFaultEvidence.readPathBytes(databasePath),
    sharedMemory: await runtimeStateFaultEvidence.readPathBytes(
      `${databasePath}-shm`,
    ),
    writeAheadLog: await runtimeStateFaultEvidence.readPathBytes(
      `${databasePath}-wal`,
    ),
  };
  const elapsedMs = requestedEnd - monotonicStart;
  const passFailures = runtimeStateFaultEvidence.collectFailures({
    config,
    databaseEvidence,
    elapsedMs,
    failures,
    forcedShutdowns,
    initialDiagnostics,
    observedWorkerStats,
    ...workload,
  });
  const summary = {
    schemaVersion: 'runtime_state_fault_soak_v1',
    pass: passFailures.length === 0,
    failures: passFailures,
    scope: {
      exercised:
        'current daemon runtime-state store, worker_threads, transactional batch rollback, store reopen',
      notExercised:
        'provider effects, transcript insertion, child processes, network sockets, WebSocket reconnect',
      companionEvidence:
        'web-shell flow gate covers socket reconnect/replay; Phase A fault tests cover effect replay and transcript dedupe',
    },
    config,
    environment,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    elapsedMs,
    initialDiagnostics,
    memory: {
      start: startMemory,
      end: endMemory,
      delta: {
        heapUsed: endMemory.heapUsed - startMemory.heapUsed,
        rss: endMemory.rss - startMemory.rss,
      },
    },
    durableState: databaseEvidence,
    files: {
      bytes: fileBytes,
      databasePath,
      logPath,
      summaryPath,
    },
    events: {
      jsonlEventCount: logger.count() + 1,
      reconnectCount: 0,
      reconnectScope: 'not exercised in this SQLite-only probe',
    },
    workers: {
      configured: config.workers,
      deliberateDeaths: workload.deliberateDeaths,
      forcedShutdowns,
      observedStats: observedWorkerStats,
      ownedWorkersRemaining: workerOwner.active.size,
      replacements: workload.replacements,
      workerInstances: workerOwner.workerInstances(),
    },
    resources: {
      childProcessesCreated: 0,
      networkSocketsCreated: 0,
      ownedTimersRemaining: 0,
      start: startResources,
      end: endResources,
    },
    storeReopens: {
      attempts: workload.reopenAttempts,
      successes: workload.reopenSuccesses,
    },
  };
  await logger.append('soak_finished', {
    pass: summary.pass,
    failures: summary.failures,
  });
  await logger.flush();
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    `[runtime-state-fault-soak] ${summary.pass ? 'PASS' : 'FAIL'} ${summaryPath}`,
  );
  if (!summary.pass) {
    process.exitCode = 1;
  }
  return summary;
}
