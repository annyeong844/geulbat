import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import vm from 'node:vm';

import {
  buildPtcExecuteCodeGeulbatFacadeSource,
  buildPtcExecuteCodeSdkHelpBundle,
} from './execute-code-sdk.js';

interface GeulbatFacade {
  callTool: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;
}

const testRequire = createRequire(import.meta.url);

void test('execute_code SDK rejects callback calls when the response socket closes without a JSON line', async () => {
  await withCallbackSocketServer(
    (socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes('\n')) {
          socket.end();
        }
      });
    },
    async (socketPath) => {
      const geulbat = createGeulbatFacade(socketPath);

      await assert.rejects(
        geulbat.callTool('read_file', { path: 'note.txt' }),
        /PTC callback response closed before a response was received/u,
      );
    },
  );
});

void test('execute_code SDK does not open a callback socket when args serialization fails', async () => {
  let connectionCount = 0;
  const activeSockets = new Set<Socket>();
  await withCallbackSocketServer(
    (socket) => {
      connectionCount += 1;
      activeSockets.add(socket);
      socket.on('close', () => {
        activeSockets.delete(socket);
      });
    },
    async (socketPath) => {
      const geulbat = createGeulbatFacade(socketPath);

      await assert.rejects(
        geulbat.callTool('read_file', { n: 1n }),
        /serialize a BigInt/u,
      );
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(connectionCount, 0);
      assert.equal(activeSockets.size, 0);
    },
  );
});

function createGeulbatFacade(socketPath: string): GeulbatFacade {
  const source = buildPtcExecuteCodeGeulbatFacadeSource({
    callbackConfig: { socketPath, token: 'test-callback-token' },
    helpBundle: buildPtcExecuteCodeSdkHelpBundle({
      callbacksEnabled: true,
      sdkHelp: {
        callbackTools: [
          {
            name: 'read_file',
            description: 'Read a workspace file.',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
    }),
  });
  const context: { require: NodeJS.Require; __geulbat?: GeulbatFacade } = {
    require: testRequire,
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.__geulbat = geulbat;`, context);
  if (context.__geulbat === undefined) {
    throw new Error('geulbat facade was not created');
  }
  return context.__geulbat;
}

async function withCallbackSocketServer(
  onConnection: (socket: Socket) => void,
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-ptc-sdk-callback-'));
  const socketPath = join(root, 'callback.sock');
  const server = createServer(onConnection);
  try {
    await listen(server, socketPath);
    await run(socketPath);
  } finally {
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
