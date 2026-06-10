import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';

import { closeDaemonServers } from './daemon-server-lifecycle.js';

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

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
}
