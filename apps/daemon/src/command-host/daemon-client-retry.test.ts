import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createCommandHostClient } from './daemon-client.js';
import {
  buildErrorResponse,
  buildResultResponse,
  COMMAND_HOST_METHODS,
  COMMAND_HOST_NOTIFICATIONS,
  COMMAND_HOST_PROTOCOL_VERSION,
  encodeFrame,
  FrameDecoder,
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  REQUEST_CANCELLED_CODE,
  type JsonRpcId,
} from './protocol.js';
import { resolveCommandHostPaths } from './runtime-paths.js';
import { removeCommandHostWorkspace } from '../test-support/command-host-workspace.js';

// P7.5 spec v4 §4.7 — 파사드 쪽 재시도 계약. 워커가 아니라 **연결만** 죽는
// 창은 실제 워커로는 만들 수 없어서(워커를 죽이면 세션도 함께 간다) 여기서는
// 프로토콜을 그대로 말하는 대역 서버를 세우고 첫 응답만 삼킨다.

const THREAD = 'thread-retry';

interface ScriptedWorker {
  stateRoot: string;
  /** 받은 session/start params — capability gate와 wire shape의 관측점. */
  starts: Array<Record<string, unknown>>;
  /** 받은 session/interact params — 재전송 여부와 동일성의 관측점. */
  interactions: Array<Record<string, unknown>>;
  cancelledRequestIds: JsonRpcId[];
  initialWaitObserved: Promise<void>;
  connections: number;
}

async function makeScriptedWorker(
  t: { after(fn: () => Promise<void> | void): void },
  options: {
    dropFirstInteractResponse: boolean;
    capabilities?: Record<string, unknown>;
    holdInitialWait?: boolean;
  },
): Promise<ScriptedWorker> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-retry-'));
  const paths = await resolveCommandHostPaths(stateRoot);
  let observeInitialWait!: () => void;
  const state: ScriptedWorker = {
    stateRoot,
    starts: [],
    interactions: [],
    cancelledRequestIds: [],
    initialWaitObserved: new Promise((resolve) => {
      observeInitialWait = resolve;
    }),
    connections: 0,
  };

  // 살아 있는 연결이 하나라도 남아 있으면 server.close()의 콜백은 오지
  // 않는다 — 정리 순서와 무관하게 끝나도록 소켓을 들고 있는다.
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    state.connections += 1;
    open.add(socket);
    socket.on('close', () => {
      open.delete(socket);
    });
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        const parsed = jsonRpcRequestSchema.safeParse(frame.message);
        if (!parsed.success) {
          const notification = jsonRpcNotificationSchema.safeParse(
            frame.message,
          );
          if (
            notification.success &&
            notification.data.method ===
              COMMAND_HOST_NOTIFICATIONS.cancelRequest
          ) {
            const cancelledId = (notification.data.params as { id: JsonRpcId })
              .id;
            state.cancelledRequestIds.push(cancelledId);
            socket.write(
              encodeFrame(
                buildErrorResponse(
                  cancelledId,
                  REQUEST_CANCELLED_CODE,
                  'request cancelled',
                ),
              ),
            );
          }
          continue;
        }
        const { id, method, params } = parsed.data;
        if (method === COMMAND_HOST_METHODS.initialize) {
          socket.write(
            encodeFrame(
              buildResultResponse(id, {
                selectedVersion: COMMAND_HOST_PROTOCOL_VERSION,
                supportedVersions: [COMMAND_HOST_PROTOCOL_VERSION],
                capabilities: options.capabilities ?? {},
                effectiveConfig: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
              }),
            ),
          );
          continue;
        }
        if (method === COMMAND_HOST_METHODS.start) {
          state.starts.push(params as Record<string, unknown>);
          socket.write(
            encodeFrame(
              buildResultResponse(id, {
                ok: true,
                outputRef: 'command-output:system/scripted-start',
              }),
            ),
          );
          continue;
        }
        if (method === COMMAND_HOST_METHODS.waitInitial) {
          observeInitialWait();
          if (options.holdInitialWait === true) {
            continue;
          }
          socket.write(
            encodeFrame(
              buildResultResponse(id, {
                ok: false,
                reasonCode: 'not_found',
                message: 'scripted session was not found',
              }),
            ),
          );
          continue;
        }
        if (method !== COMMAND_HOST_METHODS.interact) {
          continue;
        }
        state.interactions.push(params as Record<string, unknown>);
        if (
          options.dropFirstInteractResponse &&
          state.interactions.length === 1
        ) {
          // 워커는 처리했지만 응답이 호출자에게 닿지 못한 창.
          socket.destroy();
          continue;
        }
        socket.write(
          encodeFrame(
            buildResultResponse(id, {
              ok: true,
              value: {
                snapshot: {
                  outputRef: (params as { outputRef: string }).outputRef,
                  status: 'running',
                  revision: 1,
                },
                page: null,
              },
            }),
          ),
        );
      }
    });
    socket.on('error', () => {
      // 대역 서버는 끊긴 소켓을 진단할 대상이 아니다.
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(paths.socketPath, resolve);
  });
  // 파사드는 lock owner가 살아 있을 때만 재접속한다 (§8.2).
  await writeFile(
    paths.lockPath,
    JSON.stringify({
      lockFormatVersion: 1,
      ownerMode: 'worker',
      pid: process.pid,
      birthTokenMs: Date.now(),
      stateRootFingerprint: paths.stateRootFingerprint,
    }),
    { mode: 0o600 },
  );

  t.after(async () => {
    for (const socket of open) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await rm(paths.lockPath, { force: true });
    await rm(paths.socketPath, { force: true });
    await removeCommandHostWorkspace(stateRoot);
  });
  return state;
}

