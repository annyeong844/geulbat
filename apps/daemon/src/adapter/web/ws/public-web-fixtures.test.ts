import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PUBLIC_WEB_WEBSOCKET_ECHO_PATH } from '@geulbat/protocol/public-web-fixtures';
import WebSocket from 'ws';

import { createRunChannelTestDaemonContext } from '../../../test-support/run-channel-test-support.js';
import { attachPublicWebFixtureWebSocketServer } from './public-web-fixtures.js';
import { attachRunChannelServer } from './run-channel.js';

void test('public web websocket echo fixture coexists with the run channel upgrade listener', async () => {
  const server = createServer();
  const publicWebSockets = attachPublicWebFixtureWebSocketServer(server);
  const runChannelSockets = attachRunChannelServer(server, {
    runtimeContext: createRunChannelTestDaemonContext(),
  });
  await listen(server);

  try {
    const port = (server.address() as AddressInfo).port;
    const message = await echoWebSocketMessage(port, 'hello websocket');

    assert.equal(message, 'hello websocket');
  } finally {
    publicWebSockets.close();
    runChannelSockets.close();
    await close(server);
  }
});

async function echoWebSocketMessage(
  port: number,
  message: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${PUBLIC_WEB_WEBSOCKET_ECHO_PATH}`,
      { origin: `http://127.0.0.1:${port}` },
    );

    socket.once('open', () => {
      socket.send(message);
    });
    socket.once('message', (raw) => {
      resolve(String(raw));
      socket.close();
    });
    socket.once('unexpected-response', (_, response) => {
      reject(new Error(`unexpected status: ${response.statusCode}`));
    });
    socket.once('error', reject);
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
