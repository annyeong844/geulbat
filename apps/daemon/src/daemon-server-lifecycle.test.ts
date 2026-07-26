import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';

import {
  closeDaemonForShutdown,
  closeDaemonRuntimeSessions,
  closeDaemonServers,
  listenDaemonHttpServer,
  type DaemonRuntimeSessionClosers,
} from './daemon-server-lifecycle.js';

function createIdleActiveRuns(): DaemonRuntimeSessionClosers['activeRuns'] {
  return {
    abortAllRuns() {
      return 0;
    },
    async waitForIdle() {},
  };
}

void test('closeDaemonServers terminates websocket clients before closing the http server', async () => {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    webSocketServer.handleUpgrade(req, socket, head, (ws) => {
      webSocketServer.emit('connection', ws, req);
    });
  });

  await listen(server);
  const port = (server.address() as AddressInfo).port;
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(client, 'open');
  const clientClosed = once(client, 'close');

  await closeDaemonServers({
    server,
    webSocketServers: [webSocketServer],
  });
  await clientClosed;

  assert.equal(server.listening, false);
  assert.equal(webSocketServer.clients.size, 0);
});

void test('closeDaemonForShutdown closes phases in order before releasing admission', async () => {
  const server = createServer();
  await listen(server);
  let serverClosed = false;
  let pickerClosed = false;
  let activeRunsIdle = false;
  let runtimeCloseCount = 0;
  let runtimeStateStoreClosed = false;
  let admissionReleased = false;
  server.once('close', () => {
    assert.equal(pickerClosed, true);
    serverClosed = true;
  });
  const closeRuntime = async () => {
    assert.equal(serverClosed, true);
    assert.equal(activeRunsIdle, true);
    runtimeCloseCount += 1;
    return { ok: true } as const;
  };
  const runtimeSessions: DaemonRuntimeSessionClosers = {
    activeRuns: {
      abortAllRuns(reason) {
        assert.equal(serverClosed, true);
        assert.equal(reason, 'daemon_shutdown');
        return 2;
      },
      async waitForIdle() {
        activeRunsIdle = true;
      },
    },
    computerDirectoryPicker: {
      async close() {
        assert.equal(serverClosed, false);
        pickerClosed = true;
      },
    },
    globalMcp: {
      async close() {
        await closeRuntime();
      },
    },
    hostCommands: { closeAll: closeRuntime },
    provider: { webSocketSessions: { closeAll: closeRuntime } },
    ptc: {
      browserPageLoadEvidence: { closeAll: closeRuntime },
      browserTextEvidence: { closeAll: closeRuntime },
      browserNavigate: { closeAll: closeRuntime },
      executeCode: { closeAll: closeRuntime },
    },
    subagentLaunchPromotions: {
      async close() {
        await closeRuntime();
      },
    },
    runtimeStateStore: {
      close() {
        assert.equal(runtimeCloseCount, 8);
        assert.equal(activeRunsIdle, true);
        runtimeStateStoreClosed = true;
      },
    },
  };

  await closeDaemonForShutdown({
    admissionLock: {
      async release() {
        assert.equal(runtimeCloseCount, 8);
        assert.equal(pickerClosed, true);
        assert.equal(activeRunsIdle, true);
        assert.equal(runtimeStateStoreClosed, true);
        admissionReleased = true;
      },
    },
    runtimeSessions,
    server,
    webSocketServers: [],
  });

  assert.equal(server.listening, false);
  assert.equal(admissionReleased, true);
});