void test('output redaction and lossless stdio fail closed against an older worker', async (t) => {
  const worker = await makeScriptedWorker(t, {
    dropFirstInteractResponse: false,
  });
  const client = createCommandHostClient({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
  });
  t.after(async () => {
    await client.closeAll();
  });

  const started = await client.start({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("private-token")'],
    cwd: worker.stateRoot,
    env: process.env,
    stateRoot: worker.stateRoot,
    threadId: THREAD,
    owner: 'system',
    streamMode: 'lossless',
    runId: 'run-redaction-gate',
    callId: 'call-redaction-gate',
    stdinMode: 'closed',
    outputRedaction: {
      exactMarkers: ['private-token'],
      replacement: '[redacted]',
    },
  });

  assert.equal(started.ok, false);
  assert.equal(worker.starts.length, 0, 'no command crossed the old boundary');
});

void test('deferred output release fails closed before crossing an older worker boundary', async (t) => {
  const worker = await makeScriptedWorker(t, {
    dropFirstInteractResponse: false,
    capabilities: {
      losslessStdio: true,
      prePersistenceOutputRedaction: true,
    },
  });
  const client = createCommandHostClient({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
  });
  t.after(async () => {
    await client.closeAll();
  });

  const started = await client.start({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("durable-output")'],
    cwd: worker.stateRoot,
    env: process.env,
    stateRoot: worker.stateRoot,
    threadId: THREAD,
    owner: 'system',
    streamMode: 'lossless',
    requiresDeferredOutputRelease: true,
    runId: 'run-deferred-release-gate',
    callId: 'call-deferred-release-gate',
    stdinMode: 'closed',
  });

  assert.equal(started.ok, false);
  assert.equal(worker.starts.length, 0, 'no command crossed the old boundary');
});

void test('idempotent start fails closed before crossing an older worker boundary', async (t) => {
  const worker = await makeScriptedWorker(t, {
    dropFirstInteractResponse: false,
    capabilities: {
      deferredOutputRelease: true,
      losslessStdio: true,
      prePersistenceOutputRedaction: true,
    },
  });
  const client = createCommandHostClient({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
  });
  t.after(async () => {
    await client.closeAll();
  });

  const started = await client.start({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: worker.stateRoot,
    env: process.env,
    stateRoot: worker.stateRoot,
    threadId: THREAD,
    owner: 'system',
    streamMode: 'lossless',
    requiresDeferredOutputRelease: true,
    requiresIdempotentStart: true,
    runId: 'run-idempotent-start-gate',
    callId: 'call-idempotent-start-gate',
    stdinMode: 'open',
  });

  assert.equal(started.ok, false);
  assert.equal(worker.starts.length, 0, 'no command crossed the old boundary');
});

void test('initial stdin fails closed before crossing an older worker boundary', async (t) => {
  const worker = await makeScriptedWorker(t, {
    dropFirstInteractResponse: false,
    capabilities: {
      deferredOutputRelease: true,
      idempotentStartByInvocation: true,
      losslessStdio: true,
      prePersistenceOutputRedaction: true,
    },
  });
  const client = createCommandHostClient({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
  });
  t.after(async () => {
    await client.closeAll();
  });

  const started = await client.start({
    executable: process.execPath,
    args: ['-e', 'process.stdin.resume()'],
    cwd: worker.stateRoot,
    env: process.env,
    stateRoot: worker.stateRoot,
    threadId: THREAD,
    owner: 'system',
    streamMode: 'lossless',
    requiresDeferredOutputRelease: true,
    requiresIdempotentStart: true,
    runId: 'run-initial-stdin-gate',
    callId: 'call-initial-stdin-gate',
    stdinMode: 'open',
    initialStdin: 'private bootstrap\n',
  });

  assert.equal(started.ok, false);
  assert.equal(
    worker.starts.length,
    0,
    'no bootstrap crossed the old boundary',
  );
});

