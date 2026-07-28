function incrementCount(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCountRecord(counts) {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) =>
      String(left).localeCompare(String(right)),
    ),
  );
}

function readRunEventFrame(payload) {
  let message;
  try {
    message = JSON.parse(
      typeof payload === 'string' ? payload : payload.toString('utf8'),
    );
  } catch {
    return null;
  }
  if (
    typeof message !== 'object' ||
    message === null ||
    message.type !== 'run.event' ||
    typeof message.event !== 'object' ||
    message.event === null ||
    typeof message.event.runId !== 'string' ||
    typeof message.event.threadId !== 'string' ||
    !Number.isSafeInteger(message.event.seq) ||
    typeof message.event.type !== 'string'
  ) {
    return null;
  }
  return message.event;
}

function snapshotObservedRun(run, observer) {
  const sequenceCounts = [...run.sequenceCounts.entries()].sort(
    ([left], [right]) => left - right,
  );
  const sequences = sequenceCounts.map(([sequence]) => sequence);
  return {
    runId: run.runId,
    threadId: run.threadId,
    runChannelSocketCount: observer.runChannelSocketCount,
    receivedWebSocketFrameCount: observer.receivedWebSocketFrameCount,
    runEventFrameCount: run.runEventFrameCount,
    uniqueSequenceCount: sequenceCounts.length,
    duplicateSequenceCount: sequenceCounts.reduce(
      (total, [, count]) => total + Math.max(0, count - 1),
      0,
    ),
    firstSequence: sequences[0] ?? null,
    lastSequence: sequences.at(-1) ?? null,
    eventTypeCounts: sortedCountRecord(run.eventTypeCounts),
  };
}

export function observeFlowGateRunEventFrames(page) {
  const observer = {
    runChannelSocketCount: 0,
    receivedWebSocketFrameCount: 0,
  };
  const runs = new Map();

  page.on('websocket', (socket) => {
    let pathname;
    try {
      pathname = new URL(socket.url()).pathname;
    } catch {
      return;
    }
    if (pathname !== '/api/ws') {
      return;
    }
    observer.runChannelSocketCount += 1;
    socket.on('framereceived', ({ payload }) => {
      observer.receivedWebSocketFrameCount += 1;
      const event = readRunEventFrame(payload);
      if (event === null) {
        return;
      }
      let run = runs.get(event.runId);
      if (run === undefined) {
        run = {
          runId: event.runId,
          threadId: event.threadId,
          runEventFrameCount: 0,
          sequenceCounts: new Map(),
          eventTypeCounts: new Map(),
        };
        runs.set(event.runId, run);
      } else if (run.threadId !== event.threadId) {
        throw new Error(
          `flow-gate browser observed one run on two threads: ${event.runId}`,
        );
      }
      run.runEventFrameCount += 1;
      incrementCount(run.sequenceCounts, event.seq);
      incrementCount(run.eventTypeCounts, event.type);
    });
  });

  return {
    readSingleRun() {
      if (runs.size !== 1) {
        throw new Error(
          `flow-gate browser observed ${String(runs.size)} runs instead of one`,
        );
      }
      return snapshotObservedRun(runs.values().next().value, observer);
    },
  };
}

function assertSameRunIdentity(label, browser, daemon) {
  if (browser.runId !== daemon.runId || browser.threadId !== daemon.threadId) {
    throw new Error(`${label} crossed run or thread identity`);
  }
}

function assertContiguousExactlyOnce(label, browser, daemon) {
  const expectedJournaledEvents =
    daemon.emittedRunEventCount - daemon.terminalRunEventCount;
  if (daemon.journalEventCount !== expectedJournaledEvents) {
    throw new Error(`${label} journal did not contain every journaled event`);
  }
  if (
    browser.uniqueSequenceCount !== daemon.emittedRunEventCount ||
    browser.runEventFrameCount !== daemon.emittedRunEventCount ||
    browser.duplicateSequenceCount !== 0 ||
    browser.firstSequence !== 0 ||
    browser.lastSequence !== daemon.emittedRunEventCount - 1
  ) {
    throw new Error(`${label} WebSocket sequence was not contiguous once`);
  }
}

export function buildFlowGateHotPathReport({
  environment,
  reconnectRecovery,
  runSettlement,
}) {
  assertSameRunIdentity(
    'reconnect recovery',
    reconnectRecovery.browser,
    reconnectRecovery.daemon,
  );
  assertSameRunIdentity(
    'run settlement',
    runSettlement.browser,
    runSettlement.daemon,
  );
  assertContiguousExactlyOnce(
    'reconnect recovery',
    reconnectRecovery.browser,
    reconnectRecovery.daemon,
  );
  assertContiguousExactlyOnce(
    'run settlement',
    runSettlement.browser,
    runSettlement.daemon,
  );
  const reconnectBinding = reconnectRecovery.daemon.replayBindings
    .filter((binding) => binding.deliveredEventCount > 0)
    .at(-1);
  if (
    reconnectBinding?.source !== 'live_history' ||
    reconnectBinding.deliveredEventCount !== 1 ||
    reconnectRecovery.daemon.durableReplayReadCount !== 0
  ) {
    throw new Error(
      'flow-gate reconnect recovery did not use resident live history',
    );
  }
  if (
    runSettlement.provider.requestCount !== 1 ||
    runSettlement.provider.eventCount <= 0 ||
    runSettlement.provider.textDeltaCount <= 0
  ) {
    throw new Error('flow-gate provider evidence is incomplete');
  }

  return {
    schemaVersion: 'flow_gate_hot_path_v1',
    environment,
    workload: {
      reconnectRecovery: 'disconnect, buffer one event, reconnect by cursor',
      runSettlement:
        'one deterministic provider request, two text deltas, terminal settlement, reload',
    },
    measurements: {
      reconnectRecovery: {
        ...reconnectRecovery,
        reconnectReplay: reconnectBinding,
      },
      runSettlement,
    },
    invariants: {
      sameRunIdentityAcrossOwners: true,
      journalCoversEveryJournaledEvent: true,
      webSocketSequenceContiguousExactlyOnce: true,
      reconnectReplaySourceObserved: true,
    },
  };
}