void test('closeDaemonForShutdown attempts every phase and aggregates failures', async () => {
  const server = createServer();
  const calls: string[] = [];
  const runtimeSessions: DaemonRuntimeSessionClosers = {
    activeRuns: {
      abortAllRuns() {
        calls.push('abort-runs');
        return 1;
      },
      async waitForIdle() {
        calls.push('runs-idle');
      },
    },
    computerDirectoryPicker: {
      async close() {
        calls.push('picker');
      },
    },
    globalMcp: {
      async close() {
        calls.push('mcp');
      },
    },
    hostCommands: {
      async closeAll() {
        calls.push('host-commands');
        return { ok: true };
      },
    },
    provider: {
      webSocketSessions: {
        async closeAll() {
          calls.push('provider-ws');
          return { ok: true };
        },
      },
    },
    ptc: {
      browserPageLoadEvidence: {
        async closeAll() {
          calls.push('page-load');
          return {
            ok: false,
            reasonCode: 'ptc_browser_page_load_session_cleanup_failed',
            message: 'runtime cleanup failed',
          };
        },
      },
      browserTextEvidence: {
        async closeAll() {
          calls.push('text');
          return { ok: true };
        },
      },
      browserNavigate: {
        async closeAll() {
          calls.push('browser');
          return { ok: true };
        },
      },
      executeCode: {
        async closeAll() {
          calls.push('execute');
          return { ok: true };
        },
      },
    },
    subagentLaunchPromotions: {
      async close() {
        calls.push('promotions');
      },
    },
    runtimeStateStore: {
      close() {
        calls.push('runtime-state');
        throw new Error('runtime-state close failed');
      },
    },
  };

  await assert.rejects(
    closeDaemonForShutdown({
      admissionLock: {
        async release() {
          calls.push('admission-lock');
          throw new Error('lock release failed');
        },
      },
      runtimeSessions,
      server,
      webSocketServers: [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 4);
      assert.match(error.message, /servers:/u);
      assert.match(error.message, /runtimeSessions:/u);
      assert.match(error.message, /runtimeStateStore:/u);
      assert.match(error.message, /admissionLock: lock release failed/u);
      const runtimeSessionsFailure: unknown = error.errors[1];
      assert.ok(runtimeSessionsFailure instanceof Error);
      assert.ok(runtimeSessionsFailure.cause instanceof AggregateError);
      assert.equal(runtimeSessionsFailure.cause.errors.length, 1);
      const pageLoadFailure: unknown = runtimeSessionsFailure.cause.errors[0];
      assert.ok(pageLoadFailure instanceof Error);
      assert.equal(
        pageLoadFailure.message,
        'ptcBrowserPageLoadEvidence:ptc_browser_page_load_session_cleanup_failed',
      );
      assert.deepEqual(pageLoadFailure.cause, {
        ok: false,
        reasonCode: 'ptc_browser_page_load_session_cleanup_failed',
        message: 'runtime cleanup failed',
      });
      const runtimeStateStoreFailure: unknown = error.errors[2];
      assert.ok(runtimeStateStoreFailure instanceof Error);
      assert.ok(runtimeStateStoreFailure.cause instanceof AggregateError);
      assert.equal(runtimeStateStoreFailure.cause.errors.length, 1);
      const closeFailure: unknown = runtimeStateStoreFailure.cause.errors[0];
      assert.ok(closeFailure instanceof Error);
      assert.equal(closeFailure.message, 'runtimeStateStore:threw');
      assert.ok(closeFailure.cause instanceof Error);
      assert.equal(closeFailure.cause.message, 'runtime-state close failed');
      const admissionFailure: unknown = error.errors[3];
      assert.ok(admissionFailure instanceof Error);
      assert.ok(admissionFailure.cause instanceof Error);
      assert.equal(admissionFailure.cause.message, 'lock release failed');
      return true;
    },
  );
  assert.deepEqual(calls, [
    'picker',
    'abort-runs',
    'runs-idle',
    'mcp',
    'host-commands',
    'provider-ws',
    'page-load',
    'text',
    'browser',
    'execute',
    'promotions',
    'runtime-state',
    'admission-lock',
  ]);
});

void test('listenDaemonHttpServer rejects async bind errors for startup cleanup paths', async () => {
  const occupiedServer = createServer();
  const candidateServer = createServer();
  await listen(occupiedServer);
  const address = occupiedServer.address() as AddressInfo;
  let cleanupReached = false;

  try {
    await assert.rejects(
      async () => {
        try {
          await listenDaemonHttpServer({
            server: candidateServer,
            port: address.port,
            host: '127.0.0.1',
          });
        } finally {
          cleanupReached = true;
        }
      },
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'EADDRINUSE',
    );
    assert.equal(cleanupReached, true);
    assert.equal(candidateServer.listening, false);
    assert.equal(candidateServer.listenerCount('error'), 0);
  } finally {
    await closeIfListening(candidateServer);
    await closeIfListening(occupiedServer);
  }
});

void test('listenDaemonHttpServer warns when the configured bind host is not loopback', async () => {
  const server = createServer();
  const warnings: string[] = [];
  const listenArgs = {
    server,
    port: 0,
    host: '0.0.0.0',
    reportExposureWarning: (message: string) => warnings.push(message),
  };

  try {
    await listenDaemonHttpServer(listenArgs);
    assert.deepEqual(warnings, [
      'daemon bind host "0.0.0.0" is not loopback; local dev-token authentication is intended for single-user local use only',
    ]);
  } finally {
    await closeIfListening(server);
  }
});

void test('listenDaemonHttpServer keeps the default loopback bind quiet', async () => {
  const server = createServer();
  const warnings: string[] = [];
  const listenArgs = {
    server,
    port: 0,
    host: '127.0.0.1',
    reportExposureWarning: (message: string) => warnings.push(message),
  };

  try {
    await listenDaemonHttpServer(listenArgs);
    assert.deepEqual(warnings, []);
  } finally {
    await closeIfListening(server);
  }
});

void test('closeDaemonRuntimeSessions closes MCP and retained PTC runtimes during shutdown', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const runtimeSessions: DaemonRuntimeSessionClosers = {
    activeRuns: createIdleActiveRuns(),
    computerDirectoryPicker: {
      async close() {
        calls.push('picker');
      },
    },
    globalMcp: {
      async close(args) {
        calls.push(`mcp:${args?.signal === controller.signal}`);
      },
    },
    hostCommands: {
      async closeAll(args) {
        calls.push(`host-commands:${args?.signal === controller.signal}`);
        return { ok: true };
      },
    },
    provider: {
      webSocketSessions: {
        async closeAll(args) {
          calls.push(`provider-ws:${args?.signal === controller.signal}`);
          return { ok: true };
        },
      },
    },
    ptc: {
      browserPageLoadEvidence: {
        async closeAll(args) {
          calls.push(`page-load:${args?.signal === controller.signal}`);
          return { ok: true };
        },
      },
      browserTextEvidence: {
        async closeAll(args) {
          calls.push(`text:${args?.signal === controller.signal}`);
          return { ok: true };
        },
      },
      browserNavigate: {
        async closeAll(args) {
          calls.push(`browser:${args?.signal === controller.signal}`);
          return { ok: true };
        },
      },
      executeCode: {
        async closeAll(args) {
          calls.push(`execute:${args?.signal === controller.signal}`);
          return { ok: true };
        },
      },
    },
    subagentLaunchPromotions: {
      async close() {
        calls.push('promotions');
      },
    },
    runtimeStateStore: {
      close() {
        calls.push('runtime-state');
      },
    },
  };

  await closeDaemonRuntimeSessions({
    runtimeSessions,
    signal: controller.signal,
  });

  assert.deepEqual(calls, [
    'picker',
    'mcp:true',
    'host-commands:true',
    'provider-ws:true',
    'page-load:true',
    'text:true',
    'browser:true',
    'execute:true',
    'promotions',
    'runtime-state',
  ]);
});

