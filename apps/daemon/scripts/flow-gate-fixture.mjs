#!/usr/bin/env node

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';

import { createFlowGateHotPathMetrics } from './flow-gate-hot-path-metrics.mjs';
import { createDeterministicProviderRuntime } from './flow-gate-provider-runtime.mjs';

const FLOW_GATE_APPROVAL_STATUS_PATH = '/api/flow-gate/approval/status';
const FLOW_GATE_ARTIFACT_STATUS_PATH = '/api/flow-gate/artifact/status';
const FLOW_GATE_COMMENTARY_PATH = '/api/flow-gate/recovery/commentary';
const FLOW_GATE_DISCONNECT_PATH = '/api/flow-gate/recovery/disconnect';
const FLOW_GATE_FINISH_PATH = '/api/flow-gate/recovery/finish';
const FLOW_GATE_HOT_PATH_METRICS_PATH = '/api/flow-gate/hot-path/metrics';
const FLOW_GATE_MEDIA_PREPARE_PATH = '/api/flow-gate/media/prepare';
const FLOW_GATE_PROVIDER_COMPLETE_PATH = '/api/flow-gate/run/complete';
const FLOW_GATE_PROVIDER_MODELS_PATH = '/flow-gate/provider/codex/models';
const FLOW_GATE_SUBAGENT_STATUS_PATH = '/api/flow-gate/subagent/status';

function srcUrl(relative) {
  return new URL(`../src/${relative}`, import.meta.url).href;
}

async function loadDaemonModules() {
  const [
    daemon,
    context,
    runChannel,
    managedRun,
    runEventJournal,
    runtimeState,
    responsesWebSocketCache,
    providerAuthCredentials,
    shellAssets,
    mediaFiles,
    durableRunExecution,
  ] = await Promise.all([
    import(srcUrl('create-daemon.ts')),
    import(srcUrl('daemon/context.ts')),
    import(srcUrl('adapter/web/ws/run-channel.ts')),
    import(srcUrl('daemon/agent/runtime/managed-run.ts')),
    import(srcUrl('daemon/sessions/run-event-journal.ts')),
    import(srcUrl('daemon/runtime-state-store.ts')),
    import(
      srcUrl('daemon/llm/provider/transport/responses-websocket-cache.ts')
    ),
    import(srcUrl('daemon/auth/credentials/store.ts')),
    import(srcUrl('adapter/web/shell-assets.ts')),
    import(srcUrl('daemon/sessions/media-file-store.ts')),
    import(srcUrl('daemon/durable-run-execution.ts')),
  ]);
  return {
    createDaemon: daemon.createDaemon,
    createShellAssetRoutes: shellAssets.createShellAssetRoutes,
    createDaemonContext: context.createDaemonContext,
    attachRunChannelServer: runChannel.attachRunChannelServer,
    startManagedRun: managedRun.startManagedRun,
    createRunEventJournalStore: runEventJournal.createRunEventJournalStore,
    createDaemonRuntimeStateStore: runtimeState.createDaemonRuntimeStateStore,
    createResponsesWebSocketSessionStore:
      responsesWebSocketCache.createResponsesWebSocketSessionStore,
    readProviderAuthFile: providerAuthCredentials.readProviderAuthFile,
    writeProviderAuthFile: providerAuthCredentials.writeProviderAuthFile,
    recoverDurableRunsAtDaemonStartup:
      durableRunExecution.recoverDurableRunsAtDaemonStartup,
    writeThreadMediaFile: mediaFiles.writeThreadMediaFile,
  };
}

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readPort() {
  const value = Number(readRequiredEnv('PORT'));
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error('PORT must be an integer from 1 through 65535');
  }
  return value;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve(undefined);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function closeWebSocketServer(server) {
  for (const client of server.clients) {
    client.terminate();
  }
  return new Promise((resolve) => server.close(() => resolve(undefined)));
}

function closeHttpServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve(undefined)));
}

