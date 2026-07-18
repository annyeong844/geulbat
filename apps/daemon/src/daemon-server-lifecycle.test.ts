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
  let runtimeCloseCount = 0;
  let admissionReleased = false;
  server.once('close', () => {
    assert.equal(pickerClosed, true);
    serverClosed = true;
  });
  const closeRuntime = async () => {
    assert.equal(serverClosed, true);
    runtimeCloseCount += 1;
    return { ok: true } as const;
  };
  const runtimeSessions: DaemonRuntimeSessionClosers = {
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
    ptcBrowserPageLoadEvidence: { closeAll: closeRuntime },
    ptcBrowserTextEvidence: { closeAll: closeRuntime },
    ptcBrowserNavigate: { closeAll: closeRuntime },
    ptcExecuteCode: { closeAll: closeRuntime },
  };

  await closeDaemonForShutdown({
    admissionLock: {
      async release() {
        assert.equal(runtimeCloseCount, 5);
        assert.equal(pickerClosed, true);
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
    ptcBrowserPageLoadEvidence: {
      async closeAll() {
        calls.push('page-load');
        return {
          ok: false,
          reasonCode: 'ptc_browser_page_load_session_cleanup_failed',
          message: 'runtime cleanup failed',
        };
      },
    },
    ptcBrowserTextEvidence: {
      async closeAll() {
        calls.push('text');
        return { ok: true };
      },
    },
    ptcBrowserNavigate: {
      async closeAll() {
        calls.push('browser');
        return { ok: true };
      },
    },
    ptcExecuteCode: {
      async closeAll() {
        calls.push('execute');
        return { ok: true };
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
      assert.equal(error.errors.length, 3);
      assert.match(error.message, /servers:/u);
      assert.match(error.message, /runtimeSessions:/u);
      assert.match(error.message, /admissionLock: lock release failed/u);
      const admissionFailure: unknown = error.errors[2];
      assert.ok(admissionFailure instanceof Error);
      assert.ok(admissionFailure.cause instanceof Error);
      assert.equal(admissionFailure.cause.message, 'lock release failed');
      return true;
    },
  );
  assert.deepEqual(calls, [
    'picker',
    'mcp',
    'page-load',
    'text',
    'browser',
    'execute',
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

void test('closeDaemonRuntimeSessions closes MCP and retained PTC runtimes during shutdown', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const runtimeSessions: DaemonRuntimeSessionClosers = {
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
    ptcBrowserPageLoadEvidence: {
      async closeAll(args) {
        calls.push(`page-load:${args?.signal === controller.signal}`);
        return { ok: true };
      },
    },
    ptcBrowserTextEvidence: {
      async closeAll(args) {
        calls.push(`text:${args?.signal === controller.signal}`);
        return { ok: true };
      },
    },
    ptcBrowserNavigate: {
      async closeAll(args) {
        calls.push(`browser:${args?.signal === controller.signal}`);
        return { ok: true };
      },
    },
    ptcExecuteCode: {
      async closeAll(args) {
        calls.push(`execute:${args?.signal === controller.signal}`);
        return { ok: true };
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
    'page-load:true',
    'text:true',
    'browser:true',
    'execute:true',
  ]);
});

void test('closeDaemonRuntimeSessions surfaces cleanup failures after trying every runtime', async () => {
  const calls: string[] = [];
  const runtimeSessions: DaemonRuntimeSessionClosers = {
    computerDirectoryPicker: {
      async close() {
        calls.push('picker');
      },
    },
    globalMcp: {
      async close() {
        calls.push('mcp');
        throw new Error('mcp close unavailable');
      },
    },
    ptcBrowserPageLoadEvidence: {
      async closeAll() {
        calls.push('page-load');
        return { ok: true };
      },
    },
    ptcBrowserTextEvidence: {
      async closeAll() {
        calls.push('text');
        return {
          ok: false,
          reasonCode: 'ptc_browser_text_evidence_session_cleanup_failed',
          message: 'cleanup failed',
        };
      },
    },
    ptcBrowserNavigate: {
      async closeAll() {
        calls.push('browser');
        return {
          ok: false,
          reasonCode: 'ptc_browser_navigate_session_cleanup_failed',
          message: 'cleanup failed',
        };
      },
    },
    ptcExecuteCode: {
      async closeAll() {
        calls.push('execute');
        throw new Error('docker unavailable');
      },
    },
  };

  await assert.rejects(
    closeDaemonRuntimeSessions({ runtimeSessions }),
    /globalMcp:threw; ptcBrowserTextEvidence:ptc_browser_text_evidence_session_cleanup_failed; ptcBrowserNavigate:ptc_browser_navigate_session_cleanup_failed; ptcExecuteCode:threw/u,
  );
  assert.deepEqual(calls, [
    'picker',
    'mcp',
    'page-load',
    'text',
    'browser',
    'execute',
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
