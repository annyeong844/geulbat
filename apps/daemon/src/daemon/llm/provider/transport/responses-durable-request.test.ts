import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
  encodeResponsesDurableRequestFrame,
  hydrateResponsesDurableRequestError,
  parseResponsesDurableRequestFrame,
  RESPONSES_DURABLE_REQUEST_FRAME_PREFIX,
  RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
  parseResponsesDurableRequestInputFrame,
  parseResponsesDurableRequestTerminalArtifact,
  serializeResponsesDurableRequestError,
  type ResponsesDurableRequestInputFrame,
  type ResponsesDurableRequestSerializedError,
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
  assert.equal(parseResponsesDurableRequestInputFrame(null), undefined);
  assert.equal(parseResponsesDurableRequestFrame(null), undefined);
  assert.equal(
    parseResponsesDurableRequestFrame({
      version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
      requestIdentity: 'unknown-frame',
      subscriptionId: 'unknown-subscription',
      kind: 'unknown',
    }),
    undefined,
  );
  assert.equal(parseResponsesDurableRequestTerminalArtifact(null), undefined);
});

void test('durable request protocol preserves terminal failures and provider retry metadata', () => {
  const providerError = Object.assign(new Error('provider overloaded'), {
    llmCode: 'rate_limit',
    status: 429,
    retryAfterMs: 2_000,
  });
  const serialized = serializeResponsesDurableRequestError(providerError);
  assert.deepEqual(serialized, {
    message: 'provider overloaded',
    llmCode: 'rate_limit',
    status: 429,
    retryAfterMs: 2_000,
  });
  const hydrated = hydrateResponsesDurableRequestError(serialized);
  assert.equal(hydrated.message, 'provider overloaded');
  assert.equal(Reflect.get(hydrated, 'llmCode'), 'rate_limit');
  assert.equal(Reflect.get(hydrated, 'status'), 429);
  assert.equal(Reflect.get(hydrated, 'retryAfterMs'), 2_000);

  const failedFrame = {
    version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
    kind: 'failed',
    requestIdentity: 'request-failed',
    subscriptionId: 'subscription-failed',
    error: serialized,
  } as const;
  assert.deepEqual(parseResponsesDurableRequestFrame(failedFrame), failedFrame);
  assert.deepEqual(
    parseResponsesDurableRequestTerminalArtifact({
      version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
      requestIdentity: 'request-failed',
      dispatched: true,
      events: [{ type: 'response.output_text.delta', delta: 'partial' }],
      terminal: { kind: 'failed', error: serialized },
    }),
    {
      version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
      requestIdentity: 'request-failed',
      dispatched: true,
      events: [{ type: 'response.output_text.delta', delta: 'partial' }],
      terminal: { kind: 'failed', error: serialized },
    },
  );

  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  const descriptions = [
    serializeResponsesDurableRequestError(new Error('   ')).message,
    serializeResponsesDurableRequestError('   ').message,
    serializeResponsesDurableRequestError(undefined).message,
    serializeResponsesDurableRequestError(null).message,
    serializeResponsesDurableRequestError(circular).message,
  ];
  assert.deepEqual(descriptions, [
    'provider request failed (Error without a message)',
    'provider request failed (empty string thrown)',
    'provider request failed (undefined thrown)',
    'provider request failed (null thrown)',
    'provider request failed (object thrown: [object Object])',
  ]);
  assert.deepEqual(serializeResponsesDurableRequestError(' provider failed '), {
    message: 'provider failed',
  });
  assert.deepEqual(
    serializeResponsesDurableRequestError({
      message: 'not an Error',
      llmCode: 7,
      status: Number.NaN,
      retryAfterMs: Number.POSITIVE_INFINITY,
    }),
    {
      message:
        'provider request failed (object thrown: {"message":"not an Error","llmCode":7,"status":null,"retryAfterMs":null})',
    },
  );

  for (const invalidError of [
    undefined,
    { message: 7 },
    { message: 'bad', llmCode: 7 },
    { message: 'bad', status: Number.NaN },
    { message: 'bad', retryAfterMs: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(
      parseResponsesDurableRequestFrame({
        ...failedFrame,
        error: invalidError,
      }),
      undefined,
    );
  }
  assert.equal(
    parseResponsesDurableRequestTerminalArtifact({
      version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
      requestIdentity: 'request-failed',
      dispatched: true,
      events: [],
      terminal: { kind: 'failed', error: { message: 7 } },
    }),
    undefined,
  );
});

void test('durable request transport contains host start, commit, and exit failures', async (t) => {
  const request: ResponsesDurableRequestStreamArgs = {
    webSocketUrl: 'wss://provider.example/responses',
    headers: new Headers({
      Authorization: 'Bearer private-host-token',
      'Content-Type': 'application/json',
    }),
    serializedPayload: '{"type":"response.create","model":"test-model"}',
    providerSessionId: 'host-failure-boundaries',
    requestAttempt: 0,
  };
  const workerCommand = { execPath: '/worker', args: ['host-main.js'] };

  await t.test(
    'host start is rejected before a coordinate is written',
    async () => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-provider-start-failure-'),
      );
      t.after(
        async () => await rm(stateRoot, { recursive: true, force: true }),
      );
      const transport = createHostRoutedResponsesRequestTransport({
        stateRoot,
        workerCommand,
        startProcess: async () => ({
          ok: false,
          message: 'worker unavailable',
        }),
        attachProcess: async () => ({
          ok: false,
          message: 'attach must not run',
        }),
        resolveTerminalArtifactPath: (outputRef) =>
          join(stateRoot, `${outputRef}.terminal.json`),
      });

      await assert.rejects(
        collectEvents(transport.streamEvents(request)),
        /provider request host start failed: worker unavailable/u,
      );
      assert.deepEqual(
        await transport.activeOutputRefs('/another-state-root'),
        {
          ok: true,
          refs: new Set(),
        },
      );
      assert.deepEqual(await transport.activeOutputRefs(stateRoot), {
        ok: true,
        refs: new Set(),
      });
    },
  );

  await t.test(
    'commit failure preserves the owner coordinate for retry',
    async () => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-provider-commit-failure-'),
      );
      t.after(
        async () => await rm(stateRoot, { recursive: true, force: true }),
      );
      let stopCount = 0;
      const transport = createHostRoutedResponsesRequestTransport({
        stateRoot,
        workerCommand,
        startProcess: async () => ({
          ok: true,
          handle: {
            outputRef: 'provider-commit-failure',
            exit: new Promise(() => {}),
            drainNewOutput: () => ({ stdout: '', stderr: '' }),
            getOutputRevision: () => 0,
            waitForOutputChange: async () => 1,
            writeInput: async () => ({
              ok: false,
              message: 'commit channel unavailable',
            }),
            stop() {
              stopCount += 1;
            },
          },
        }),
        attachProcess: async () => ({
          ok: false,
          message: 'attach must not run',
        }),
        resolveTerminalArtifactPath: (outputRef) =>
          join(stateRoot, `${outputRef}.terminal.json`),
      });

      await assert.rejects(
        collectEvents(transport.streamEvents(request)),
        /provider request outcome is unknown: commit channel unavailable/u,
      );
      assert.equal(stopCount, 0);
      assert.deepEqual(await transport.activeOutputRefs(stateRoot), {
        ok: true,
        refs: new Set(['provider-commit-failure']),
      });
    },
  );

  await t.test(
    'host exit preserves diagnostics while redacting credentials',
    async () => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-provider-host-exit-'),
      );
      t.after(
        async () => await rm(stateRoot, { recursive: true, force: true }),
      );
      let stopCount = 0;
      const transport = createHostRoutedResponsesRequestTransport({
        stateRoot,
        workerCommand,
        startProcess: async () => ({
          ok: true,
          handle: {
            outputRef: 'provider-host-exit',
            exit: Promise.resolve({ kind: 'crash', message: 'worker crashed' }),
            drainNewOutput: () => ({
              stdout: '',
              stderr: 'provider rejected Bearer private-host-token',
            }),
            getOutputRevision: () => 0,
            waitForOutputChange: async () =>
              await new Promise<number>(() => {}),
            writeInput: async () => ({ ok: true }),
            stop() {
              stopCount += 1;
            },
          },
        }),
        attachProcess: async () => ({
          ok: false,
          message: 'attach must not run',
        }),
        resolveTerminalArtifactPath: (outputRef) =>
          join(stateRoot, `${outputRef}.terminal.json`),
      });

      await assert.rejects(
        collectEvents(transport.streamEvents(request)),
        (error: unknown) => {
          assert.equal(error instanceof Error, true);
          const message = error instanceof Error ? error.message : '';
          assert.match(message, /provider request host exited/u);
          assert.match(message, /host stderr:/u);
          assert.doesNotMatch(message, /private-host-token/u);
          assert.match(message, /provider-credential-redacted/u);
          return true;
        },
      );
      assert.equal(stopCount, 1);
    },
  );

  await t.test('host exit drains final accepted and event frames', async () => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-provider-host-final-drain-'),
    );
    t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
    let drainCount = 0;
    let finalOutput = '';
    let stopCount = 0;
    const transport = createHostRoutedResponsesRequestTransport({
      stateRoot,
      workerCommand,
      startProcess: async () => ({
        ok: true,
        handle: {
          outputRef: 'provider-host-final-drain',
          exit: Promise.resolve({ kind: 'exit', exitCode: 0 }),
          drainNewOutput() {
            drainCount += 1;
            return {
              stdout: drainCount === 1 ? '' : finalOutput,
              stderr: '',
            };
          },
          getOutputRevision: () => 0,
          waitForOutputChange: async () => await new Promise<number>(() => {}),
          writeInput: async (input) => {
            const line = input
              .trim()
              .slice(RESPONSES_DURABLE_REQUEST_FRAME_PREFIX.length);
            const commit = parseResponsesDurableRequestInputFrame(
              JSON.parse(line),
            );
            assert.ok(commit && commit.kind === 'commit');
            finalOutput = [
              encodeResponsesDurableRequestFrame({
                version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
                kind: 'accepted',
                requestIdentity: commit.requestIdentity,
                subscriptionId: commit.subscriptionId,
              }),
              encodeResponsesDurableRequestFrame({
                version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
                kind: 'event',
                requestIdentity: commit.requestIdentity,
                subscriptionId: commit.subscriptionId,
                event: {
                  type: 'response.output_text.delta',
                  delta: 'drained after exit',
                },
              }),
            ].join('');
            return { ok: true };
          },
          stop() {
            stopCount += 1;
          },
        },
      }),
      attachProcess: async () => ({
        ok: false,
        message: 'attach must not run',
      }),
      resolveTerminalArtifactPath: (outputRef) =>
        join(stateRoot, `${outputRef}.terminal.json`),
    });
    const iterator = transport.streamEvents(request)[Symbol.asyncIterator]();

    assert.deepEqual(await iterator.next(), {
      done: false,
      value: {
        type: 'response.output_text.delta',
        delta: 'drained after exit',
      },
    });
    await assert.rejects(
      iterator.next(),
      /provider request host exited \(exit:0\)/u,
    );
    assert.equal(stopCount, 1);
  });

  await t.test(
    'active output inventory fails closed on an unreadable coordinate',
    async () => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-provider-active-output-'),
      );
      t.after(
        async () => await rm(stateRoot, { recursive: true, force: true }),
      );
      const coordinateRoot = join(
        stateRoot,
        '.geulbat',
        'provider-request-coordinates',
      );
      await mkdir(coordinateRoot, { recursive: true });
      await writeFile(join(coordinateRoot, 'ignored.txt'), 'ignored\n');
      await writeFile(
        join(coordinateRoot, 'active.json'),
        `${JSON.stringify({
          version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
          requestIdentity: 'active-request',
          outputRef: 'active-output-ref',
        })}\n`,
      );
      const transport = createHostRoutedResponsesRequestTransport({
        stateRoot,
        workerCommand,
        startProcess: async () => ({
          ok: false,
          message: 'start must not run',
        }),
        attachProcess: async () => ({
          ok: false,
          message: 'attach must not run',
        }),
        resolveTerminalArtifactPath: (outputRef) =>
          join(stateRoot, `${outputRef}.terminal.json`),
      });
      assert.deepEqual(await transport.activeOutputRefs(stateRoot), {
        ok: true,
        refs: new Set(['active-output-ref']),
      });

      await writeFile(join(coordinateRoot, 'active.json'), '{');
      assert.deepEqual(await transport.activeOutputRefs(stateRoot), {
        ok: false,
        reason: 'provider request coordinate could not be read',
      });
    },
  );

  await t.test(
    'active output inventory fails closed when its root is not a directory',
    async () => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-provider-active-output-root-'),
      );
      t.after(
        async () => await rm(stateRoot, { recursive: true, force: true }),
      );
      const coordinateRoot = join(
        stateRoot,
        '.geulbat',
        'provider-request-coordinates',
      );
      await mkdir(join(stateRoot, '.geulbat'), { recursive: true });
      await writeFile(coordinateRoot, 'not a directory', 'utf8');
      const transport = createHostRoutedResponsesRequestTransport({
        stateRoot,
        workerCommand,
        startProcess: async () => ({
          ok: false,
          message: 'start must not run',
        }),
        attachProcess: async () => ({
          ok: false,
          message: 'attach must not run',
        }),
        resolveTerminalArtifactPath: (outputRef) =>
          join(stateRoot, `${outputRef}.terminal.json`),
      });

      assert.deepEqual(await transport.activeOutputRefs(stateRoot), {
        ok: false,
        reason: 'provider request coordinates could not be listed',
      });
    },
  );
});

