import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';

import {
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

void test('closeDaemonRuntimeSessions closes retained PTC runtimes during shutdown', async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  const runtimeSessions: DaemonRuntimeSessionClosers = {
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
    'page-load:true',
    'text:true',
    'browser:true',
    'execute:true',
  ]);
});

void test('closeDaemonRuntimeSessions surfaces cleanup failures after trying every runtime', async () => {
  const calls: string[] = [];
  const runtimeSessions: DaemonRuntimeSessionClosers = {
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
    /ptcBrowserTextEvidence:ptc_browser_text_evidence_session_cleanup_failed; ptcBrowserNavigate:ptc_browser_navigate_session_cleanup_failed; ptcExecuteCode:threw/u,
  );
  assert.deepEqual(calls, ['page-load', 'text', 'browser', 'execute']);
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
