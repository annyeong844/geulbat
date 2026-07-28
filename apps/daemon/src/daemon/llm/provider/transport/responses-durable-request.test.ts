import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, readdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import WebSocket, { WebSocketServer } from 'ws';

import { createDaemonHostCommandRuntime } from '../../../../command-host/runtime-selection.js';
import { removeCommandHostWorkspace } from '../../../../test-support/command-host-workspace.js';
import {
  buildHostCommandPaths,
  SYSTEM_SESSION_OWNER,
} from '../../../host-command-output-store.js';
import {
  createHostRoutedDetachedProcessAttacher,
  createHostRoutedDetachedProcessStarter,
} from '../../../host-routed-detached-process.js';
import {
  createHostRoutedResponsesRequestTransport,
  type ResponsesDurableRequestStreamArgs,
} from './responses-durable-request.js';
import {
  RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
  parseResponsesDurableRequestInputFrame,
  type ResponsesDurableRequestInputFrame,
} from './responses-durable-request-protocol.js';

interface NodeModuleCommand {
  execPath: string;
  args: string[];
}

type WorkerRuntime = ReturnType<typeof createWorkerRuntime>;
interface ProviderBoundary {
  stateRoot: string;
  webSocketUrl: string;
  createRuntime(): WorkerRuntime;
  closeRuntime(runtime: WorkerRuntime): Promise<void>;
  dispatchCount(): number;
}

void test('durable request protocol distinguishes WebSocket and HTTP JSON-SSE initialize frames', () => {
  const websocketFrame: ResponsesDurableRequestInputFrame = {
    version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
    kind: 'initialize',
    transportKind: 'websocket',
    requestIdentity: 'websocket-request',
    webSocketUrl: 'wss://provider.example/responses',
    headers: [['content-type', 'application/json']],
    serializedPayload: '{}',
    redactionMarkers: [],
    completionEventTypes: ['response.completed'],
  };
  const httpFrame: ResponsesDurableRequestInputFrame = {
    version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
    kind: 'initialize',
    transportKind: 'http_json_sse',
    requestIdentity: 'http-request',
    requestUrl: 'https://provider.example/chat/completions',
    headers: [['content-type', 'application/json']],
    serializedPayload: '{}',
    redactionMarkers: [],
  };

  assert.deepEqual(
    parseResponsesDurableRequestInputFrame(websocketFrame),
    websocketFrame,
  );
  assert.deepEqual(
    parseResponsesDurableRequestInputFrame(httpFrame),
    httpFrame,
  );
  assert.equal(
    parseResponsesDurableRequestInputFrame({
      ...websocketFrame,
      requestUrl: 'https://provider.example/chat/completions',
    }),
    undefined,
  );
  assert.equal(
    parseResponsesDurableRequestInputFrame({
      ...httpFrame,
      webSocketUrl: 'wss://provider.example/responses',
    }),
    undefined,
  );
});

