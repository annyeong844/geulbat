import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { RunChannelRuntimeContext } from './adapter/web/ws/run-channel-runtime-context.js';
import { createDaemonRuntimeOwner } from './daemon-runtime-owner.js';
import type { DaemonRuntimeSessionClosers } from './daemon-server-lifecycle.js';
import { createDaemonContext, type DaemonContext } from './daemon/context.js';

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
        initProviderAuth: async () => {
          events.push('provider-auth');
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

    await owner.start({
      port: 4100,
      host: '127.0.0.1',
      beforeListen: () => {
        events.push('before-listen');
      },
    });

    assert.deepEqual(events, [
      'acquire:true',
      'boot:admission-lock',
      'provider-auth',
      'boot:provider-auth',
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
    const owner = createDaemonRuntimeOwner({
      daemonContext,
      policies: {
        acquireAdmissionLock: async () => ({
          release: async () => {
            releasedCount += 1;
          },
        }),
        initProviderAuth: async () => {},
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

    // 실패로 닫힌 runtime의 shutdown은 no-op이며 종료 절차를 다시 돌리지
    // 않는다.
    await owner.shutdown();
    assert.equal(closeCalls, 0);
  });
});

void test('daemon runtime owner rejects shutdown before start', async () => {
  await withDaemonContext(async (daemonContext) => {
    const owner = createDaemonRuntimeOwner({
      daemonContext,
      policies: {
        acquireAdmissionLock: async () => ({ release: async () => {} }),
        initProviderAuth: async () => {},
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
    const gate = deferred();
    let closeCalls = 0;
    let seenClose: FakeCloseArgs | undefined;
    const owner = createDaemonRuntimeOwner({
      daemonContext,
      policies: {
        acquireAdmissionLock: async () => lock,
        initProviderAuth: async () => {},
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
    await owner.start({ port: 4100, host: '127.0.0.1' });

    const first = owner.shutdown();
    const second = owner.shutdown();
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(closeCalls, 1);

    assert.equal(seenClose?.admissionLock, lock);
    assert.equal(seenClose?.server, server);
    assert.deepEqual(seenClose?.webSocketServers, [socket]);
    assert.equal(
      seenClose?.runtimeSessions.computerDirectoryPicker,
      daemonContext.computerDirectoryPicker,
    );
    assert.equal(seenClose?.runtimeSessions.globalMcp, daemonContext.globalMcp);
    assert.equal(
      seenClose?.runtimeSessions.ptcBrowserPageLoadEvidence,
      daemonContext.ptcBrowserPageLoadEvidence,
    );
    assert.equal(
      seenClose?.runtimeSessions.ptcBrowserTextEvidence,
      daemonContext.ptcBrowserTextEvidence,
    );
    assert.equal(
      seenClose?.runtimeSessions.ptcBrowserNavigate,
      daemonContext.ptcBrowserNavigate,
    );
    assert.equal(
      seenClose?.runtimeSessions.ptcExecuteCode,
      daemonContext.ptcExecuteCode,
    );

    // 종료 완료 후의 재호출도 같은 절차에 합류할 뿐 다시 돌리지 않는다.
    await owner.shutdown();
    assert.equal(closeCalls, 1);
  });
});