void test('durable request retry resolves only from durable owner evidence', async (t) => {
  await t.test(
    'attach failure replays a terminal artifact won by the host',
    async () => {
      const pending = await seedPendingDurableRequest(t, 'attach-terminal-win');
      const transport = createHostRoutedResponsesRequestTransport({
        stateRoot: pending.stateRoot,
        workerCommand: pending.workerCommand,
        startProcess: async () => ({
          ok: false,
          message: 'start must not run',
        }),
        attachProcess: async () => {
          await writeFile(
            pending.terminalPath,
            `${JSON.stringify({
              version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
              requestIdentity: pending.requestIdentity,
              dispatched: true,
              events: [{ type: 'response.completed', response: { usage: {} } }],
              terminal: { kind: 'completed' },
            })}\n`,
          );
          return { ok: false, message: 'owner exited during attach' };
        },
        resolveTerminalArtifactPath: () => pending.terminalPath,
      });
      let dispatched = 0;

      assert.deepEqual(
        await collectEvents(
          transport.streamEvents({
            ...pending.request,
            onDispatched() {
              dispatched += 1;
            },
          }),
        ),
        [{ type: 'response.completed', response: { usage: {} } }],
      );
      assert.equal(dispatched, 1);
    },
  );

  await t.test('an invalid owner terminal artifact fails closed', async () => {
    const pending = await seedPendingDurableRequest(t, 'invalid-terminal');
    await writeFile(pending.terminalPath, '{');
    const transport = createHostRoutedResponsesRequestTransport({
      stateRoot: pending.stateRoot,
      workerCommand: pending.workerCommand,
      startProcess: async () => ({
        ok: false,
        message: 'start must not run',
      }),
      attachProcess: async () => ({
        ok: false,
        message: 'attach must not run',
      }),
      resolveTerminalArtifactPath: () => pending.terminalPath,
    });

    await assert.rejects(
      collectEvents(transport.streamEvents(pending.request)),
      /terminal artifact is unreadable/u,
    );
  });

  await t.test(
    'an unreadable owner coordinate fails closed before attach',
    async () => {
      const pending = await seedPendingDurableRequest(t, 'invalid-coordinate');
      const coordinateRoot = join(
        pending.stateRoot,
        '.geulbat',
        'provider-request-coordinates',
      );
      const [coordinateName] = await readdir(coordinateRoot);
      assert.ok(coordinateName);
      await writeFile(join(coordinateRoot, coordinateName), '{', 'utf8');
      const transport = createHostRoutedResponsesRequestTransport({
        stateRoot: pending.stateRoot,
        workerCommand: pending.workerCommand,
        startProcess: async () => ({
          ok: false,
          message: 'start must not run',
        }),
        attachProcess: async () => ({
          ok: false,
          message: 'attach must not run',
        }),
        resolveTerminalArtifactPath: () => pending.terminalPath,
      });

      await assert.rejects(
        collectEvents(transport.streamEvents(pending.request)),
        /provider request coordinate is unreadable/u,
      );
    },
  );

  await t.test(
    'attach failure without terminal evidence stays unknown',
    async () => {
      const pending = await seedPendingDurableRequest(t, 'attach-unknown');
      const transport = createHostRoutedResponsesRequestTransport({
        stateRoot: pending.stateRoot,
        workerCommand: pending.workerCommand,
        startProcess: async () => ({
          ok: false,
          message: 'start must not run',
        }),
        attachProcess: async () => ({
          ok: false,
          message: 'owner unavailable',
        }),
        resolveTerminalArtifactPath: () => pending.terminalPath,
      });

      await assert.rejects(
        collectEvents(transport.streamEvents(pending.request)),
        /provider request outcome is unknown: owner unavailable/u,
      );
    },
  );

  await t.test(
    'commit failure replays a terminal artifact won by the host',
    async () => {
      const stateRoot = await mkdtemp(
        join(tmpdir(), 'geulbat-provider-commit-terminal-win-'),
      );
      t.after(
        async () => await rm(stateRoot, { recursive: true, force: true }),
      );
      const terminalPath = join(stateRoot, 'commit-terminal.json');
      let requestIdentity = '';
      const transport = createHostRoutedResponsesRequestTransport({
        stateRoot,
        workerCommand: { execPath: '/worker', args: ['host-main.js'] },
        startProcess: async (start) => {
          requestIdentity = start.callId;
          return {
            ok: true,
            handle: {
              outputRef: 'provider-commit-terminal-win',
              exit: new Promise(() => {}),
              drainNewOutput: () => ({ stdout: '', stderr: '' }),
              getOutputRevision: () => 0,
              waitForOutputChange: async () => 1,
              writeInput: async () => {
                await writeFile(
                  terminalPath,
                  `${JSON.stringify({
                    version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
                    requestIdentity,
                    dispatched: true,
                    events: [{ type: 'response.completed', response: {} }],
                    terminal: { kind: 'completed' },
                  })}\n`,
                );
                return { ok: false, message: 'host exited after commit' };
              },
              stop() {},
            },
          };
        },
        attachProcess: async () => ({
          ok: false,
          message: 'attach must not run',
        }),
        resolveTerminalArtifactPath: () => terminalPath,
      });

      assert.deepEqual(
        await collectEvents(
          transport.streamEvents({
            webSocketUrl: 'wss://provider.example/responses',
            headers: new Headers(),
            serializedPayload: '{"type":"response.create"}',
            providerSessionId: 'commit-terminal-win',
            requestAttempt: 0,
          }),
        ),
        [{ type: 'response.completed', response: {} }],
      );
    },
  );

  await t.test('a new attempt cannot replace an unresolved owner', async () => {
    const pending = await seedPendingDurableRequest(t, 'unresolved-owner');
    const transport = createHostRoutedResponsesRequestTransport({
      stateRoot: pending.stateRoot,
      workerCommand: pending.workerCommand,
      startProcess: async () => ({
        ok: false,
        message: 'start must not run',
      }),
      attachProcess: async () => ({
        ok: false,
        message: 'attach must not run',
      }),
      resolveTerminalArtifactPath: () => pending.terminalPath,
    });

    await assert.rejects(
      collectEvents(
        transport.streamEvents({
          ...pending.request,
          requestAttempt: pending.request.requestAttempt + 1,
        }),
      ),
      /already has an unresolved durable request/u,
    );
  });
});