void test(
  'HTTP JSON-SSE durable host preserves provider status and diagnoses invalid streams',
  { timeout: 30_000 },
  async (t) => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-provider-http-errors-'),
    );
    const requestCounts = new Map<string, number>();
    const server = createServer((request, response) => {
      const path = request.url ?? '/';
      requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
      request.resume();
      if (path === '/status') {
        response.writeHead(429, { 'Retry-After': '2' });
        response.end();
        return;
      }
      if (path === '/content-type') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(204, { 'Content-Type': 'text/event-stream' });
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const runtime = createWorkerRuntime();
    const transport = createTransport(runtime, stateRoot);
    const streamHttpSseEvents = transport.streamHttpSseEvents;
    assert.notEqual(streamHttpSseEvents, undefined);
    t.after(async () => {
      await runtime.closeAll().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeCommandHostWorkspace(stateRoot);
    });

    const cases = [
      {
        path: '/status',
        matches: (error: unknown) =>
          error instanceof Error &&
          /status 429/u.test(error.message) &&
          Reflect.get(error, 'status') === 429 &&
          Reflect.get(error, 'retryAfterMs') === 2_000,
      },
      {
        path: '/content-type',
        matches: (error: unknown) =>
          error instanceof Error &&
          /content-type: application\/json/u.test(error.message) &&
          Reflect.get(error, 'status') === 200,
      },
      {
        path: '/missing-body',
        matches: (error: unknown) =>
          error instanceof Error &&
          /event stream body is missing/u.test(error.message) &&
          Reflect.get(error, 'status') === 204,
      },
    ];

    for (const testCase of cases) {
      await assert.rejects(
        collectEvents(
          streamHttpSseEvents!({
            requestUrl: `http://127.0.0.1:${address.port}${testCase.path}`,
            headers: new Headers({
              Authorization: 'Bearer private-http-token',
              'Content-Type': 'application/json',
            }),
            serializedPayload: '{"model":"test-model","stream":true}',
            providerSessionId: `http-errors:${testCase.path}`,
            requestAttempt: 0,
          }),
        ),
        (error: unknown) => {
          assert.equal(
            error instanceof Error &&
              error.message.includes('private-http-token'),
            false,
          );
          return testCase.matches(error);
        },
      );
      assert.equal(requestCounts.get(testCase.path), 1);
    }
  },
);

void test(
  'a replacement daemon reattaches to one dispatched provider request without resending',
  { timeout: 30_000 },
  async (t) => {
    let releaseProvider: () => void = () => undefined;
    const continueProvider = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const boundary = await createProviderBoundary(
      t,
      'geulbat-provider-request-readoption-',
      (socket) => {
        socket.send(
          JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'first',
            contentType: 'application/json',
            credential: 'private-token',
          }),
        );
        void continueProvider.then(() => {
          socket.send(
            JSON.stringify({
              type: 'response.output_text.delta',
              delta: 'second',
            }),
          );
          socket.send(
            JSON.stringify({
              type: 'response.completed',
              response: { usage: { input_tokens: 2, output_tokens: 2 } },
            }),
          );
        });
      },
    );
    t.after(releaseProvider);

    const firstRuntime = boundary.createRuntime();
    const firstTransport = createTransport(firstRuntime, boundary.stateRoot);
    const shutdown = new AbortController();
    const request: ResponsesDurableRequestStreamArgs = {
      webSocketUrl: boundary.webSocketUrl,
      headers: new Headers({
        Authorization: 'Bearer private-token',
        'Content-Type': 'application/json',
      }),
      serializedPayload: JSON.stringify({
        type: 'response.create',
        model: 'test-model',
      }),
      providerSessionId: 'thread-provider-session',
      requestAttempt: 0,
      signal: shutdown.signal,
    };
    const first = firstTransport.streamEvents(request)[Symbol.asyncIterator]();
    const firstEvent = {
      type: 'response.output_text.delta',
      delta: 'first',
      contentType: 'application/json',
      credential: '[provider-credential-redacted]',
    };

    assert.deepEqual(await first.next(), {
      done: false,
      value: firstEvent,
    });
    shutdown.abort('daemon_shutdown');
    await assert.rejects(first.next());
    await boundary.closeRuntime(firstRuntime);

    const replacementRuntime = boundary.createRuntime();
    const replacementTransport = createTransport(
      replacementRuntime,
      boundary.stateRoot,
    );
    const replacementRequest = withoutSignal(request);
    const replacement = replacementTransport
      .streamEvents(replacementRequest)
      [Symbol.asyncIterator]();

    assert.deepEqual(await replacement.next(), {
      done: false,
      value: firstEvent,
    });
    releaseProvider();
    const secondEvent = {
      type: 'response.output_text.delta',
      delta: 'second',
    };
    const completedEvent = {
      type: 'response.completed',
      response: { usage: { input_tokens: 2, output_tokens: 2 } },
    };
    assert.deepEqual(await replacement.next(), {
      done: false,
      value: secondEvent,
    });
    assert.deepEqual(await replacement.next(), {
      done: false,
      value: completedEvent,
    });
    assert.deepEqual(await replacement.next(), {
      done: true,
      value: undefined,
    });

    assert.deepEqual(
      await collectEvents(
        replacementTransport.streamEvents(replacementRequest),
      ),
      [firstEvent, secondEvent, completedEvent],
      'the terminal artifact remains replayable after the live owner exits',
    );
    assert.equal(boundary.dispatchCount(), 1);
  },
);

