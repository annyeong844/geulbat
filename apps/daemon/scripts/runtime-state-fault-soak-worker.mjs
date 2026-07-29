import { randomUUID } from 'node:crypto';
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads';

import { runtimeStateFaultEvidence } from './runtime-state-fault-soak-evidence.mjs';

function sourceUrl(relativePath) {
  return new URL(`../src/${relativePath}`, import.meta.url).href;
}

async function loadRuntimeStateFaultSoakModules() {
  const [runtimeState, modelRouting] = await Promise.all([
    import(sourceUrl('daemon/runtime-state-store.ts')),
    import(sourceUrl('test-support/subagent-model-routing.ts')),
  ]);
  return {
    createDaemonRuntimeStateStore: runtimeState.createDaemonRuntimeStateStore,
    childModelRegistration: modelRouting.TEST_CHILD_MODEL_REGISTRATION,
  };
}

function emptyRuntimeStateFaultWorkerStats() {
  return {
    acceptedBatches: 0,
    acceptedRows: 0,
    busyFailures: 0,
    operations: 0,
    rollbackAttempts: 0,
    rollbackVerified: 0,
    unexpectedFailures: 0,
  };
}

function addRuntimeStateFaultWorkerStats(target, stats) {
  for (const key of Object.keys(target)) {
    target[key] += stats[key] ?? 0;
  }
}

function makeRuntimeStateFaultLaunchRequest({
  childModelRegistration,
  label,
  ownerThreadId,
  parentRunId,
  taskKind,
  toolCallId,
}) {
  return {
    toolCallId,
    task: `${taskKind} ${label}`,
    subagentType: 'explorer',
    capabilities: [],
    parentRunId,
    ownerThreadId,
    stateRoot: `/fault-soak/${label}/state`,
    workingDirectory: `/fault-soak/${label}/workspace`,
    ...childModelRegistration,
  };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function errorMatches(error, patterns) {
  const text = runtimeStateFaultEvidence.formatError(error);
  return patterns.some((pattern) => text.includes(pattern));
}

function isBusyError(error) {
  return errorMatches(error, ['SQLITE_BUSY', 'database is locked']);
}

function isConstraintError(error) {
  return errorMatches(error, ['SQLITE_CONSTRAINT', 'UNIQUE constraint failed']);
}

async function exerciseRollback({
  args,
  childModelRegistration,
  operationId,
  stats,
  store,
}) {
  stats.rollbackAttempts += 1;
  const rollbackParentRunId = `rollback-parent-${operationId}`;
  const rollbackToolCallId = `rollback-probe-${operationId}`;
  try {
    store.enqueueSubagentLaunchBatch([
      makeRuntimeStateFaultLaunchRequest({
        childModelRegistration,
        label: args.label,
        ownerThreadId: randomUUID(),
        parentRunId: rollbackParentRunId,
        taskKind: 'rollback candidate',
        toolCallId: rollbackToolCallId,
      }),
      makeRuntimeStateFaultLaunchRequest({
        childModelRegistration,
        label: args.label,
        ownerThreadId: randomUUID(),
        parentRunId: args.collisionParentRunId,
        taskKind: 'intentional collision',
        toolCallId: args.collisionToolCallId,
      }),
    ]);
    throw new Error(
      `intentional collision unexpectedly committed: ${operationId}`,
    );
  } catch (error) {
    if (isBusyError(error)) {
      stats.busyFailures += 1;
      return;
    }
    if (!isConstraintError(error)) {
      stats.unexpectedFailures += 1;
      throw error;
    }
    const residue = store.readSubagentLaunchRequest({
      parentRunId: rollbackParentRunId,
      toolCallId: rollbackToolCallId,
    });
    if (residue !== undefined) {
      throw new Error(`partial failure left rollback residue: ${operationId}`);
    }
    stats.rollbackVerified += 1;
  }
}

function exerciseAtomicBatch({
  args,
  childModelRegistration,
  operationId,
  stats,
  store,
}) {
  const parentRunId = `batch-parent-${operationId}`;
  const requests = Array.from({ length: args.batchSize }, (_, batchPosition) =>
    makeRuntimeStateFaultLaunchRequest({
      childModelRegistration,
      label: args.label,
      ownerThreadId: randomUUID(),
      parentRunId,
      taskKind: 'atomic batch row',
      toolCallId: `batch-${operationId}-${batchPosition}`,
    }),
  );
  try {
    const accepted = store.enqueueSubagentLaunchBatch(requests);
    stats.acceptedBatches += 1;
    stats.acceptedRows += accepted.length;
  } catch (error) {
    if (isBusyError(error)) {
      stats.busyFailures += 1;
      return;
    }
    stats.unexpectedFailures += 1;
    throw error;
  }
}

async function runRuntimeStateFaultWorker(args) {
  if (parentPort === null) {
    throw new Error('fault-soak worker requires a parent message port');
  }
  const { createDaemonRuntimeStateStore, childModelRegistration } =
    await loadRuntimeStateFaultSoakModules();
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot: args.homeStateRoot,
    deferSubagentRestartReconciliation: true,
  });
  const stats = emptyRuntimeStateFaultWorkerStats();
  let started = false;
  let stopping = false;
  let resolveStart;
  const startPromise = new Promise((resolveWorkerStart) => {
    resolveStart = resolveWorkerStart;
  });
  parentPort.on('message', (message) => {
    if (message?.type === 'start') {
      started = true;
      resolveStart();
    }
    if (message?.type === 'stop') {
      stopping = true;
      resolveStart();
    }
  });
  parentPort.postMessage({
    type: 'ready',
    diagnostics: store.readDiagnostics(),
  });

  try {
    await startPromise;
    while (started && !stopping) {
      stats.operations += 1;
      const operationId = `${args.slot}-${args.generation}-${stats.operations}`;
      if (stats.operations % args.rollbackEvery === 0) {
        await exerciseRollback({
          args,
          childModelRegistration,
          operationId,
          stats,
          store,
        });
      } else {
        exerciseAtomicBatch({
          args,
          childModelRegistration,
          operationId,
          stats,
          store,
        });
      }
      if (stats.operations % args.progressEvery === 0) {
        parentPort.postMessage({ type: 'progress', stats: { ...stats } });
      }
      await delay(args.operationDelayMs);
    }
    parentPort.postMessage({ type: 'final', stats: { ...stats } });
  } finally {
    parentPort.removeAllListeners('message');
    parentPort.close();
    store.close();
  }
}