void test('durable request transport refuses live terminal frames without their artifact', async (t) => {
  const request: ResponsesDurableRequestStreamArgs = {
    webSocketUrl: 'wss://provider.example/responses',
    headers: new Headers({ Authorization: 'Bearer private-frame-token' }),
    serializedPayload: '{"type":"response.create","model":"test-model"}',
    providerSessionId: 'live-frame-terminal-boundary',
    requestAttempt: 0,
  };
  const workerCommand = { execPath: '/worker', args: ['host-main.js'] };

  await t.test(
    'completed frame without terminal artifact is rejected',
    async () => {
      const boundary = await createLiveFrameBoundary(t, [
        { kind: 'accepted' },
        {
          kind: 'event',
          event: { type: 'response.output_text.delta', delta: 'partial' },
        },
        { kind: 'completed' },
      ]);
      let dispatched = 0;

      await assert.rejects(
        collectEvents(
          boundary.transport.streamEvents({
            ...request,
            onDispatched() {
              dispatched += 1;
            },
          }),
        ),
        /completed without a durable terminal artifact/u,
      );
      assert.equal(dispatched, 1);
      assert.equal(boundary.stopCount(), 1);
    },
  );

  await t.test(
    'failed frame preserves its structured provider error',
    async () => {
      const error: ResponsesDurableRequestSerializedError = {
        message: 'provider capacity exhausted',
        llmCode: 'rate_limit',
        status: 429,
        retryAfterMs: 3_000,
      };
      const boundary = await createLiveFrameBoundary(t, [
        { kind: 'accepted' },
        { kind: 'failed', error },
      ]);

      await assert.rejects(
        collectEvents(boundary.transport.streamEvents(request)),
        (failure: unknown) => {
          assert.ok(failure instanceof Error);
          assert.equal(failure.message, error.message);
          assert.equal(Reflect.get(failure, 'llmCode'), error.llmCode);
          assert.equal(Reflect.get(failure, 'status'), error.status);
          assert.equal(
            Reflect.get(failure, 'retryAfterMs'),
            error.retryAfterMs,
          );
          return true;
        },
      );
      assert.equal(boundary.stopCount(), 0);
    },
  );

  async function createLiveFrameBoundary(
    parent: { after(fn: () => Promise<void> | void): void },
    frames: Array<
      | { kind: 'accepted' | 'completed' }
      | { kind: 'event'; event: Record<string, unknown> }
      | { kind: 'failed'; error: ResponsesDurableRequestSerializedError }
    >,
  ) {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-provider-live-frame-'),
    );
    parent.after(
      async () => await rm(stateRoot, { recursive: true, force: true }),
    );
    let output = '';
    let stopped = 0;
    const transport = createHostRoutedResponsesRequestTransport({
      stateRoot,
      workerCommand,
      startProcess: async () => ({
        ok: true,
        handle: {
          outputRef: 'provider-live-frame-output',
          exit: new Promise(() => {}),
          drainNewOutput() {
            const drained = output;
            output = '';
            return { stdout: drained, stderr: '' };
          },
          getOutputRevision: () => 0,
          waitForOutputChange: async () => 1,
          writeInput: async (input) => {
            const line = input
              .trim()
              .slice(RESPONSES_DURABLE_REQUEST_FRAME_PREFIX.length);
            const commit = parseResponsesDurableRequestInputFrame(
              JSON.parse(line),
            );
            assert.equal(commit?.kind, 'commit');
            assert.ok(commit && commit.kind === 'commit');
            output = frames
              .map((frame) =>
                encodeResponsesDurableRequestFrame({
                  version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
                  requestIdentity: commit.requestIdentity,
                  subscriptionId: commit.subscriptionId,
                  ...frame,
                }),
              )
              .join('');
            return { ok: true };
          },
          stop() {
            stopped += 1;
          },
        },
      }),
      attachProcess: async () => ({
        ok: false,
        message: 'attach must not run',
      }),
      resolveTerminalArtifactPath: (outputRef) =>
        join(stateRoot, `${outputRef}.terminal.json`),
    });
    return { transport, stopCount: () => stopped };
  }
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
  'HTTP JSON-SSE durable host records a successful stream once and replays it without resending',
  { timeout: 30_000 },
  async (t) => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-provider-http-replay-'),
    );
    let requestCount = 0;
    const server = createServer((request, response) => {
      requestCount += 1;
      request.resume();
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(
        'data: {"type":"response.output_text.delta","delta":"hello","credential":"private-http-token"}\n\n',
      );
      response.end(
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      );
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

    const request = {
      requestUrl: `http://127.0.0.1:${address.port}/responses`,
      headers: new Headers({
        Authorization: 'Bearer private-http-token',
        'Content-Type': 'application/json',
      }),
      serializedPayload: '{"model":"test-model","stream":true}',
      providerSessionId: 'http-success-replay',
      requestAttempt: 0,
    };
    const expected = [
      {
        type: 'response.output_text.delta',
        delta: 'hello',
        credential: '[provider-credential-redacted]',
      },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ];

    assert.deepEqual(
      await collectEvents(streamHttpSseEvents!(request)),
      expected,
    );
    assert.deepEqual(
      await collectEvents(streamHttpSseEvents!(request)),
      expected,
    );
    assert.equal(requestCount, 1);
  },
);