void test(
  'a known retry starts one new provider request while the same attempt remains replay-only',
  { timeout: 30_000 },
  async (t) => {
    const boundary = await createProviderBoundary(
      t,
      'geulbat-provider-request-attempt-',
      (socket, dispatchCount) => {
        if (dispatchCount === 1) {
          socket.close(1008, 'first attempt rejected');
          return;
        }
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: { usage: { input_tokens: 1, output_tokens: 0 } },
          }),
        );
      },
    );
    const runtime = boundary.createRuntime();
    const transport = createTransport(runtime, boundary.stateRoot);
    const initial: ResponsesDurableRequestStreamArgs = {
      webSocketUrl: boundary.webSocketUrl,
      headers: new Headers({ Authorization: 'Bearer unchanged-test-token' }),
      serializedPayload: '{"type":"response.create","model":"test-model"}',
      providerSessionId: 'thread-auth-retry',
      requestAttempt: 0,
    };

    await assert.rejects(
      collectEvents(transport.streamEvents(initial)),
      /WebSocket closed/u,
    );
    const retry = { ...initial, requestAttempt: 1 };
    const retryEvents = await collectEvents(transport.streamEvents(retry));
    assert.equal(retryEvents.at(-1)?.['type'], 'response.completed');
    assert.deepEqual(
      await collectEvents(transport.streamEvents(retry)),
      retryEvents,
    );
    assert.equal(boundary.dispatchCount(), 2);
  },
);

void test(
  'closing a non-shutdown subscriber stops the owner and clears its coordinate',
  { timeout: 30_000 },
  async (t) => {
    let resolveProviderClosed: () => void = () => undefined;
    const providerClosed = new Promise<void>((resolve) => {
      resolveProviderClosed = resolve;
    });
    const boundary = await createProviderBoundary(
      t,
      'geulbat-provider-request-cancel-',
      (socket) => {
        socket.once('close', resolveProviderClosed);
        socket.send(
          JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'before cancellation',
          }),
        );
      },
    );
    const runtime = boundary.createRuntime();
    const transport = createTransport(runtime, boundary.stateRoot);
    const iterator = transport
      .streamEvents({
        webSocketUrl: boundary.webSocketUrl,
        headers: new Headers({ Authorization: 'Bearer cancellation-token' }),
        serializedPayload: '{"type":"response.create","model":"test-model"}',
        providerSessionId: 'thread-cancelled-request',
        requestAttempt: 0,
      })
      [Symbol.asyncIterator]();

    assert.equal(
      (await iterator.next()).value?.['type'],
      'response.output_text.delta',
    );
    assert.equal(typeof iterator.return, 'function');
    await iterator.return?.(undefined);
    await providerClosed;
    assert.deepEqual(
      await readdir(
        join(boundary.stateRoot, '.geulbat', 'provider-request-coordinates'),
      ),
      [],
    );
  },
);