void test('a capable worker receives the exact redaction and lossless start contract', async (t) => {
  const worker = await makeScriptedWorker(t, {
    dropFirstInteractResponse: false,
    capabilities: {
      deferredOutputRelease: true,
      idempotentStartByInvocation: true,
      initialStdinOnStart: true,
      losslessStdio: true,
      prePersistenceOutputRedaction: true,
    },
  });
  const client = createCommandHostClient({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
  });
  t.after(async () => {
    await client.closeAll();
  });

  const started = await client.start({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("private-token")'],
    cwd: worker.stateRoot,
    env: process.env,
    stateRoot: worker.stateRoot,
    threadId: THREAD,
    owner: 'system',
    streamMode: 'lossless',
    requiresDeferredOutputRelease: true,
    requiresIdempotentStart: true,
    runId: 'run-redaction-wire',
    callId: 'call-redaction-wire',
    stdinMode: 'open',
    initialStdin: 'private bootstrap\n',
    outputRedaction: {
      exactMarkers: ['private-token'],
      replacement: '[redacted]',
    },
  });

  assert.equal(started.ok, true);
  assert.equal(worker.starts.length, 1);
  assert.equal(worker.starts[0]?.['streamMode'], 'lossless');
  assert.equal(worker.starts[0]?.['requiresDeferredOutputRelease'], true);
  assert.equal(worker.starts[0]?.['requiresIdempotentStart'], true);
  assert.equal(worker.starts[0]?.['initialStdin'], 'private bootstrap\n');
  assert.deepEqual(worker.starts[0]?.['outputRedaction'], {
    exactMarkers: ['private-token'],
    replacement: '[redacted]',
  });
});

void test('the worker link translates an aborted wait into one cancel request', async (t) => {
  const worker = await makeScriptedWorker(t, {
    dropFirstInteractResponse: false,
    holdInitialWait: true,
  });
  const client = createCommandHostClient({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
  });
  t.after(async () => {
    await client.closeAll();
  });

  const controller = new AbortController();
  const waiting = client.waitForInitialResult({
    stateRoot: worker.stateRoot,
    outputRef: 'command-output:system/scripted-wait',
    signal: controller.signal,
  });
  await worker.initialWaitObserved;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);

  controller.abort();
  const cancelled = await Promise.race([
    waiting,
    delay(1_000, undefined, { ref: false }).then(() => {
      throw new Error('aborted worker wait did not settle');
    }),
  ]);

  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) {
    assert.equal(cancelled.reasonCode, 'wait_aborted');
  }
  assert.equal(worker.cancelledRequestIds.length, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

void test('§4.7: a lost response for a write is resent once with the same operation', async (t) => {
  const worker = await makeScriptedWorker(t, {
    dropFirstInteractResponse: true,
  });
  const client = createCommandHostClient({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
  });
  t.after(async () => {
    await client.closeAll();
  });
  const controller = new AbortController();

  const answered = await client.interact({
    stateRoot: worker.stateRoot,
    threadId: THREAD,
    outputRef: 'ref-retry',
    chars: 'ping',
    yieldTimeMs: 200,
    signal: controller.signal,
  });

  assert.equal(answered.ok, true, 'the retry answers the original caller');
  assert.equal(worker.interactions.length, 2, 'exactly one resend');
  assert.equal(worker.connections, 2, 'the resend needed a new connection');
  const [first, second] = worker.interactions;
  assert.deepEqual(
    second?.['operation'],
    first?.['operation'],
    'the resend carries the operation of the request it repeats',
  );
  assert.deepEqual(second?.['chars'], 'ping');
  assert.equal(
    second?.['yieldTimeMs'],
    0,
    'the resend confirms the write; it does not buy the wait window again',
  );
  assert.ok(
    (first?.['operation'] as { seq: number } | undefined)?.seq !== undefined,
    'a write carries an operation identifier',
  );
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    0,
    'connection loss and retry both release their abort listeners',
  );
});

void test('§4.7: an observation that loses its connection is not resent', async (t) => {
  const worker = await makeScriptedWorker(t, {
    dropFirstInteractResponse: true,
  });
  const client = createCommandHostClient({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
  });
  t.after(async () => {
    await client.closeAll();
  });
  const controller = new AbortController();

  const answered = await client.interact({
    stateRoot: worker.stateRoot,
    threadId: THREAD,
    outputRef: 'ref-poll',
    yieldTimeMs: 0,
    signal: controller.signal,
  });

  assert.equal(answered.ok, false);
  if (!answered.ok) {
    assert.equal(answered.reasonCode, 'output_store_failed');
  }
  assert.equal(worker.interactions.length, 1, 'polling is the caller to redo');
  assert.equal(
    worker.interactions[0]?.['operation'],
    undefined,
    'an observation spends no operation number',
  );
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    0,
    'a closed observation link releases its abort listener',
  );
});