function readFlowGateFixtureConfig() {
  return {
    port: readPort(),
    homeStateRoot: readRequiredEnv('GEULBAT_HOME_STATE_ROOT'),
    shellAssetRoot: readRequiredEnv('GEULBAT_FLOW_GATE_SHELL_ASSET_ROOT'),
    artifactFinalText: readRequiredEnv('GEULBAT_FLOW_GATE_ARTIFACT_FINAL_TEXT'),
    artifactPrompt: readRequiredEnv('GEULBAT_FLOW_GATE_ARTIFACT_PROMPT'),
    approvalContent: readRequiredEnv('GEULBAT_FLOW_GATE_APPROVAL_CONTENT'),
    approvalFinalText: readRequiredEnv('GEULBAT_FLOW_GATE_APPROVAL_FINAL_TEXT'),
    approvalPrompt: readRequiredEnv('GEULBAT_FLOW_GATE_APPROVAL_PROMPT'),
    approvalTargetPath: readRequiredEnv(
      'GEULBAT_FLOW_GATE_APPROVAL_TARGET_PATH',
    ),
    workingDirectory: readRequiredEnv('GEULBAT_FLOW_GATE_WORKING_DIRECTORY'),
    initialCommentary: readRequiredEnv('GEULBAT_FLOW_GATE_INITIAL_COMMENTARY'),
    threadTitle: readRequiredEnv('GEULBAT_FLOW_GATE_THREAD_TITLE'),
    planSteerFinalText: readRequiredEnv(
      'GEULBAT_FLOW_GATE_PLAN_STEER_FINAL_TEXT',
    ),
    planSteerFollowupFinalText: readRequiredEnv(
      'GEULBAT_FLOW_GATE_PLAN_STEER_FOLLOWUP_FINAL_TEXT',
    ),
    planSteerFollowupPrompt: readRequiredEnv(
      'GEULBAT_FLOW_GATE_PLAN_STEER_FOLLOWUP_PROMPT',
    ),
    planSteerPrompt: readRequiredEnv('GEULBAT_FLOW_GATE_PLAN_STEER_PROMPT'),
    planSteerStep: readRequiredEnv('GEULBAT_FLOW_GATE_PLAN_STEER_STEP'),
    planSteerText: readRequiredEnv('GEULBAT_FLOW_GATE_PLAN_STEER_TEXT'),
    runStreamPrefix: readRequiredEnv('GEULBAT_FLOW_GATE_RUN_STREAM_PREFIX'),
    runFinalSuffix: readRequiredEnv('GEULBAT_FLOW_GATE_RUN_FINAL_SUFFIX'),
    runSettlementPrompt: readRequiredEnv(
      'GEULBAT_FLOW_GATE_RUN_SETTLEMENT_PROMPT',
    ),
    subagentChildTask: readRequiredEnv('GEULBAT_FLOW_GATE_SUBAGENT_CHILD_TASK'),
    subagentFinalText: readRequiredEnv('GEULBAT_FLOW_GATE_SUBAGENT_FINAL_TEXT'),
    subagentParentPrompt: readRequiredEnv(
      'GEULBAT_FLOW_GATE_SUBAGENT_PARENT_PROMPT',
    ),
  };
}

