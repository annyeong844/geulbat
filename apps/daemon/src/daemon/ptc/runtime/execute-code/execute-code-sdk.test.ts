import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import vm from 'node:vm';
import {
  PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
} from '../../lab/session/session-docker-contract.js';

import {
  buildPtcExecuteCodeGeulbatFacadeSource,
  buildPtcExecuteCodeReservedSdkRequireSource,
  buildPtcExecuteCodeSdkHelpBundle,
} from './execute-code-sdk.js';

interface GeulbatFacade {
  callTool: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;
  help(): unknown;
  store?: {
    get(key: unknown): Promise<unknown>;
    set(key: unknown, value: unknown, options?: unknown): Promise<unknown>;
  };
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

void test('execute_code SDK exposes typed store callbacks only in the enabled help/facade', async () => {
  const observedKinds: string[] = [];
  await withCallbackSocketServer(
    (socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex < 0) {
          return;
        }
        const request = JSON.parse(buffer.slice(0, newlineIndex)) as {
          requestId: string;
          kind: string;
          args: unknown;
        };
        observedKinds.push(request.kind);
        if (request.kind === 'store_set') {
          assert.deepEqual(request.args, {
            key: 'note',
            value: 'hello',
            options: { merge: 'conflict' },
          });
          socket.end(
            `${JSON.stringify({ requestId: request.requestId, ok: true })}\n`,
          );
          return;
        }
        socket.end(
          `${JSON.stringify({
            requestId: request.requestId,
            ok: true,
            result: 'hello',
          })}\n`,
        );
      });
    },
    async (socketPath) => {
      const geulbat = createGeulbatFacade(socketPath, 'batch_exec');
      assert.ok(geulbat.store !== undefined);
      assert.match(
        JSON.stringify(geulbat.help()),
        /snapshot_at_execution_start/u,
      );
      await geulbat.store.set('note', 'hello', { merge: 'conflict' });
      assert.equal(await geulbat.store.get('note'), 'hello');
    },
  );
  assert.deepEqual(observedKinds, ['store_set', 'store_get']);

  const disabled = createGeulbatFacade('/unused/store-disabled.sock');
  assert.equal(disabled.store, undefined);
  assert.doesNotMatch(JSON.stringify(disabled.help()), /store/u);
});

void test('execute_code SDK rejects non-JSON store values before opening a callback socket', async () => {
  let connectionCount = 0;
  await withCallbackSocketServer(
    () => {
      connectionCount += 1;
    },
    async (socketPath) => {
      const store = createGeulbatFacade(socketPath, 'batch_exec').store;
      assert.ok(store !== undefined);
      await assert.rejects(
        store.set('bad', { value: Number.NaN }),
        (error: unknown) =>
          error !== null &&
          typeof error === 'object' &&
          Reflect.get(error, 'name') === 'StoreValueNotSerializable' &&
          Reflect.get(error, 'remediation') !== undefined,
      );
      await assert.rejects(
        store.set('bad', 1, { merge: 'numeric-add' }),
        (error: unknown) =>
          error !== null &&
          typeof error === 'object' &&
          Reflect.get(error, 'name') === 'StoreMergePolicyUnsupported',
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(connectionCount, 0);
    },
  );
});

void test('execute_code SDK detached-cell store uses the callback transport', async () => {
  await withCallbackSocketServer(
    (socket) => {
      socket.setEncoding('utf8');
      socket.once('data', (chunk) => {
        const request = JSON.parse(String(chunk).trim()) as {
          requestId: string;
          kind: string;
        };
        assert.equal(request.kind, 'store_get');
        socket.end(
          `${JSON.stringify({ requestId: request.requestId, ok: true, result: 'from cell' })}\n`,
        );
      });
    },
    async (socketPath) => {
      const store = createGeulbatFacade(socketPath, 'detached_cell').store;
      assert.ok(store !== undefined);
      assert.equal(await store.get('note'), 'from cell');
    },
  );
});

void test('execute_code SDK help exposes pinned import identity without exposing generated source', () => {
  const generatedSource =
    'export async function readFile() { return "private-generated-source"; }';
  const helpBundle = buildPtcExecuteCodeSdkHelpBundle({
    callbacksEnabled: true,
    sdkHelp: {
      callbackTools: [
        {
          name: 'read_file',
          description: 'Read a computer file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
    },
    sdkProjection: {
      sdkVersion: 'geulbat-tool-library-sdk-v1',
      sdkProjectionHash:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      policyId: 'ptc_sdk_read_file_slice_v1',
      runtimeCompatibilityRange: 'ptc_execute_code_sdk_v1',
      importSpecifier: 'geulbat-sdk',
      manifestModule: 'manifest.js',
      manifestSourceHash:
        'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      mount: {
        hostRootPath: '/private/generated-sdk-root',
        containerRootPath: PTC_SESSION_DOCKER_SDK_CONTAINER_ROOT,
        mountPolicyId: PTC_SESSION_DOCKER_SDK_PROJECTION_MOUNT_POLICY_ID,
        sdkVersion: 'geulbat-tool-library-sdk-v1',
        sdkProjectionHash:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        policyId: 'ptc_sdk_read_file_slice_v1',
        importSpecifier: 'geulbat-sdk',
      },
      modules: [
        {
          specifier: 'geulbat-sdk/files/readFile',
          exportName: 'readFile',
          modulePath: 'files/readFile.js',
          sourceHash: `sha256:${createHash('sha256')
            .update(generatedSource, 'utf8')
            .digest('hex')}`,
        },
      ],
    },
  });

  const facadeSource = buildPtcExecuteCodeGeulbatFacadeSource({ helpBundle });
  assert.doesNotMatch(facadeSource, /private-generated-source/u);
  assert.match(facadeSource, /geulbat-sdk\/files\/readFile/u);
  const loaderSource = buildPtcExecuteCodeReservedSdkRequireSource(helpBundle);
  assert.doesNotMatch(loaderSource, /private-generated-source/u);
  assert.doesNotMatch(loaderSource, /private\/generated-sdk-root/u);
  assert.match(loaderSource, /readFileSync/u);
  assert.match(loaderSource, /__geulbatManifestSourceHash/u);
  assert.match(loaderSource, /sourceBeforeImport/u);
  assert.match(loaderSource, /data:text\/javascript;base64/u);
  assert.ok(
    loaderSource.indexOf(
      '__geulbatManifestSourceHash !== __geulbatSdkProjection.manifestSourceHash',
    ) < loaderSource.indexOf('const __geulbatManifestNamespace = await import'),
  );
  assert.ok(
    loaderSource.indexOf(
      '__geulbatReadFileSync(__geulbatManifestPath, "utf8") !== __geulbatManifestSource',
    ) > loaderSource.indexOf('const __geulbatManifestNamespace = await import'),
  );
});

function createGeulbatFacade(
  socketPath: string | undefined,
  storeMode?: 'batch_exec' | 'detached_cell',
): GeulbatFacade {
  const source = buildPtcExecuteCodeGeulbatFacadeSource({
    ...(socketPath === undefined
      ? {}
      : { callbackConfig: { socketPath, token: 'test-callback-token' } }),
    helpBundle: buildPtcExecuteCodeSdkHelpBundle({
      callbacksEnabled: true,
      sdkHelp: {
        callbackTools: [
          {
            name: 'read_file',
            description: 'Read a computer file.',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        ],
      },
      ...(storeMode === undefined ? {} : { storeMode }),
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