void test(
  'durable request host reports terminal artifact commit failure without redispatching',
  { timeout: 30_000 },
  async (t) => {
    const stateRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-provider-terminal-store-failure-'),
    );
    const blockedParent = join(stateRoot, 'blocked-parent');
    await writeFile(blockedParent, 'not a directory', 'utf8');
    let requestCount = 0;
    const server = createServer((request, response) => {
      requestCount += 1;
      request.resume();
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        'data: {"type":"response.completed","response":{"usage":{}}}\n\n',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const runtime = createWorkerRuntime();
    const transport = createTransport(runtime, stateRoot, () =>
      join(blockedParent, 'responses-terminal.json'),
    );
    t.after(async () => {
      await runtime.closeAll().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeCommandHostWorkspace(stateRoot);
    });

    await assert.rejects(
      collectEvents(
        transport.streamHttpSseEvents!({
          requestUrl: `http://127.0.0.1:${address.port}/responses`,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          serializedPayload: '{"model":"test-model","stream":true}',
          providerSessionId: 'terminal-store-failure',
          requestAttempt: 0,
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /terminal artifact could not be committed/u,
        );
        assert.equal(
          Reflect.get(error, 'llmCode'),
          'llm_durable_result_store_failed',
        );
        return true;
      },
    );
    assert.equal(requestCount, 1);
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
  'a replacement subscriber cannot change the durable terminal artifact path',
  { timeout: 30_000 },
  async (t) => {
    let releaseProvider: () => void = () => undefined;
    const continueProvider = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const boundary = await createProviderBoundary(
      t,
      'geulbat-provider-terminal-path-conflict-',
      (socket) => {
        socket.send(
          JSON.stringify({
            type: 'response.output_text.delta',
            delta: 'dispatched once',
          }),
        );
        void continueProvider.then(() => {
          socket.send(
            JSON.stringify({
              type: 'response.completed',
              response: { usage: {} },
            }),
          );
        });
      },
    );
    t.after(releaseProvider);
    const runtime = boundary.createRuntime();
    const firstTransport = createTransport(
      runtime,
      boundary.stateRoot,
      (outputRef) =>
        join(
          buildHostCommandPaths({
            stateRoot: boundary.stateRoot,
            threadId: SYSTEM_SESSION_OWNER,
            outputRef,
          }).directory,
          'responses-terminal-first.json',
        ),
    );
    const shutdown = new AbortController();
    const request: ResponsesDurableRequestStreamArgs = {
      webSocketUrl: boundary.webSocketUrl,
      headers: new Headers({ Authorization: 'Bearer path-conflict-token' }),
      serializedPayload: '{"type":"response.create","model":"test-model"}',
      providerSessionId: 'terminal-path-conflict',
      requestAttempt: 0,
      signal: shutdown.signal,
    };
    const first = firstTransport.streamEvents(request)[Symbol.asyncIterator]();
    assert.equal((await first.next()).value?.['delta'], 'dispatched once');
    shutdown.abort('daemon_shutdown');
    await assert.rejects(first.next());

    const replacementTransport = createTransport(
      runtime,
      boundary.stateRoot,
      (outputRef) =>
        join(
          buildHostCommandPaths({
            stateRoot: boundary.stateRoot,
            threadId: SYSTEM_SESSION_OWNER,
            outputRef,
          }).directory,
          'responses-terminal-replacement.json',
        ),
    );
    await assert.rejects(
      collectEvents(replacementTransport.streamEvents(withoutSignal(request))),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /terminal artifact path changed/u);
        assert.equal(
          Reflect.get(error, 'llmCode'),
          'llm_durable_request_identity_conflict',
        );
        return true;
      },
    );
    assert.equal(boundary.dispatchCount(), 1);
    releaseProvider();
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
  resolveTerminalArtifactPath: (outputRef: string) => string = (outputRef) =>
    join(
      buildHostCommandPaths({
        stateRoot,
        threadId: SYSTEM_SESSION_OWNER,
        outputRef,
      }).directory,
      'responses-terminal.json',
    ),
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
    resolveTerminalArtifactPath,
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

async function seedPendingDurableRequest(
  t: { after(fn: () => Promise<void> | void): void },
  suffix: string,
) {
  const stateRoot = await mkdtemp(
    join(tmpdir(), `geulbat-provider-pending-${suffix}-`),
  );
  t.after(async () => await rm(stateRoot, { recursive: true, force: true }));
  const workerCommand = { execPath: '/worker', args: ['host-main.js'] };
  const outputRef = `provider-pending-${suffix}`;
  const terminalPath = join(stateRoot, `${outputRef}.terminal.json`);
  let requestIdentity = '';
  const request: ResponsesDurableRequestStreamArgs = {
    webSocketUrl: 'wss://provider.example/responses',
    headers: new Headers({ Authorization: 'Bearer private-pending-token' }),
    serializedPayload: '{"type":"response.create","model":"test-model"}',
    providerSessionId: `pending-${suffix}`,
    requestAttempt: 0,
  };
  const transport = createHostRoutedResponsesRequestTransport({
    stateRoot,
    workerCommand,
    startProcess: async (start) => {
      requestIdentity = start.callId;
      return {
        ok: true,
        handle: {
          outputRef,
          exit: new Promise(() => {}),
          drainNewOutput: () => ({ stdout: '', stderr: '' }),
          getOutputRevision: () => 0,
          waitForOutputChange: async () => 1,
          writeInput: async () => ({
            ok: false,
            message: 'seed pending coordinate',
          }),
          stop() {},
        },
      };
    },
    attachProcess: async () => ({
      ok: false,
      message: 'attach must not run',
    }),
    resolveTerminalArtifactPath: () => terminalPath,
  });
  await assert.rejects(
    collectEvents(transport.streamEvents(request)),
    /outcome is unknown: seed pending coordinate/u,
  );
  assert.notEqual(requestIdentity, '');
  return {
    stateRoot,
    workerCommand,
    request,
    requestIdentity,
    terminalPath,
  };
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
