import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertRunId } from '@geulbat/protocol/ids';
import { isAgentRetryToolRaw } from '@geulbat/protocol/run-events';

import type { RunChannelRuntimeContext } from './adapter/web/ws/run-channel-runtime-context.js';
import { createDaemonRuntimeOwner } from './daemon-runtime-owner.js';
import {
  closeDaemonRuntimeSessions,
  type DaemonRuntimeSessionClosers,
} from './daemon-server-lifecycle.js';
import { createDaemonContext, type DaemonContext } from './daemon/context.js';
import {
  createDaemonRuntimeStateStore,
  type DaemonRuntimeStateStore,
} from './daemon/runtime-state-store.js';
import { createRunState } from './daemon/agent/runtime/run-state.js';
import { createAgentRetryTool } from './daemon/tools/builtin/agent-retry.js';
import { agentWaitTool } from './daemon/tools/builtin/agent-wait.js';
import { makeRunContext } from './test-support/run-context.js';
import { testRunId } from './test-support/run-id.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from './test-support/subagent-model-routing.js';
import { testThreadId } from './test-support/thread-id.js';

interface FakeApp {
  kind: 'app';
}

interface FakeServer {
  kind: 'server';
}

interface FakeSocketServer {
  kind: 'socket';
}

interface FakeCloseArgs {
  admissionLock: { release(): Promise<void> };
  runtimeSessions: DaemonRuntimeSessionClosers;
  server: FakeServer;
  webSocketServers: readonly FakeSocketServer[];
  signal?: AbortSignal;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createRuntimeStateStore(
  onClose: () => void = () => {},
): DaemonRuntimeStateStore {
  return {
    databasePath: '/fake/runtime-state.sqlite3',
    readMcpSessionCoordinate: () => undefined,
    persistMcpSessionCoordinate: () => {},
    deleteMcpSessionCoordinate: () => {},
    enqueueSubagentLaunchBatch() {
      throw new Error('not used by daemon runtime owner tests');
    },
    readSubagentLaunchRequest: () => undefined,
    readSubagentLaunchRequestByChildRunId: () => undefined,
    readQueuedSubagentLaunchRequests: () => [],
    markSubagentLaunchDeferredBatch: () => [],
    cancelQueuedSubagentLaunchRequest() {
      throw new Error('not used by runtime owner test');
    },
    updateQueuedSubagentLaunchPriority() {
      throw new Error('not used by runtime owner test');
    },
    retryInterruptedSubagentLaunch() {
      throw new Error('not used by runtime owner test');
    },
    markSubagentLaunchStarting: () => {},
    markSubagentLaunchStarted: () => {},
    markSubagentLaunchFailedToStart: () => {},
    recordSubagentRuntimeObservation: () => {},
    recordSubagentTerminalDelivery() {
      throw new Error('not used by daemon runtime owner tests');
    },
    readPendingSubagentTerminalDeliveries: () => [],
    readSubagentTerminalDeliveries: () => [],
    acknowledgeSubagentTerminalDeliveries: () => {},
    clearSubagentTerminalDeliveries: () => {},
    readSubagentTerminalOutcomeByChildRunId: () => undefined,
    readSubagentTerminalOutcomeByResultRef: () => undefined,
    isSubagentResultReaderInOwnerScope: () => false,
    close: onClose,
    readDiagnostics: () => ({
      foreignKeysEnabled: true,
      journalMode: 'wal',
      schemaVersion: 8,
      startupHealth: 'ok',
      startupMigration: null,
      synchronousMode: 'full',
    }),
  };
}

async function withDaemonContext(
  run: (daemonContext: DaemonContext, homeStateRoot: string) => Promise<void>,
): Promise<void> {
  const homeStateRoot = await mkdtemp(join(tmpdir(), 'geulbat-daemon-owner-'));
  try {
    await run(createDaemonContext({ homeStateRoot }), homeStateRoot);
  } finally {
    await rm(homeStateRoot, { recursive: true, force: true });
  }
}

void test('daemon runtime owner starts in order and hands run-channel a narrow projection', async () => {
  await withDaemonContext(async (daemonContext, homeStateRoot) => {
    const events: string[] = [];
    const app: FakeApp = { kind: 'app' };
    const server: FakeServer = { kind: 'server' };
    const socket: FakeSocketServer = { kind: 'socket' };
    let seenRuntimeContext: RunChannelRuntimeContext | undefined;
    const owner = createDaemonRuntimeOwner({
      daemonContext,
      policies: {
        acquireAdmissionLock: async (lockArgs) => {
          events.push(`acquire:${lockArgs.stateRoot === homeStateRoot}`);
          return { release: async () => {} };
        },
        openRuntimeStateStore: async (storeArgs) => {
          events.push(
            `open-runtime-state:${storeArgs.homeStateRoot === homeStateRoot}`,
          );
          return createRuntimeStateStore();
        },
        initProviderAuth: async () => {
          events.push('provider-auth');
        },
        recoverDurableRunsAtStartup: async (runtimeContext) => {
          events.push(
            `recover-runs:${runtimeContext.homeStateRoot === homeStateRoot}`,
          );
        },
        createApp: async () => {
          events.push('create-app');
          return app;
        },
        createHttpServer: (createdApp) => {
          events.push(`create-server:${createdApp === app}`);
          return server;
        },
        attachWebSockets: (attachArgs) => {
          events.push(`attach:${attachArgs.server === server}`);
          seenRuntimeContext = attachArgs.runtimeContext;
          return [socket];
        },
        bindProviderAuthCallback: (boundServer) => {
          events.push(`bind:${boundServer === server}`);
        },
        listen: async (listenArgs) => {
          events.push(`listen:${listenArgs.port}:${listenArgs.host}`);
        },
        closeForShutdown: async () => {
          events.push('close');
        },
        onBootPhase: (phase) => {
          events.push(`boot:${phase}`);
        },
      },
    });

    const startedRuntimeContext = await owner.start({
      port: 4100,
      host: '127.0.0.1',
      beforeListen: () => {
        events.push('before-listen');
      },
    });

    assert.deepEqual(events, [
      'acquire:true',
      'boot:admission-lock',
      'open-runtime-state:true',
      'boot:runtime-state',
      'provider-auth',
      'boot:provider-auth',
      'recover-runs:true',
      'boot:durable-run-recovery',
      'create-app',
      'boot:create-daemon',
      'create-server:true',
      'attach:true',
      'bind:true',
      'before-listen',
      'listen:4100:127.0.0.1',
      'boot:listen',
    ]);
    assert.equal(seenRuntimeContext?.homeStateRoot, homeStateRoot);
    assert.equal(startedRuntimeContext, seenRuntimeContext);
    assert.ok(seenRuntimeContext?.subagent.launchRequests);
    assert.ok(seenRuntimeContext?.subagent.terminalDeliveries);
    assert.equal(seenRuntimeContext?.toolRegistry, daemonContext.toolRegistry);
    assert.equal(
      seenRuntimeContext?.liveRunEvents,
      daemonContext.liveRunEvents,
    );
    assert.equal(
      seenRuntimeContext?.runCheckpoints,
      daemonContext.runCheckpoints,
    );
    assert.equal(
      'plugins' in (seenRuntimeContext ?? {}),
      false,
      'run-channel projection must stay narrower than the daemon context',
    );

    await assert.rejects(
      owner.start({ port: 4100, host: '127.0.0.1' }),
      /already started/,
    );
  });
});

void test('daemon runtime owner releases the admission lock when startup fails', async () => {
  await withDaemonContext(async (daemonContext) => {
    let releasedCount = 0;
    let closeCalls = 0;
    const cleanupEvents: string[] = [];
    const owner = createDaemonRuntimeOwner({
      daemonContext,
      policies: {
        acquireAdmissionLock: async () => ({
          release: async () => {
            releasedCount += 1;
            cleanupEvents.push('admission-lock');
          },
        }),
        openRuntimeStateStore: async () =>
          createRuntimeStateStore(() => {
            cleanupEvents.push('runtime-state');
          }),
        initProviderAuth: async () => {},
        recoverDurableRunsAtStartup: async () => {},
        createApp: async (): Promise<FakeApp> => {
          throw new Error('daemon app composition failed');
        },
        createHttpServer: (): FakeServer => ({ kind: 'server' }),
        attachWebSockets: (): readonly FakeSocketServer[] => [],
        bindProviderAuthCallback: () => {},
        listen: async () => {},
        closeForShutdown: async () => {
          closeCalls += 1;
        },
      },
    });

    await assert.rejects(
      owner.start({ port: 4100, host: '127.0.0.1' }),
      /daemon app composition failed/,
    );
    assert.equal(releasedCount, 1);
    assert.deepEqual(cleanupEvents, ['runtime-state', 'admission-lock']);

    // 실패로 닫힌 runtime의 shutdown은 no-op이며 종료 절차를 다시 돌리지
    // 않는다.
    await owner.shutdown();
    assert.equal(closeCalls, 0);
  });
});

void test('daemon runtime owner fails closed before app composition when durable run recovery fails', async () => {
  await withDaemonContext(async (daemonContext, homeStateRoot) => {
    const events: string[] = [];
    let closeCalls = 0;
    const owner = createDaemonRuntimeOwner({
      daemonContext,
      policies: {
        acquireAdmissionLock: async () => ({
          release: async () => {
            events.push('admission-lock');
          },
        }),
        openRuntimeStateStore: async () =>
          createRuntimeStateStore(() => {
            events.push('runtime-state');
          }),
        initProviderAuth: async () => {
          events.push('provider-auth');
        },
        recoverDurableRunsAtStartup: async (runtimeContext) => {
          assert.equal(runtimeContext.homeStateRoot, homeStateRoot);
          events.push('recover-runs');
          throw new Error('run checkpoint scan failed');
        },
        createApp: async (): Promise<FakeApp> => {
          events.push('create-app');
          return { kind: 'app' };
        },
        createHttpServer: (): FakeServer => {
          events.push('create-server');
          return { kind: 'server' };
        },
        attachWebSockets: (): readonly FakeSocketServer[] => {
          events.push('attach-websockets');
          return [];
        },
        bindProviderAuthCallback: () => {
          events.push('bind-provider-auth');
        },
        listen: async () => {
          events.push('listen');
        },
        closeForShutdown: async () => {
          closeCalls += 1;
        },
      },
    });

    await assert.rejects(
      owner.start({ port: 4100, host: '127.0.0.1' }),
      /run checkpoint scan failed/u,
    );
    assert.deepEqual(events, [
      'provider-auth',
      'recover-runs',
      'runtime-state',
      'admission-lock',
    ]);
    await owner.shutdown();
    assert.equal(closeCalls, 0);
  });
});

void test('daemon runtime owner stops startup when the runtime-state store is unavailable', async () => {
  await withDaemonContext(async (daemonContext) => {
    let providerAuthInitialized = false;
    let releasedCount = 0;
    const owner = createDaemonRuntimeOwner({
      daemonContext,
      policies: {
        acquireAdmissionLock: async () => ({
          release: async () => {
            releasedCount += 1;
          },
        }),
        openRuntimeStateStore: async () => {
          throw new Error('runtime-state unavailable');
        },
        initProviderAuth: async () => {
          providerAuthInitialized = true;
        },
        recoverDurableRunsAtStartup: async () => {},
        createApp: async (): Promise<FakeApp> => ({ kind: 'app' }),
        createHttpServer: (): FakeServer => ({ kind: 'server' }),
        attachWebSockets: (): readonly FakeSocketServer[] => [],
        bindProviderAuthCallback: () => {},
        listen: async () => {},
        closeForShutdown: async () => {},
      },
    });

    await assert.rejects(
      owner.start({ port: 4100, host: '127.0.0.1' }),
      /runtime-state unavailable/u,
    );
    assert.equal(providerAuthInitialized, false);
    assert.equal(releasedCount, 1);
  });
});

void test('daemon runtime owner rejects shutdown before start', async () => {
  await withDaemonContext(async (daemonContext) => {
    const owner = createDaemonRuntimeOwner({
      daemonContext,
      policies: {
        acquireAdmissionLock: async () => ({ release: async () => {} }),
        openRuntimeStateStore: async () => createRuntimeStateStore(),
        initProviderAuth: async () => {},
        recoverDurableRunsAtStartup: async () => {},
        createApp: async (): Promise<FakeApp> => ({ kind: 'app' }),
        createHttpServer: (): FakeServer => ({ kind: 'server' }),
        attachWebSockets: (): readonly FakeSocketServer[] => [],
        bindProviderAuthCallback: () => {},
        listen: async () => {},
        closeForShutdown: async () => {},
      },
    });

    await assert.rejects(owner.shutdown(), /not running/);
  });
});

void test('daemon runtime owner shuts down once and derives session closers from the context', async () => {
  await withDaemonContext(async (daemonContext) => {
    const server: FakeServer = { kind: 'server' };
    const socket: FakeSocketServer = { kind: 'socket' };
    const lock = { release: async () => {} };
    const runtimeStateStore = createRuntimeStateStore();
    const gate = deferred();
    let closeCalls = 0;
    let seenClose: FakeCloseArgs | undefined;
    const owner = createDaemonRuntimeOwner({
      daemonContext,
      policies: {
        acquireAdmissionLock: async () => lock,
        openRuntimeStateStore: async () => runtimeStateStore,
        initProviderAuth: async () => {},
        recoverDurableRunsAtStartup: async () => {},
        createApp: async (): Promise<FakeApp> => ({ kind: 'app' }),
        createHttpServer: () => server,
        attachWebSockets: () => [socket],
        bindProviderAuthCallback: () => {},
        listen: async () => {},
        closeForShutdown: async (closeArgs) => {
          closeCalls += 1;
          seenClose = closeArgs;
          await gate.promise;
        },
      },
    });
    const startedRuntimeContext = await owner.start({
      port: 4100,
      host: '127.0.0.1',
    });

    const first = owner.shutdown();
    const second = owner.shutdown();
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(closeCalls, 1);

    assert.equal(seenClose?.admissionLock, lock);
    assert.equal(
      seenClose?.runtimeSessions.runtimeStateStore,
      runtimeStateStore,
    );
    assert.equal(seenClose?.server, server);
    assert.deepEqual(seenClose?.webSocketServers, [socket]);
    assert.equal(
      seenClose?.runtimeSessions.activeRuns,
      daemonContext.activeRuns,
    );
    assert.equal(
      seenClose?.runtimeSessions.computerDirectoryPicker,
      daemonContext.computerDirectoryPicker,
    );
    assert.equal(seenClose?.runtimeSessions.globalMcp, daemonContext.globalMcp);
    assert.equal(
      seenClose?.runtimeSessions.provider.webSocketSessions,
      daemonContext.provider.webSocketSessions,
    );
    assert.equal(
      seenClose?.runtimeSessions.ptc.browserPageLoadEvidence,
      daemonContext.ptc.browserPageLoadEvidence,
    );
    assert.equal(
      seenClose?.runtimeSessions.ptc.browserTextEvidence,
      daemonContext.ptc.browserTextEvidence,
    );
    assert.equal(
      seenClose?.runtimeSessions.ptc.browserNavigate,
      daemonContext.ptc.browserNavigate,
    );
    assert.equal(
      seenClose?.runtimeSessions.ptc.executeCode,
      daemonContext.ptc.executeCode,
    );
    assert.equal(
      seenClose?.runtimeSessions.subagentLaunchPromotions,
      startedRuntimeContext.subagent.launchPromotions,
    );

    // 종료 완료 후의 재호출도 같은 절차에 합류할 뿐 다시 돌리지 않는다.
    await owner.shutdown();
    assert.equal(closeCalls, 1);
  });
});

void test('daemon runtime owner restart exposes interruption through agent_wait and retries with a fresh approved identity', async () => {
  const homeStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-daemon-owner-restart-'),
  );
  const ownerThreadId = testThreadId(121);
  let firstOwner:
    | ReturnType<typeof createDaemonRuntimeOwner<FakeApp, FakeServer, never>>
    | undefined;
  let secondOwner:
    | ReturnType<typeof createDaemonRuntimeOwner<FakeApp, FakeServer, never>>
    | undefined;

  const startRuntime = async () => {
    const daemonContext = createDaemonContext({ homeStateRoot });
    const owner = createDaemonRuntimeOwner<FakeApp, FakeServer, never>({
      daemonContext,
      policies: {
        acquireAdmissionLock: async () => ({
          release: async () => {},
        }),
        openRuntimeStateStore: async ({ homeStateRoot: stateRoot }) =>
          await createDaemonRuntimeStateStore({ homeStateRoot: stateRoot }),
        initProviderAuth: async () => {},
        recoverDurableRunsAtStartup: async () => {},
        createApp: async () => ({ kind: 'app' }),
        createHttpServer: () => ({ kind: 'server' }),
        attachWebSockets: () => [],
        bindProviderAuthCallback: () => {},
        listen: async () => {},
        closeForShutdown: async ({ admissionLock, runtimeSessions }) => {
          await closeDaemonRuntimeSessions({ runtimeSessions });
          await admissionLock.release();
        },
      },
    });
    const runtimeContext = await owner.start({
      port: 4100,
      host: '127.0.0.1',
    });
    return { owner, runtimeContext };
  };

  try {
    const first = await startRuntime();
    firstOwner = first.owner;
    const firstLaunchRequests = first.runtimeContext.subagent.launchRequests;
    assert.ok(firstLaunchRequests);
    const [startedAttempt] = firstLaunchRequests.enqueueSubagentLaunchBatch([
      {
        toolCallId: 'call-before-daemon-restart',
        task: 'inspect the durable restart boundary',
        subagentType: 'explorer',
        capabilities: [],
        parentRunId: testRunId('restart-parent-before'),
        ownerThreadId,
        stateRoot: homeStateRoot,
        workingDirectory: homeStateRoot,
        permissionMode: 'full_access',
        modelPin: TEST_INHERITED_SOL_MODEL_PIN,
        subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
      },
    ]);
    assert.ok(startedAttempt);
    firstLaunchRequests.markSubagentLaunchStarting(startedAttempt.childRunId);
    firstLaunchRequests.markSubagentLaunchStarted(startedAttempt.childRunId);
    await first.owner.shutdown();

    const second = await startRuntime();
    secondOwner = second.owner;
    const secondLaunchRequests = second.runtimeContext.subagent.launchRequests;
    assert.ok(secondLaunchRequests);
    const recovered =
      secondLaunchRequests.readSubagentLaunchRequestByChildRunId(
        startedAttempt.childRunId,
      );
    assert.equal(recovered?.launchState, 'interrupted');
    assert.equal(recovered?.failureReason, 'daemon_restart_interrupted');

    const parentRunId = testRunId('restart-parent-after');
    const parentRunState = createRunState({
      runId: parentRunId,
      runContext: makeRunContext({
        threadId: ownerThreadId,
        stateRoot: homeStateRoot,
        workingDirectory: homeStateRoot,
      }),
    });
    const executionContext = {
      kind: 'agent' as const,
      runOwnerKind: 'root_main' as const,
      callId: 'call-observe-interrupted-child',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: homeStateRoot,
      workingDirectory: homeStateRoot,
      threadId: ownerThreadId,
      runId: parentRunId,
      runState: parentRunState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: true,
      runtimeServices: second.runtimeContext,
      memoryIndex: undefined,
      emitAgentEvent: () => {},
      permissionMode: 'full_access' as const,
      computerSessionId: 'restart-recovery-approval',
    };

    const waitResult = await agentWaitTool.execute(
      { child_run_ids: [startedAttempt.childRunId] },
      executionContext,
    );
    assert.equal(waitResult.ok, true);
    const waitPayload = JSON.parse(waitResult.output) as {
      completed: Array<{
        childRunId: string;
        terminalState: string;
        result: string;
      }>;
    };
    assert.equal(waitPayload.completed.length, 1);
    assert.equal(
      waitPayload.completed[0]?.childRunId,
      startedAttempt.childRunId,
    );
    assert.equal(waitPayload.completed[0]?.terminalState, 'failed');
    assert.match(waitPayload.completed[0]?.result ?? '', /daemon restarted/u);

    let retryStartCount = 0;
    const retryTool = createAgentRetryTool({
      startBackgroundRun: async (args) => {
        retryStartCount += 1;
        assert.ok(args.childRunId);
        secondLaunchRequests.markSubagentLaunchStarted(args.childRunId);
        return {
          ok: true,
          output: JSON.stringify({
            ok: true,
            childRunId: args.childRunId,
            childThreadId: args.childThreadId,
            subagentType: args.subagentType,
            launchState: 'started',
            modelId: args.modelPin.modelId,
            reasoningEffort: args.modelPin.providerRunSelection.reasoningEffort,
            selectionSource: args.modelPin.selectionSource,
          }),
        };
      },
    });
    const retryResult = await retryTool.execute(
      { child_run_id: startedAttempt.childRunId },
      {
        ...executionContext,
        callId: 'call-retry-after-daemon-restart',
      },
    );
    assert.equal(retryResult.ok, true);
    const retryRaw: unknown = JSON.parse(retryResult.output);
    assert.equal(isAgentRetryToolRaw(retryRaw), true);
    if (!isAgentRetryToolRaw(retryRaw)) {
      throw new Error('agent_retry must return its typed raw result');
    }
    assert.equal(retryRaw.previousChildRunId, startedAttempt.childRunId);
    assert.notEqual(retryRaw.childRunId, startedAttempt.childRunId);
    assert.equal(retryRaw.retryDisposition, 'created');
    assert.equal(retryRaw.launchState, 'started');
    assert.equal(retryStartCount, 1);
    assert.equal(
      secondLaunchRequests.readSubagentLaunchRequestByChildRunId(
        assertRunId(retryRaw.childRunId),
      )?.previousChildRunId,
      startedAttempt.childRunId,
    );
    assert.equal(
      secondLaunchRequests.readSubagentLaunchRequestByChildRunId(
        startedAttempt.childRunId,
      )?.launchState,
      'interrupted',
    );
  } finally {
    await secondOwner?.shutdown();
    await firstOwner?.shutdown();
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});