function createRuntimeStateFaultWorkerOwner({
  commonWorkerData,
  failures,
  logger,
}) {
  const active = new Map();
  const snapshots = new Map();
  let workerInstances = 0;

  async function spawn(slot, generation, startImmediately) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { ...commonWorkerData, generation, slot },
    });
    const identity = `${slot}:${generation}`;
    const record = {
      ended: false,
      expectedTermination: false,
      generation,
      identity,
      latestStats: emptyRuntimeStateFaultWorkerStats(),
      slot,
      worker,
    };
    workerInstances += 1;
    active.set(slot, record);
    snapshots.set(identity, record.latestStats);

    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolveWorkerReady, rejectWorkerReady) => {
      resolveReady = resolveWorkerReady;
      rejectReady = rejectWorkerReady;
    });
    record.exitPromise = new Promise((resolveExit) => {
      worker.once('exit', (code) => {
        record.ended = true;
        record.exitCode = code;
        if (!record.expectedTermination && code !== 0) {
          failures.push(
            `worker ${identity} exited unexpectedly with code ${code}`,
          );
        }
        rejectReady(
          new Error(`worker ${identity} exited before becoming ready`),
        );
        resolveExit(code);
      });
    });
    worker.on('message', (message) => {
      if (message?.type === 'ready') {
        void logger.append('worker_ready', {
          diagnostics: message.diagnostics,
          generation,
          slot,
        });
        resolveReady();
        return;
      }
      if (message?.type === 'progress' || message?.type === 'final') {
        record.latestStats = message.stats;
        snapshots.set(identity, message.stats);
        void logger.append(`worker_${message.type}`, {
          generation,
          slot,
          stats: message.stats,
        });
        return;
      }
      if (message?.type === 'fatal') {
        failures.push(`worker ${identity} fatal: ${message.error}`);
        void logger.append('worker_fatal', {
          error: message.error,
          generation,
          slot,
        });
      }
    });
    worker.on('error', (error) => {
      const detail = runtimeStateFaultEvidence.formatError(error);
      failures.push(`worker ${identity} error: ${detail}`);
      void logger.append('worker_error', {
        error: detail,
        generation,
        slot,
      });
    });
    await ready;
    if (startImmediately) {
      worker.postMessage({ type: 'start' });
    }
    return record;
  }

  return {
    active,
    snapshots,
    spawn,
    workerInstances: () => workerInstances,
  };
}

async function stopRuntimeStateFaultWorkers(workerOwner, shutdownGraceMs) {
  const records = [...workerOwner.active.values()];
  for (const record of records) {
    record.worker.postMessage({ type: 'stop' });
  }
  let timeoutId;
  const timeout = new Promise((resolveTimeout) => {
    timeoutId = setTimeout(() => resolveTimeout('timeout'), shutdownGraceMs);
  });
  const graceful = Promise.all(
    records.map((record) => record.exitPromise),
  ).then(() => 'graceful');
  const result = await Promise.race([graceful, timeout]);
  clearTimeout(timeoutId);
  let forcedShutdowns = 0;
  if (result === 'timeout') {
    for (const record of records) {
      if (!record.ended) {
        record.expectedTermination = true;
        await record.worker.terminate();
        forcedShutdowns += 1;
      }
    }
  }
  await Promise.all(records.map((record) => record.exitPromise));
  workerOwner.active.clear();
  return forcedShutdowns;
}

export const runtimeStateFaultWorkerSupport = {
  addWorkerStats: addRuntimeStateFaultWorkerStats,
  createWorkerOwner: createRuntimeStateFaultWorkerOwner,
  emptyWorkerStats: emptyRuntimeStateFaultWorkerStats,
  loadModules: loadRuntimeStateFaultSoakModules,
  makeLaunchRequest: makeRuntimeStateFaultLaunchRequest,
  stopWorkers: stopRuntimeStateFaultWorkers,
};

if (!isMainThread) {
  try {
    await runRuntimeStateFaultWorker(workerData);
  } catch (error) {
    parentPort?.postMessage({
      type: 'fatal',
      error: runtimeStateFaultEvidence.formatError(error),
    });
    process.exitCode = 1;
  }
}