async function startFlowGateRecoveryFixture({
  config,
  daemonContext,
  runEventJournal,
  startManagedRun,
}) {
  const startedRun = startManagedRun(
    {
      runId: randomUUID(),
      runContext: {
        threadId: randomUUID(),
        stateRoot: config.homeStateRoot,
        workingDirectory: config.workingDirectory,
      },
      abortController: new AbortController(),
    },
    { activeRuns: daemonContext.activeRuns },
  );
  if (!startedRun.ok) {
    throw new Error('flow-gate recovery run could not be started');
  }
  await daemonContext.threadIndex.upsertThreadSummary(config.homeStateRoot, {
    threadId: startedRun.threadId,
    title: config.threadTitle,
    lastUpdated: new Date().toISOString(),
    messageCount: 0,
  });

  const fixtureOwnerId = `flow-gate-fixture-${randomUUID()}`;
  let latestSeq = -1;
  let finished = false;
  daemonContext.liveRunEvents.startRun({
    runId: startedRun.runId,
    threadId: startedRun.threadId,
    ownerId: fixtureOwnerId,
    sink: () => false,
    async persistRunEvents(events) {
      await runEventJournal.append({
        threadId: startedRun.threadId,
        runId: startedRun.runId,
        events,
      });
    },
    async readPersistedRunEvents(throughSeq) {
      return (
        await runEventJournal.read({
          threadId: startedRun.threadId,
          runId: startedRun.runId,
        })
      ).filter((record) => record.seq <= throughSeq);
    },
  });
  latestSeq = daemonContext.liveRunEvents.publishRunEvent(startedRun.runId, {
    type: 'run_ack',
    payload: {
      runId: startedRun.runId,
      threadId: startedRun.threadId,
    },
  }).seq;
  latestSeq = daemonContext.liveRunEvents.publishRunEvent(startedRun.runId, {
    type: 'commentary_delta',
    payload: { text: config.initialCommentary },
  }).seq;

  return {
    isFinished() {
      return finished;
    },
    publishCommentary(text) {
      const published = daemonContext.liveRunEvents.publishRunEvent(
        startedRun.runId,
        {
          type: 'commentary_delta',
          payload: { text },
        },
      );
      latestSeq = published.seq;
      return published.delivery;
    },
    async finish() {
      let persistedEventCount;
      if (!finished) {
        await daemonContext.liveRunEvents.flushRunEventHistory(
          startedRun.runId,
        );
        persistedEventCount = (
          await runEventJournal.read({
            threadId: startedRun.threadId,
            runId: startedRun.runId,
          })
        ).length;
        await daemonContext.liveRunEvents.bindRuns({
          ownerId: `${fixtureOwnerId}-cleanup`,
          sink: () => true,
          afterSeqByRun: new Map([[startedRun.runId, latestSeq]]),
        });
        daemonContext.liveRunEvents.finishRun(startedRun.runId);
        startedRun.finish();
        finished = true;
      }
      return { latestSeq, persistedEventCount };
    },
    async close() {
      if (finished) {
        return;
      }
      await daemonContext.liveRunEvents.flushRunEventHistory(startedRun.runId);
      daemonContext.liveRunEvents.finishRun(startedRun.runId);
      startedRun.finish();
      finished = true;
    },
  };
}

