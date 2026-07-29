import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

export const DAEMON_HOT_PATH_MEMORY_SCENARIOS = [
  'live_event_history',
  'checkpoint_hydration',
  'transcript_cache',
];

const checkpointStoreModule = new URL(
  '../src/daemon/sessions/run-checkpoint-store.ts',
  import.meta.url,
);
const liveRunEventsModule = new URL(
  '../src/daemon/sessions/live-run-events.ts',
  import.meta.url,
);
const transcriptLogModule = new URL(
  '../src/daemon/sessions/transcript-log.ts',
  import.meta.url,
);

async function runDaemonHotPathMemoryWorker(options) {
  assertExplicitGcAvailable();
  const startedAt = performance.now();
  const stateRoot = await mkdtemp(
    path.join(tmpdir(), `geulbat-memory-${options.scenario}-`),
  );
  try {
    const samples = await runScenario({
      ...options,
      stateRoot,
    });
    options.signal.throwIfAborted();
    return {
      schemaVersion: 1,
      scenario: options.scenario,
      samples,
      durationMs: round(performance.now() - startedAt),
    };
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

async function runScenario(options) {
  if (options.scenario === 'live_event_history') {
    return await measureLiveEventHistory(options);
  }
  if (options.scenario === 'checkpoint_hydration') {
    return await measureCheckpointHydration(options);
  }
  if (options.scenario === 'transcript_cache') {
    return await measureTranscriptCache(options);
  }
  throw new Error(
    `unknown daemon hot-path memory scenario: ${options.scenario}`,
  );
}

async function measureLiveEventHistory({
  stateRoot,
  sampleCounts,
  payloadBytes,
  signal,
}) {
  const [{ createRunCheckpointStore }, { createLiveRunEventStore }] =
    await Promise.all([
      import(checkpointStoreModule),
      import(liveRunEventsModule),
    ]);
  const checkpointStore = createRunCheckpointStore({ stateRoot });
  const liveRunEvents = createLiveRunEventStore();
  const runId = randomUUID();
  const threadId = randomUUID();
  const started = await checkpointStore.startRun({
    runId,
    threadId,
    request: {
      workingDirectory: stateRoot,
      permissionMode: 'basic',
    },
  });
  if (!started.ok) {
    throw new Error('memory probe could not start its live run checkpoint');
  }
  let durableReplayReadCount = 0;
  liveRunEvents.startRun({
    runId,
    threadId,
    ownerId: 'memory-probe-source',
    sink: () => true,
    async persistRunEvents(events) {
      await checkpointStore.appendRunEvents({ threadId, runId, events });
    },
    async readPersistedRunEvents() {
      durableReplayReadCount += 1;
      return (await checkpointStore.readThread(threadId))?.eventHistory ?? [];
    },
  });

  const journalPath = path.join(
    stateRoot,
    '.geulbat',
    'run-event-journals',
    threadId,
    `${runId}.jsonl`,
  );
  const samples = [];
  let previousCount = 0;
  let baseline;
  for (const itemCount of sampleCounts) {
    signal.throwIfAborted();
    await publishLiveEvents({
      liveRunEvents,
      runId,
      start: previousCount,
      end: itemCount,
      payloadBytes,
      signal,
    });
    await liveRunEvents.flushRunEventHistory(runId);
    let residentReplayEventCount = 0;
    await liveRunEvents.bindRuns({
      ownerId: 'memory-probe-observer',
      sink: () => {
        residentReplayEventCount += 1;
        return true;
      },
    });
    await forceFullGc();
    const memory = readMemorySnapshot();
    baseline ??= memory;
    samples.push({
      itemCount,
      memory,
      owner: {
        durableFileBytes: await readFileBytes(journalPath),
        residentReplayEventCount,
        durableReplayReadCount,
      },
      retainedHeapDeltaBytes: memory.heapUsedBytes - baseline.heapUsedBytes,
      rssDeltaBytes: memory.rssBytes - baseline.rssBytes,
    });
    previousCount = itemCount;
  }
  return samples;
}

async function publishLiveEvents({
  liveRunEvents,
  runId,
  start,
  end,
  payloadBytes,
  signal,
}) {
  for (let index = start; index < end; index += 1) {
    signal.throwIfAborted();
    liveRunEvents.publishRunEvent(runId, {
      type: 'commentary_delta',
      payload: { text: buildPayload(index, payloadBytes) },
    });
  }
}

async function measureCheckpointHydration({
  stateRoot,
  sampleCounts,
  payloadBytes,
  signal,
}) {
  const { createRunCheckpointStore } = await import(checkpointStoreModule);
  const checkpointStore = createRunCheckpointStore({ stateRoot });
  const runId = randomUUID();
  const threadId = randomUUID();
  const started = await checkpointStore.startRun({
    runId,
    threadId,
    request: {
      workingDirectory: stateRoot,
      permissionMode: 'basic',
    },
  });
  if (!started.ok) {
    throw new Error('memory probe could not start its hydration checkpoint');
  }
  const checkpointPath = path.join(
    stateRoot,
    '.geulbat',
    'run-checkpoints',
    `${threadId}.json`,
  );
  const journalPath = path.join(
    stateRoot,
    '.geulbat',
    'run-event-journals',
    threadId,
    `${runId}.jsonl`,
  );
  const samples = [];
  let previousCount = 0;
  let baseline;
  for (const itemCount of sampleCounts) {
    signal.throwIfAborted();
    await appendCheckpointEvents({
      checkpointStore,
      runId,
      threadId,
      start: previousCount,
      end: itemCount,
      payloadBytes,
      signal,
    });
    await forceFullGc();
    const beforeHydration = readMemorySnapshot();
    let hydrated = await checkpointStore.readThread(threadId);
    if (hydrated === null) {
      throw new Error('memory probe checkpoint disappeared during hydration');
    }
    const eventHistoryCount = hydrated.eventHistory.length;
    await forceFullGc();
    const whileHydrated = readMemorySnapshot();
    const hydratedHeapDeltaBytes =
      whileHydrated.heapUsedBytes - beforeHydration.heapUsedBytes;
    hydrated = null;
    await forceFullGc();
    const memory = readMemorySnapshot();
    baseline ??= memory;
    const checkpointFileBytes = await readFileBytes(checkpointPath);
    const journalFileBytes = await readFileBytes(journalPath);
    samples.push({
      itemCount,
      memory,
      owner: {
        durableFileBytes: checkpointFileBytes + journalFileBytes,
        journalFileBytes,
        checkpointFileBytes,
        eventHistoryCount,
        hydratedHeapDeltaBytes,
      },
      retainedHeapDeltaBytes: memory.heapUsedBytes - baseline.heapUsedBytes,
      rssDeltaBytes: memory.rssBytes - baseline.rssBytes,
    });
    previousCount = itemCount;
  }
  return samples;
}

async function appendCheckpointEvents({
  checkpointStore,
  runId,
  threadId,
  start,
  end,
  payloadBytes,
  signal,
}) {
  if (start === end) {
    return;
  }
  const events = [];
  for (let index = start; index < end; index += 1) {
    signal.throwIfAborted();
    events.push({
      seq: index,
      event: {
        type: 'commentary_delta',
        payload: { text: buildPayload(index, payloadBytes) },
      },
    });
  }
  await checkpointStore.appendRunEvents({ threadId, runId, events });
}

async function measureTranscriptCache({
  stateRoot,
  sampleCounts,
  payloadBytes,
  signal,
}) {
  const {
    appendTranscriptEntries,
    getTranscriptEntryCacheSizeForTests,
    getTranscriptEntryParseCountForTests,
    readTranscriptEntries,
    resetTranscriptEntryCacheForTests,
  } = await import(transcriptLogModule);
  resetTranscriptEntryCacheForTests();
  const threadId = randomUUID();
  const transcriptPath = path.join(
    stateRoot,
    '.geulbat',
    'sessions',
    `${threadId}.jsonl`,
  );
  const samples = [];
  let previousCount = 0;
  let baseline;
  try {
    for (const itemCount of sampleCounts) {
      signal.throwIfAborted();
      await appendTranscriptBatch({
        appendTranscriptEntries,
        stateRoot,
        threadId,
        start: previousCount,
        end: itemCount,
        payloadBytes,
        signal,
      });
      let cachedEntryCount = 0;
      if (itemCount > 0) {
        let entries = await readTranscriptEntries(stateRoot, threadId);
        cachedEntryCount = entries.length;
        entries = null;
      }
      await forceFullGc();
      const memory = readMemorySnapshot();
      baseline ??= memory;
      samples.push({
        itemCount,
        memory,
        owner: {
          durableFileBytes: await readFileBytes(transcriptPath),
          cachedEntryCount,
          cachedThreadCount: getTranscriptEntryCacheSizeForTests(),
          parseCount: getTranscriptEntryParseCountForTests(),
        },
        retainedHeapDeltaBytes: memory.heapUsedBytes - baseline.heapUsedBytes,
        rssDeltaBytes: memory.rssBytes - baseline.rssBytes,
      });
      previousCount = itemCount;
    }
    return samples;
  } finally {
    resetTranscriptEntryCacheForTests();
  }
}

async function appendTranscriptBatch({
  appendTranscriptEntries,
  stateRoot,
  threadId,
  start,
  end,
  payloadBytes,
  signal,
}) {
  if (start === end) {
    return;
  }
  const entries = [];
  for (let index = start; index < end; index += 1) {
    signal.throwIfAborted();
    entries.push({
      role: 'user',
      content: buildPayload(index, payloadBytes),
      timestamp: new Date(index).toISOString(),
    });
  }
  await appendTranscriptEntries(stateRoot, threadId, entries);
}

function buildPayload(index, payloadBytes) {
  const buffer = Buffer.alloc(payloadBytes, 120);
  buffer.write(String(index), 0, payloadBytes, 'utf8');
  return buffer.toString('utf8');
}

async function forceFullGc() {
  globalThis.gc();
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.gc();
  await new Promise((resolve) => setImmediate(resolve));
}

function readMemorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

async function readFileBytes(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

function assertExplicitGcAvailable() {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('daemon hot-path memory worker requires --expose-gc');
  }
}

function parseArgs(argv) {
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
  const allowed = new Set(['--payload-bytes', '--sample-counts', '--scenario']);
  for (const option of values.keys()) {
    if (!allowed.has(option)) {
      throw new Error(`unknown option: ${option}`);
    }
  }
  const scenario = readRequiredOption(values, '--scenario');
  if (!DAEMON_HOT_PATH_MEMORY_SCENARIOS.includes(scenario)) {
    throw new Error(`unknown daemon hot-path memory scenario: ${scenario}`);
  }
  return {
    scenario,
    sampleCounts: parseSampleCounts(
      readRequiredOption(values, '--sample-counts'),
    ),
    payloadBytes: parsePositiveInteger(
      readRequiredOption(values, '--payload-bytes'),
      '--payload-bytes',
    ),
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
  return Math.round(value * 1000) / 1000;
}

async function main() {
  const controller = new AbortController();
  let stopSignal;
  const stop = (signal) => {
    stopSignal ??= signal;
    controller.abort(new Error(`memory probe worker received ${signal}`));
  };
  const signalHandlers = [
    ['SIGINT', () => stop('SIGINT')],
    ['SIGTERM', () => stop('SIGTERM')],
  ];
  for (const [signal, handler] of signalHandlers) {
    process.once(signal, handler);
  }
  try {
    const result = await runDaemonHotPathMemoryWorker({
      ...parseArgs(process.argv.slice(2)),
      signal: controller.signal,
    });
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    if (stopSignal === undefined) {
      throw error;
    }
    const signalNumber = osConstants.signals[stopSignal];
    return signalNumber === undefined ? 1 : 128 + signalNumber;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
