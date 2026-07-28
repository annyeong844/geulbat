function createRunMetrics(runId, threadId) {
  return {
    runId,
    threadId,
    emittedRunEventCount: 0,
    emittedEventTypeCounts: new Map(),
    transientRunEventCount: 0,
    terminalRunEventCount: 0,
    journalAppendCount: 0,
    journalEventCount: 0,
    durableReplayReadCount: 0,
    durableReplayReadThroughSeqs: [],
    replayBindings: [],
  };
}

function readRunMetrics(metricsByRun, runId, threadId) {
  const existing = metricsByRun.get(runId);
  if (existing !== undefined) {
    if (existing.threadId !== threadId) {
      throw new Error(`flow-gate run identity changed thread: ${runId}`);
    }
    return existing;
  }
  const created = createRunMetrics(runId, threadId);
  metricsByRun.set(runId, created);
  return created;
}

function recordEmittedEvent(metrics, event) {
  metrics.emittedRunEventCount += 1;
  metrics.emittedEventTypeCounts.set(
    event.type,
    (metrics.emittedEventTypeCounts.get(event.type) ?? 0) + 1,
  );
}

function snapshotRunMetrics(metrics) {
  return {
    runId: metrics.runId,
    threadId: metrics.threadId,
    emittedRunEventCount: metrics.emittedRunEventCount,
    emittedEventTypeCounts: Object.fromEntries(
      [...metrics.emittedEventTypeCounts.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    transientRunEventCount: metrics.transientRunEventCount,
    terminalRunEventCount: metrics.terminalRunEventCount,
    journalAppendCount: metrics.journalAppendCount,
    journalEventCount: metrics.journalEventCount,
    durableReplayReadCount: metrics.durableReplayReadCount,
    durableReplayReadThroughSeqs: [...metrics.durableReplayReadThroughSeqs],
    replayBindings: metrics.replayBindings.map((binding) => ({ ...binding })),
  };
}

export function createFlowGateHotPathMetrics(liveRunEvents) {
  const metricsByRun = new Map();
  const startRun = liveRunEvents.startRun.bind(liveRunEvents);
  const publishRunEvent = liveRunEvents.publishRunEvent.bind(liveRunEvents);
  const publishTransientRunEvent =
    liveRunEvents.publishTransientRunEvent.bind(liveRunEvents);
  const commitTerminalRunEvent =
    liveRunEvents.commitTerminalRunEvent.bind(liveRunEvents);
  const bindRuns = liveRunEvents.bindRuns.bind(liveRunEvents);

  liveRunEvents.startRun = (args) => {
    const metrics = readRunMetrics(metricsByRun, args.runId, args.threadId);
    const readPersistedRunEvents = args.readPersistedRunEvents;
    startRun({
      ...args,
      async persistRunEvents(events) {
        await args.persistRunEvents(events);
        metrics.journalAppendCount += 1;
        metrics.journalEventCount += events.length;
      },
      ...(readPersistedRunEvents === undefined
        ? {}
        : {
            async readPersistedRunEvents(throughSeq) {
              const events = await readPersistedRunEvents(throughSeq);
              metrics.durableReplayReadCount += 1;
              metrics.durableReplayReadThroughSeqs.push(throughSeq);
              return events;
            },
          }),
    });
  };

  liveRunEvents.publishRunEvent = (runId, event) => {
    const published = publishRunEvent(runId, event);
    const metrics = metricsByRun.get(runId);
    if (metrics === undefined) {
      throw new Error(`flow-gate metrics did not observe run start: ${runId}`);
    }
    recordEmittedEvent(metrics, event);
    return published;
  };

  liveRunEvents.publishTransientRunEvent = (runId, event) => {
    const published = publishTransientRunEvent(runId, event);
    const metrics = metricsByRun.get(runId);
    if (metrics === undefined) {
      throw new Error(`flow-gate metrics did not observe run start: ${runId}`);
    }
    metrics.transientRunEventCount += 1;
    return published;
  };

  liveRunEvents.commitTerminalRunEvent = async (args) => {
    const published = await commitTerminalRunEvent(args);
    const metrics = metricsByRun.get(args.runId);
    if (metrics === undefined) {
      throw new Error(
        `flow-gate metrics did not observe run start: ${args.runId}`,
      );
    }
    recordEmittedEvent(metrics, args.event);
    metrics.terminalRunEventCount += 1;
    return published;
  };

  liveRunEvents.bindRuns = async (args) => {
    const durableReadCountsBefore = new Map(
      [...metricsByRun.entries()].map(([runId, metrics]) => [
        runId,
        metrics.durableReplayReadCount,
      ]),
    );
    let collectingReplayEvents = true;
    const replayEventCountsByRun = new Map();
    const measuredSink = (envelope) => {
      if (collectingReplayEvents) {
        replayEventCountsByRun.set(
          envelope.runId,
          (replayEventCountsByRun.get(envelope.runId) ?? 0) + 1,
        );
      }
      return args.sink(envelope);
    };
    measuredSink.transient = args.sink.transient;
    let bound;
    try {
      bound = await bindRuns({ ...args, sink: measuredSink });
    } finally {
      collectingReplayEvents = false;
    }
    for (const run of bound) {
      const metrics = metricsByRun.get(run.runId);
      if (metrics === undefined) {
        throw new Error(
          `flow-gate metrics did not observe bound run: ${run.runId}`,
        );
      }
      metrics.replayBindings.push({
        afterSeq: args.afterSeqByRun?.get(run.runId) ?? null,
        deliveredEventCount: replayEventCountsByRun.get(run.runId) ?? 0,
        source:
          metrics.durableReplayReadCount >
          (durableReadCountsBefore.get(run.runId) ?? 0)
            ? 'durable_journal'
            : 'live_history',
      });
    }
    return bound;
  };

  return {
    readRun(runId) {
      const metrics = metricsByRun.get(runId);
      return metrics === undefined ? null : snapshotRunMetrics(metrics);
    },
  };
}