function registerFlowGateStatusRoutes({
  app,
  config,
  deterministicProvider,
  hotPathMetrics,
}) {
  app.get(FLOW_GATE_APPROVAL_STATUS_PATH, async (_request, response) => {
    try {
      const content = await readFile(config.approvalTargetPath, 'utf8');
      response.json({
        ok: true,
        exists: true,
        matchesExpectedContent: content === config.approvalContent,
        providerRequestCount: deterministicProvider.readApprovalRequestCount(),
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        response.json({
          ok: true,
          exists: false,
          matchesExpectedContent: false,
          providerRequestCount:
            deterministicProvider.readApprovalRequestCount(),
        });
        return;
      }
      response.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.get(FLOW_GATE_ARTIFACT_STATUS_PATH, (_request, response) => {
    response.json({
      ok: true,
      providerRequestCount: deterministicProvider.readArtifactRequestCount(),
    });
  });
  app.get(FLOW_GATE_SUBAGENT_STATUS_PATH, (_request, response) => {
    response.json({
      ok: true,
      ...deterministicProvider.readSubagentState(),
    });
  });
  app.get(FLOW_GATE_HOT_PATH_METRICS_PATH, (request, response) => {
    const runId =
      typeof request.query.runId === 'string' ? request.query.runId : '';
    if (runId.trim() === '') {
      response.status(400).json({
        ok: false,
        message: 'runId is required',
      });
      return;
    }
    const metrics = hotPathMetrics.readRun(runId);
    if (metrics === null) {
      response.status(404).json({
        ok: false,
        message: 'flow-gate hot-path metrics were not found',
      });
      return;
    }
    response.json({ ok: true, metrics });
  });
  app.get(FLOW_GATE_PROVIDER_MODELS_PATH, (_request, response) => {
    response.json({
      models: [
        {
          slug: 'gpt-5.6-sol',
          context_window: 272_000,
          auto_compact_token_limit: null,
          supports_parallel_tool_calls: true,
        },
      ],
    });
  });
}

function registerFlowGateControlRoutes({
  app,
  config,
  deterministicProvider,
  recoveryFixture,
  runChannelServer,
  writeThreadMediaFile,
}) {
  app.post(FLOW_GATE_DISCONNECT_PATH, async (_request, response) => {
    const clients = [...runChannelServer.clients];
    await Promise.all(
      clients.map(
        (client) =>
          new Promise((resolve) => {
            client.once('close', resolve);
            client.terminate();
          }),
      ),
    );
    response.json({
      ok: true,
      disconnectedClientCount: clients.length,
    });
  });
  app.post(FLOW_GATE_COMMENTARY_PATH, (request, response) => {
    const text =
      typeof request.body === 'object' &&
      request.body !== null &&
      typeof request.body.text === 'string'
        ? request.body.text
        : '';
    if (text.trim() === '') {
      response.status(400).json({
        ok: false,
        message: 'commentary text is required',
      });
      return;
    }
    if (recoveryFixture.isFinished()) {
      response.status(409).json({
        ok: false,
        message: 'recovery fixture is already finished',
      });
      return;
    }
    response.json({
      ok: true,
      delivery: recoveryFixture.publishCommentary(text),
    });
  });
  app.post(FLOW_GATE_FINISH_PATH, async (_request, response) => {
    response.json({ ok: true, ...(await recoveryFixture.finish()) });
  });
  app.post(FLOW_GATE_PROVIDER_COMPLETE_PATH, (_request, response) => {
    try {
      deterministicProvider.completeRunSettlement();
      response.json({
        ok: true,
        providerRequestCount:
          deterministicProvider.readRunSettlementRequestCount(),
        providerEvents: deterministicProvider.readRunSettlementEventCounts(),
      });
    } catch (error) {
      response.status(409).json({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  app.post(FLOW_GATE_MEDIA_PREPARE_PATH, async (_request, response) => {
    try {
      const threadId = randomUUID();
      const bytes = Buffer.from(
        'flow-gate media survives the daemon process replacement',
        'utf8',
      );
      const media = await writeThreadMediaFile({
        workspaceRoot: config.homeStateRoot,
        threadId,
        extension: 'mp4',
        bytes,
        maxBytes: bytes.byteLength,
      });
      response.json({
        ok: true,
        threadId,
        mediaRef: media.mediaRef,
        expectedText: bytes.toString('utf8'),
      });
    } catch (error) {
      response.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function createFlowGateFixtureClose({
  daemonContext,
  deterministicProvider,
  recoveryFixture,
  runChannelServer,
  runtimeStateStore,
  server,
}) {
  let closing;
  return () => {
    closing ??= (async () => {
      await recoveryFixture.close();
      await closeWebSocketServer(runChannelServer);
      await closeHttpServer(server);
      daemonContext.activeRuns.abortAllRuns('daemon_shutdown');
      await daemonContext.activeRuns.waitForIdle();
      await daemonContext.subagent.launchPromotions?.close();
      await Promise.allSettled([
        daemonContext.globalMcp.close(),
        daemonContext.computerDirectoryPicker.close(),
        daemonContext.ptc.browserPageLoadEvidence.closeAll(),
        daemonContext.ptc.browserTextEvidence.closeAll(),
        daemonContext.ptc.browserNavigate.closeAll(),
        daemonContext.ptc.executeCode.closeAll(),
        daemonContext.hostCommands.closeAll(),
        daemonContext.provider.authCallbackServer.close(),
        deterministicProvider.webSocketSessions.closeAll(),
      ]);
      runtimeStateStore.close();
    })();
    return closing;
  };
}

async function startFlowGateFixtureDaemon() {
  const config = readFlowGateFixtureConfig();
  await mkdir(config.homeStateRoot, { recursive: true });

  const {
    createDaemon,
    createDaemonContext,
    attachRunChannelServer,
    startManagedRun,
    createRunEventJournalStore,
    createDaemonRuntimeStateStore,
    createResponsesWebSocketSessionStore,
    readProviderAuthFile,
    writeProviderAuthFile,
    createShellAssetRoutes,
    recoverDurableRunsAtDaemonStartup,
    writeThreadMediaFile,
  } = await loadDaemonModules();
  const runtimeStateStore = await createDaemonRuntimeStateStore({
    homeStateRoot: config.homeStateRoot,
  });
  const daemonContext = createDaemonContext({
    homeStateRoot: config.homeStateRoot,
    subagentLaunchRequests: runtimeStateStore,
    subagentTerminalDeliveries: runtimeStateStore,
  });
  const hotPathMetrics = createFlowGateHotPathMetrics(
    daemonContext.liveRunEvents,
  );
  daemonContext.globalMcp.attachSessionCoordinateStore(runtimeStateStore);
  const deterministicProvider = createDeterministicProviderRuntime(
    createResponsesWebSocketSessionStore,
    config,
  );
  await daemonContext.provider.webSocketSessions.closeAll();
  daemonContext.provider.webSocketSessions =
    deterministicProvider.webSocketSessions;
  if ((await readProviderAuthFile()) === null) {
    await writeProviderAuthFile(
      {
        accessToken: 'flow-gate-provider-access',
        refreshToken: 'flow-gate-provider-refresh',
        accountId: 'flow-gate-provider-account',
        expiresAt: Date.UTC(2099, 0, 1),
      },
      'openai_codex_direct',
      daemonContext.provider.credentialFilePermissionHardener,
    );
  }
  const discoveredComputerFileScope = daemonContext.computerFileScope;
  daemonContext.computerFileScope = {
    root: discoveredComputerFileScope?.root ?? config.workingDirectory,
    browseStartPath: config.workingDirectory,
    // Keep the production-owned array reference. WSL/Windows discovery may
    // finish after context construction and updates this array in place; the
    // fixture only replaces the isolated browse start, not the discovered
    // drive/known-folder projection under test.
    browseShortcuts: discoveredComputerFileScope?.browseShortcuts ?? [],
  };
  daemonContext.computerFileRoot = daemonContext.computerFileScope.root;

  await recoverDurableRunsAtDaemonStartup(daemonContext);
  const recoveryFixture = await startFlowGateRecoveryFixture({
    config,
    daemonContext,
    runEventJournal: createRunEventJournalStore({
      stateRoot: config.homeStateRoot,
    }),
    startManagedRun,
  });
  const { app } = await createDaemon({ daemonContext });
  const server = http.createServer(app);
  const runChannelServer = attachRunChannelServer(server, {
    runtimeContext: daemonContext,
  });
  registerFlowGateStatusRoutes({
    app,
    config,
    deterministicProvider,
    hotPathMetrics,
  });
  registerFlowGateControlRoutes({
    app,
    config,
    deterministicProvider,
    recoveryFixture,
    runChannelServer,
    writeThreadMediaFile,
  });
  // shell SPA fallback은 마지막에 온다. 앞에 두면 fixture의 provider/control
  // 라우트를 문서 200으로 삼켜서 실행이 시작조차 못 한다.
  app.use(createShellAssetRoutes({ shellAssetRoot: config.shellAssetRoot }));
  await listen(server, config.port);

  const close = createFlowGateFixtureClose({
    daemonContext,
    deterministicProvider,
    recoveryFixture,
    runChannelServer,
    runtimeStateStore,
    server,
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void close().finally(() => process.exit(0));
    });
  }

  return { close };
}

await startFlowGateFixtureDaemon();