void test(
  'aborting a non-shutdown subscriber stops the owner and clears its coordinate',
  { timeout: 30_000 },
  async (t) => {
    let resolveProviderClosed: () => void = () => undefined;
    const providerClosed = new Promise<void>((resolve) => {
      resolveProviderClosed = resolve;
    });
    const boundary = await createProviderBoundary(
      t,
      'geulbat-provider-request-abort-',
      (socket) => {
        socket.once('close', resolveProviderClosed);
        socket.send(
          JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'before abort',
          }),
        );
      },
    );
    const runtime = boundary.createRuntime();
    const transport = createTransport(runtime, boundary.stateRoot);
    const controller = new AbortController();
    const iterator = transport
      .streamEvents({
        webSocketUrl: boundary.webSocketUrl,
        headers: new Headers({ Authorization: 'Bearer abort-token' }),
        serializedPayload: '{"type":"response.create","model":"test-model"}',
        providerSessionId: 'thread-aborted-request',
        requestAttempt: 0,
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();

    assert.equal(
      (await iterator.next()).value?.['type'],
      'response.output_text.delta',
    );
    const pending = iterator.next();
    controller.abort('user_interrupt');

    await assert.rejects(pending);
    await providerClosed;
    assert.deepEqual(
      await readdir(
        join(boundary.stateRoot, '.geulbat', 'provider-request-coordinates'),
      ),
      [],
    );
  },
);

async function createProviderBoundary(
  t: { after(fn: () => Promise<void> | void): void },
  statePrefix: string,
  onDispatch: (socket: WebSocket, dispatchCount: number) => void,
): Promise<ProviderBoundary> {
  const stateRoot = await mkdtemp(join(tmpdir(), statePrefix));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const runtimes = new Set<WorkerRuntime>();
  let providerDispatches = 0;
  server.on('connection', (socket) => {
    socket.once('message', () => {
      providerDispatches += 1;
      onDispatch(socket, providerDispatches);
    });
  });
  t.after(async () => {
    for (const runtime of runtimes) {
      await runtime.closeAll().catch(() => undefined);
    }
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeCommandHostWorkspace(stateRoot);
  });

  return {
    stateRoot,
    webSocketUrl: `ws://127.0.0.1:${address.port}/responses`,
    createRuntime() {
      const runtime = createWorkerRuntime();
      runtimes.add(runtime);
      return runtime;
    },
    async closeRuntime(runtime) {
      runtimes.delete(runtime);
      await runtime.closeAll();
    },
    dispatchCount: () => providerDispatches,
  };
}

function createWorkerRuntime() {
  return createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 64 * 1024, tailRingBytes: 64 * 1024 },
    requestedMode: 'worker',
    workerCommand: commandHostWorkerCommand(),
  });
}

function createTransport(
  hostCommands: WorkerRuntime,
  stateRoot: string,
): ReturnType<typeof createHostRoutedResponsesRequestTransport> {
  return createHostRoutedResponsesRequestTransport({
    stateRoot,
    startProcess: createHostRoutedDetachedProcessStarter({
      hostCommands,
      stateRoot,
      pageLimitBytes: 64 * 1024,
      cwd: stateRoot,
      env: process.env,
      runId: 'provider-responses-test',
    }),
    attachProcess: createHostRoutedDetachedProcessAttacher({
      hostCommands,
      stateRoot,
      pageLimitBytes: 64 * 1024,
    }),
    resolveTerminalArtifactPath: (outputRef) =>
      join(
        buildHostCommandPaths({
          stateRoot,
          threadId: SYSTEM_SESSION_OWNER,
          outputRef,
        }).directory,
        'responses-terminal.json',
      ),
  });
}

function withoutSignal(
  request: ResponsesDurableRequestStreamArgs,
): ResponsesDurableRequestStreamArgs {
  const { signal: _signal, ...rest } = request;
  return rest;
}

async function collectEvents(
  events: AsyncIterable<Record<string, unknown>>,
): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function commandHostWorkerCommand(): NodeModuleCommand {
  const source = fileURLToPath(
    new URL('../../../../command-host/main.ts', import.meta.url),
  );
  const built = fileURLToPath(
    new URL('../../../../command-host/main.js', import.meta.url),
  );
  return existsSync(built)
    ? { execPath: process.execPath, args: [built] }
    : {
        execPath: process.execPath,
        args: ['--import', fileURLToPath(import.meta.resolve('tsx')), source],
      };
}