void test('closeDaemonRuntimeSessions surfaces cleanup failures after trying every runtime', async () => {
  const calls: string[] = [];
  const runtimeSessions: DaemonRuntimeSessionClosers = {
    activeRuns: createIdleActiveRuns(),
    computerDirectoryPicker: {
      async close() {
        calls.push('picker');
        throw new Error('picker unavailable');
      },
    },
    globalMcp: {
      async close() {
        calls.push('mcp');
        throw new Error('mcp close unavailable');
      },
    },
    hostCommands: {
      async closeAll() {
        calls.push('host-commands');
        return { ok: true };
      },
    },
    provider: {
      webSocketSessions: {
        async closeAll() {
          calls.push('provider-ws');
          return { ok: true };
        },
      },
    },
    ptc: {
      browserPageLoadEvidence: {
        async closeAll() {
          calls.push('page-load');
          return { ok: true };
        },
      },
      browserTextEvidence: {
        async closeAll() {
          calls.push('text');
          return {
            ok: false,
            reasonCode: 'ptc_browser_text_evidence_session_cleanup_failed',
            message: 'cleanup failed',
          };
        },
      },
      browserNavigate: {
        async closeAll() {
          calls.push('browser');
          return {
            ok: false,
            reasonCode: 'ptc_browser_navigate_session_cleanup_failed',
            message: 'cleanup failed',
          };
        },
      },
      executeCode: {
        async closeAll() {
          calls.push('execute');
          throw new Error('docker unavailable');
        },
      },
    },
    subagentLaunchPromotions: {
      async close() {
        calls.push('promotions');
        throw new Error('promotion close unavailable');
      },
    },
    runtimeStateStore: {
      close() {
        calls.push('runtime-state');
        throw new Error('runtime-state close unavailable');
      },
    },
  };

  await assert.rejects(
    closeDaemonRuntimeSessions({ runtimeSessions }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(
        error.message,
        /computerDirectoryPicker:threw; globalMcp:threw; ptcBrowserTextEvidence:ptc_browser_text_evidence_session_cleanup_failed; ptcBrowserNavigate:ptc_browser_navigate_session_cleanup_failed; ptcExecuteCode:threw; subagentLaunchPromotions:threw; runtimeStateStore:threw/u,
      );
      assert.equal(error.errors.length, 7);

      const pickerFailure: unknown = error.errors[0];
      assert.ok(pickerFailure instanceof Error);
      assert.ok(pickerFailure.cause instanceof Error);
      assert.equal(pickerFailure.cause.message, 'picker unavailable');

      const mcpFailure: unknown = error.errors[1];
      assert.ok(mcpFailure instanceof Error);
      assert.ok(mcpFailure.cause instanceof Error);
      assert.equal(mcpFailure.cause.message, 'mcp close unavailable');

      const textFailure: unknown = error.errors[2];
      assert.ok(textFailure instanceof Error);
      assert.deepEqual(textFailure.cause, {
        ok: false,
        reasonCode: 'ptc_browser_text_evidence_session_cleanup_failed',
        message: 'cleanup failed',
      });

      const navigateFailure: unknown = error.errors[3];
      assert.ok(navigateFailure instanceof Error);
      assert.deepEqual(navigateFailure.cause, {
        ok: false,
        reasonCode: 'ptc_browser_navigate_session_cleanup_failed',
        message: 'cleanup failed',
      });

      const executeFailure: unknown = error.errors[4];
      assert.ok(executeFailure instanceof Error);
      assert.ok(executeFailure.cause instanceof Error);
      assert.equal(executeFailure.cause.message, 'docker unavailable');

      const promotionFailure: unknown = error.errors[5];
      assert.ok(promotionFailure instanceof Error);
      assert.ok(promotionFailure.cause instanceof Error);
      assert.equal(
        promotionFailure.cause.message,
        'promotion close unavailable',
      );

      const runtimeStateStoreFailure: unknown = error.errors[6];
      assert.ok(runtimeStateStoreFailure instanceof Error);
      assert.ok(runtimeStateStoreFailure.cause instanceof Error);
      assert.equal(
        runtimeStateStoreFailure.cause.message,
        'runtime-state close unavailable',
      );
      return true;
    },
  );
  assert.deepEqual(calls, [
    'picker',
    'mcp',
    'host-commands',
    'provider-ws',
    'page-load',
    'text',
    'browser',
    'execute',
    'promotions',
    'runtime-state',
  ]);
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
}

async function closeIfListening(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
