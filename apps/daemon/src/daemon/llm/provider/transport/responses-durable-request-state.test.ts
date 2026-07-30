import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
      let startCount = 0;
      let attachCount = 0;
      let stopCount = 0;
      const transport = createHostRoutedResponsesRequestTransport({
        stateRoot,
        workerCommand,
        startProcess: async () => {
          startCount += 1;
          return {
            ok: true,
            handle: {
              outputRef: 'provider-host-exit',
              exit: Promise.resolve({
                kind: 'crash',
                message: 'worker crashed',
              }),
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
          };
        },
        attachProcess: async () => {
          attachCount += 1;
          return {
            ok: false,
            message: 'original provider owner is unavailable',
          };
        },
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
      assert.deepEqual(await transport.activeOutputRefs(stateRoot), {
        ok: true,
        refs: new Set(['provider-host-exit']),
      });
      await assert.rejects(
        collectEvents(transport.streamEvents(request)),
        /provider request outcome is unknown: original provider owner is unavailable/u,
      );
      assert.equal(startCount, 1);
      assert.equal(attachCount, 1);
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
    'explicit recovery keeps a late terminal artifact for replay',
    async () => {
      const pending = await seedPendingDurableRequest(
        t,
        'explicit-late-terminal',
      );
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

      assert.deepEqual(
        await pending.transport.recoverOutcomeUnknown({
          providerSessionId: pending.request.providerSessionId,
          authorizedByComputerSessionId: 'computer-late-terminal',
          acknowledgePossibleDuplicateProviderWork: true,
        }),
        { ok: true, disposition: 'terminal_available' },
      );
      assert.deepEqual(
        await collectEvents(pending.transport.streamEvents(pending.request)),
        [{ type: 'response.completed', response: { usage: {} } }],
      );
    },
  );

  await t.test(
    'explicit recovery preserves an owner that is still attachable',
    async () => {
      const pending = await seedPendingDurableRequest(t, 'explicit-live-owner');
      pending.makeOwnerAvailable();

      assert.deepEqual(
        await pending.transport.recoverOutcomeUnknown({
          providerSessionId: pending.request.providerSessionId,
          authorizedByComputerSessionId: 'computer-live-owner',
          acknowledgePossibleDuplicateProviderWork: true,
        }),
        { ok: true, disposition: 'owner_active' },
      );
      assert.deepEqual(
        await pending.transport.activeOutputRefs(pending.stateRoot),
        {
          ok: true,
          refs: new Set([pending.outputRef]),
        },
      );
    },
  );

  await t.test(
    'a restarted daemon discovers the exact coordinate, audits abandonment, and releases it',
    async () => {
      const pending = await seedPendingDurableRequest(t, 'explicit-abandon');
      const restartedTransport = createHostRoutedResponsesRequestTransport({
        stateRoot: pending.stateRoot,
        workerCommand: pending.workerCommand,
        startProcess: async () => ({
          ok: false,
          message: 'start must not run during recovery',
        }),
        attachProcess: async () => ({
          ok: false,
          message: 'the original owner is gone',
        }),
        resolveTerminalArtifactPath: () => pending.terminalPath,
      });

      assert.deepEqual(
        await restartedTransport.recoverOutcomeUnknown({
          providerSessionId: pending.request.providerSessionId,
          authorizedByComputerSessionId: 'computer-explicit-abandon',
          acknowledgePossibleDuplicateProviderWork: true,
        }),
        { ok: true, disposition: 'abandoned' },
      );
      assert.deepEqual(
        await restartedTransport.activeOutputRefs(pending.stateRoot),
        {
          ok: true,
          refs: new Set(),
        },
      );

      const abandonmentRoot = join(
        pending.stateRoot,
        '.geulbat',
        'provider-request-abandonments',
      );
      const auditEntries = await readdir(abandonmentRoot);
      assert.equal(auditEntries.length, 1);
      const auditEntry = auditEntries[0];
      assert.ok(auditEntry);
      const audit = JSON.parse(
        await readFile(join(abandonmentRoot, auditEntry), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(audit['action'], 'abandon_provider_request_outcome_unknown');
      assert.equal(audit['requestIdentity'], pending.requestIdentity);
      assert.equal(audit['outputRef'], pending.outputRef);
      assert.equal(audit['acknowledgePossibleDuplicateProviderWork'], true);
      assert.notEqual(
        audit['providerSessionIdentityHash'],
        pending.request.providerSessionId,
      );
      assert.notEqual(
        audit['actorComputerSessionIdentityHash'],
        'computer-explicit-abandon',
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
        (failure: unknown) => {
          assert.ok(failure instanceof Error);
          assert.match(
            failure.message,
            /completed without a durable terminal artifact/u,
          );
          assert.equal(
            Reflect.get(failure, 'llmCode'),
            'llm_provider_request_outcome_unknown',
          );
          return true;
        },
      );
      assert.equal(dispatched, 1);
      assert.equal(boundary.stopCount(), 1);
      assert.deepEqual(
        await boundary.transport.activeOutputRefs(boundary.stateRoot),
        {
          ok: true,
          refs: new Set(['provider-live-frame-output']),
        },
      );
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
    let resolveExit: () => void = () => undefined;
    const exit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const transport = createHostRoutedResponsesRequestTransport({
      stateRoot,
      workerCommand,
      startProcess: async () => ({
        ok: true,
        handle: {
          outputRef: 'provider-live-frame-output',
          exit,
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
            resolveExit();
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
    return { stateRoot, transport, stopCount: () => stopped };
  }
});

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
  let ownerAvailable = false;
  const ownerHandle = {
    outputRef,
    exit: new Promise(() => {}),
    drainNewOutput: () => ({ stdout: '', stderr: '' }),
    getOutputRevision: () => 0,
    waitForOutputChange: async () => 1,
    writeInput: async () => ({
      ok: false as const,
      message: 'seed pending coordinate',
    }),
    stop() {},
  };
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
        handle: ownerHandle,
      };
    },
    attachProcess: async () =>
      ownerAvailable
        ? { ok: true, handle: ownerHandle }
        : { ok: false, message: 'attach must not run' },
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
    outputRef,
    terminalPath,
    transport,
    makeOwnerAvailable() {
      ownerAvailable = true;
    },
  };
}
