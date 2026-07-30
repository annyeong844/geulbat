import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { buildHostCommandPaths } from '../daemon/host-command-output-store.js';
import { resolveCommandHostPaths } from './runtime-paths.js';
import { createCommandSessionHost } from './session-core.js';
import { startCommandHostServer } from './worker-server.js';
import {
  buildNotification,
  buildRequest,
  COMMAND_HOST_CAPABILITIES,
  COMMAND_HOST_METHODS,
  COMMAND_HOST_NOTIFICATIONS,
  COMMAND_HOST_PROTOCOL_VERSION,
  encodeFrame,
  FrameDecoder,
  initializeResultSchema,
  METHOD_NOT_FOUND_CODE,
  REQUEST_CANCELLED_CODE,
  type JsonRpcId,
} from './protocol.js';

const FINGERPRINT = 'f'.repeat(64);

function threadId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

class TestRpcClient {
  private socket!: net.Socket;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<
    JsonRpcId,
    (message: Record<string, unknown>) => void
  >();
  readonly notifications: Array<Record<string, unknown>> = [];
  readonly responses: Array<Record<string, unknown>> = [];
  firstError: unknown;
  private nextId = 1;
  closedByPeer = false;

  async connect(socketPath: string): Promise<void> {
    this.socket = await new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => {
        resolve(socket);
      });
      socket.once('error', reject);
    });
    this.socket.on('data', (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) {
        const message = frame.message as Record<string, unknown>;
        if (message['id'] !== undefined) {
          this.responses.push(message);
          const resolver = this.pending.get(message['id'] as JsonRpcId);
          if (resolver !== undefined) {
            this.pending.delete(message['id'] as JsonRpcId);
            this.firstError ??= message['error'];
            resolver(message);
          }
        } else {
          this.notifications.push(message);
        }
      }
    });
    this.socket.on('close', () => {
      this.closedByPeer = true;
    });
  }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.socket.write(encodeFrame(buildRequest(id, method, params)));
    });
  }

  /** 응답을 기다리지 않는 요청 — 취소 테스트용. id를 돌려준다. */
  fire(
    method: string,
    params?: unknown,
  ): {
    id: JsonRpcId;
    response: Promise<Record<string, unknown>>;
  } {
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<Record<string, unknown>>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.socket.write(encodeFrame(buildRequest(id, method, params)));
    return { id, response };
  }

  notify(method: string, params?: unknown): void {
    this.socket.write(encodeFrame(buildNotification(method, params)));
  }

  sendRequestWithId(id: JsonRpcId, method: string, params?: unknown): void {
    this.socket.write(encodeFrame(buildRequest(id, method, params)));
  }

  async initialize(
    fingerprint = FINGERPRINT,
  ): Promise<Record<string, unknown>> {
    return await this.request(COMMAND_HOST_METHODS.initialize, {
      protocolVersion: COMMAND_HOST_PROTOCOL_VERSION,
      stateRootFingerprint: fingerprint,
    });
  }

  diagnostics(): { answered: number; firstError: unknown } {
    return {
      answered: this.nextId - 1 - this.pending.size,
      firstError: this.firstError,
    };
  }

  /** 소비를 멈춘다 — 느린/멈춘 소비자를 흉내내 알림 폐기를 유발한다. */
  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

interface Harness {
  stateRoot: string;
  socketPath: string;
  core: ReturnType<typeof createCommandSessionHost>;
  server: Awaited<ReturnType<typeof startCommandHostServer>>;
  /** §6.3 종료 신호가 몇 번 울렸는지 — 워커 자동 종료 게이트의 관측점. */
  idleSignals: number[];
  close(): Promise<void>;
}

async function makeHarness(
  t: { after(fn: () => Promise<void> | void): void },
  config: {
    inlineMaxBytes?: number;
    tailRingBytes?: number;
    readoptionGraceMs?: number;
  } = {},
): Promise<Harness> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-chw-'));
  const socketPath = join(stateRoot, 'host.sock');
  const core = createCommandSessionHost({
    inlineMaxBytes: config.inlineMaxBytes ?? 1024,
    tailRingBytes: config.tailRingBytes ?? 4096,
  });
  const idleSignals: number[] = [];
  const server = await startCommandHostServer({
    core,
    socketPath,
    stateRoot,
    stateRootFingerprint: FINGERPRINT,
    ...(config.readoptionGraceMs === undefined
      ? {}
      : { readoptionGraceMs: config.readoptionGraceMs }),
    onIdle: () => {
      idleSignals.push(Date.now());
    },
  });
  const close = async () => {
    await server.close();
    await core.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  };
  t.after(close);
  return { stateRoot, socketPath, core, server, idleSignals, close };
}

function startParams(harness: Harness, thread: string, code: string) {
  return {
    executable: process.execPath,
    args: ['-e', code],
    cwd: harness.stateRoot,
    env: { PATH: process.env['PATH'] ?? '' },
    stateRoot: harness.stateRoot,
    threadId: thread,
    runId: 'run-w2',
    callId: 'call-w2',
    stdinMode: 'closed' as const,
  };
}

async function waitForResponseCount(
  client: TestRpcClient,
  id: JsonRpcId,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const responses = client.responses.filter(
      (response) => response['id'] === id,
    );
    if (responses.length >= count) {
      return responses;
    }
    await delay(10);
  }
  assert.fail(`timed out waiting for ${count} responses to request ${id}`);
}

void test('rpc roundtrip: initialize → start → waitInitial inline result', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  const init = await client.initialize();
  const initResult = init['result'] as Record<string, unknown>;
  assert.equal(initResult['selectedVersion'], COMMAND_HOST_PROTOCOL_VERSION);
  const effective = initResult['effectiveConfig'] as Record<string, unknown>;
  assert.equal(effective['inlineMaxBytes'], 1024);

  const started = await client.request(
    COMMAND_HOST_METHODS.start,
    startParams(harness, threadId(9101), "process.stdout.write('pong');"),
  );
  const startResult = started['result'] as Record<string, unknown>;
  assert.equal(startResult['ok'], true);
  const outputRef = startResult['outputRef'] as string;

  const waited = await client.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef,
  });
  const waitResult = waited['result'] as Record<string, unknown>;
  assert.equal(waitResult['ok'], true);
  const snapshot = (waitResult['value'] ?? waitResult) as Record<
    string,
    unknown
  >;
  const value = (waitResult['value'] as Record<string, unknown>) ?? snapshot;
  assert.equal(value['stdout'], 'pong');
  assert.equal(value['outputRef'], null);
  client.destroy();
});

void test('worker redacts split markers before returning either lossless stream', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  const initialized = await client.initialize();
  const capabilities = initializeResultSchema.parse(
    initialized['result'],
  ).capabilities;
  assert.deepEqual(capabilities, COMMAND_HOST_CAPABILITIES);

  const marker = 'worker-private-marker-split-across-writes';
  const replacement = '[redacted:worker]';
  const started = await client.request(COMMAND_HOST_METHODS.start, {
    ...startParams(
      harness,
      threadId(9102),
      [
        `const marker = ${JSON.stringify(marker)};`,
        'process.stdout.write(marker.slice(0, 13));',
        'setTimeout(() => {',
        '  process.stdout.write(marker.slice(13));',
        '  process.stderr.write(marker);',
        '}, 20);',
        'setTimeout(() => process.exit(0), 50);',
      ].join(''),
    ),
    owner: 'system',
    streamMode: 'lossless',
    outputRedaction: {
      exactMarkers: [marker],
      replacement,
    },
  });
  const outputRef = (started['result'] as { outputRef: string }).outputRef;
  const waited = await client.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef,
  });
  const value = (waited['result'] as { value: Record<string, unknown> }).value;
  assert.equal(value['stdout'], replacement);
  assert.equal(value['stderr'], replacement);
  assert.doesNotMatch(String(value['stdout']), new RegExp(marker, 'u'));
  assert.doesNotMatch(String(value['stderr']), new RegExp(marker, 'u'));
  client.destroy();
});

void test('fingerprint mismatch is rejected and disconnected', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  const init = await client.initialize('0'.repeat(64));
  assert.ok(init['error'] !== undefined);
  for (let attempt = 0; attempt < 100 && !client.closedByPeer; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(client.closedByPeer, true);
});

void test('malformed JSON tears down only that live connection', async (t) => {
  const harness = await makeHarness(t);
  const malformedClient = net.connect(harness.socketPath);
  t.after(() => {
    malformedClient.destroy();
  });
  await once(malformedClient, 'connect');
  const closed = once(malformedClient, 'close');
  const malformedFrame = Buffer.alloc(5);
  malformedFrame.writeUInt32BE(1, 0);
  malformedFrame[4] = '{'.charCodeAt(0);

  malformedClient.write(malformedFrame);
  await closed;

  assert.equal(harness.server.connectionCount(), 0);
  const healthyClient = new TestRpcClient();
  await healthyClient.connect(harness.socketPath);
  const initialized = await healthyClient.initialize();
  assert.ok(initialized['result'] !== undefined);
  healthyClient.destroy();
});

void test('startup fails closed when the accepted Unix endpoint cannot be chmodded', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Linux abstract Unix sockets provide the real post-listen failure');
    return;
  }

  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-chw-chmod-'));
  const socketPath = `\0geulbat-chw-chmod-${process.pid}-${Date.now()}`;
  const core = createCommandSessionHost({
    inlineMaxBytes: 1024,
    tailRingBytes: 4096,
  });
  t.after(async () => {
    await core.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    startCommandHostServer({
      core,
      socketPath,
      stateRoot,
      stateRootFingerprint: FINGERPRINT,
    }),
    { code: 'ERR_INVALID_ARG_VALUE' },
  );

  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(socketPath, () => {
      probe.removeListener('error', reject);
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
});

void test('start rejects a stateRoot outside the initialized worker authority', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();

  const started = await client.request(COMMAND_HOST_METHODS.start, {
    ...startParams(harness, threadId(9105), "process.stdout.write('wrong');"),
    stateRoot: join(harness.stateRoot, 'other-state-root'),
  });

  assert.equal((started['error'] as Record<string, unknown>)['code'], -32602);
  assert.deepEqual(
    (await client.request(COMMAND_HOST_METHODS.list))['result'],
    [],
  );
  client.destroy();
});

void test('interact rejects a stateRoot outside the initialized worker authority', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();
  const started = await client.request(
    COMMAND_HOST_METHODS.start,
    startParams(harness, threadId(9106), 'setInterval(() => {}, 1000);'),
  );
  const outputRef = (started['result'] as Record<string, unknown>)[
    'outputRef'
  ] as string;
  await client.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef,
    yieldTimeMs: 0,
  });

  const interacted = await client.request(COMMAND_HOST_METHODS.interact, {
    stateRoot: join(harness.stateRoot, 'other-state-root'),
    threadId: threadId(9106),
    outputRef,
    yieldTimeMs: 0,
  });

  assert.equal(
    (interacted['error'] as Record<string, unknown>)['code'],
    -32602,
  );
  await client.request(COMMAND_HOST_METHODS.interact, {
    stateRoot: harness.stateRoot,
    threadId: threadId(9106),
    outputRef,
    terminate: true,
    yieldTimeMs: 2_000,
  });
  client.destroy();
});

void test('a duplicate outstanding request ID is rejected without replacing cancellation ownership', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();
  const started = await client.request(
    COMMAND_HOST_METHODS.start,
    startParams(harness, threadId(9107), 'setInterval(() => {}, 1000);'),
  );
  const outputRef = (started['result'] as Record<string, unknown>)[
    'outputRef'
  ] as string;
  const duplicateId = 'duplicate-request';

  client.sendRequestWithId(duplicateId, COMMAND_HOST_METHODS.waitInitial, {
    outputRef,
  });
  client.sendRequestWithId(duplicateId, COMMAND_HOST_METHODS.list);

  const rejected = await waitForResponseCount(client, duplicateId, 1);
  assert.equal(
    (rejected[0]?.['error'] as Record<string, unknown>)['code'],
    -32600,
  );

  client.notify(COMMAND_HOST_NOTIFICATIONS.cancelRequest, { id: duplicateId });
  const settled = await waitForResponseCount(client, duplicateId, 2);
  assert.equal(
    (settled[1]?.['error'] as Record<string, unknown>)['code'],
    REQUEST_CANCELLED_CODE,
  );
  assert.deepEqual(
    (await client.request(COMMAND_HOST_METHODS.list))['result'],
    [],
  );
  client.destroy();
});

void test('requests before initialize are refused', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  const listed = await client.request(COMMAND_HOST_METHODS.list);
  assert.ok(listed['error'] !== undefined);
  client.destroy();
});

void test('unknown methods return -32601 and keep the initialized connection alive', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();

  const unknown = await client.request('test/unknown-method');
  const error = unknown['error'] as Record<string, unknown>;
  assert.equal(error['code'], METHOD_NOT_FOUND_CODE);
  assert.equal(error['message'], 'unknown method: test/unknown-method');
  assert.deepEqual(
    (await client.request(COMMAND_HOST_METHODS.list))['result'],
    [],
  );
  assert.equal(client.closedByPeer, false);
  client.destroy();
});

void test('$/cancelRequest aborts a waiting request with -32800 and discards the unclaimed session', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();
  const started = await client.request(
    COMMAND_HOST_METHODS.start,
    startParams(harness, threadId(9102), 'setInterval(() => {}, 1000);'),
  );
  const outputRef = (started['result'] as Record<string, unknown>)[
    'outputRef'
  ] as string;

  const waiting = client.fire(COMMAND_HOST_METHODS.waitInitial, { outputRef });
  client.notify(COMMAND_HOST_NOTIFICATIONS.cancelRequest, { id: waiting.id });
  const cancelled = await waiting.response;
  const error = cancelled['error'] as Record<string, unknown>;
  assert.equal(error['code'], -32800);

  // authoritative 취소 → 세션 discard (§4.2.1).
  const listed = await client.request(COMMAND_HOST_METHODS.list);
  assert.deepEqual(listed['result'], []);
  client.destroy();
});

void test('survival: a claimed session outlives its connection and serves a new one', async (t) => {
  const harness = await makeHarness(t);
  const clientA = new TestRpcClient();
  await clientA.connect(harness.socketPath);
  await clientA.initialize();
  const started = await clientA.request(
    COMMAND_HOST_METHODS.start,
    startParams(harness, threadId(9103), 'setInterval(() => {}, 1000);'),
  );
  const outputRef = (started['result'] as Record<string, unknown>)[
    'outputRef'
  ] as string;
  const claimed = await clientA.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef,
    yieldTimeMs: 0,
  });
  assert.equal((claimed['result'] as Record<string, unknown>)['ok'], true);
  clientA.destroy();

  const clientB = new TestRpcClient();
  await clientB.connect(harness.socketPath);
  await clientB.initialize();
  const polled = await clientB.request(COMMAND_HOST_METHODS.interact, {
    stateRoot: harness.stateRoot,
    threadId: threadId(9103),
    outputRef,
    yieldTimeMs: 0,
  });
  const interactResult = polled['result'] as Record<string, unknown>;
  assert.equal(interactResult['ok'], true);
  const snapshot = (interactResult['value'] as Record<string, unknown>)[
    'snapshot'
  ] as Record<string, unknown>;
  assert.equal(snapshot['status'], 'running');

  const terminated = await clientB.request(COMMAND_HOST_METHODS.interact, {
    stateRoot: harness.stateRoot,
    threadId: threadId(9103),
    outputRef,
    terminate: true,
    yieldTimeMs: 2_000,
  });
  assert.equal((terminated['result'] as Record<string, unknown>)['ok'], true);
  clientB.destroy();
});

void test('closing a connection discards its unclaimed sessions', async (t) => {
  const harness = await makeHarness(t);
  const clientA = new TestRpcClient();
  await clientA.connect(harness.socketPath);
  await clientA.initialize();
  const started = await clientA.request(
    COMMAND_HOST_METHODS.start,
    startParams(harness, threadId(9104), 'setInterval(() => {}, 1000);'),
  );
  assert.equal((started['result'] as Record<string, unknown>)['ok'], true);
  clientA.destroy();

  const clientB = new TestRpcClient();
  await clientB.connect(harness.socketPath);
  await clientB.initialize();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const listed = await clientB.request(COMMAND_HOST_METHODS.list);
    if ((listed['result'] as unknown[]).length === 0) {
      clientB.destroy();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('unclaimed session was not discarded after owner disconnect');
});

void test('subscribe streams output notifications with byte offsets over the wire', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();
  const started = await client.request(
    COMMAND_HOST_METHODS.start,
    startParams(
      harness,
      threadId(9105),
      "setTimeout(() => process.stdout.write('streamed'), 80); setInterval(() => {}, 1000);",
    ),
  );
  const outputRef = (started['result'] as Record<string, unknown>)[
    'outputRef'
  ] as string;
  await client.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef,
    yieldTimeMs: 0,
  });
  const subscribed = await client.request(COMMAND_HOST_METHODS.subscribe, {
    outputRef,
  });
  assert.equal((subscribed['result'] as Record<string, unknown>)['ok'], true);

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const output = client.notifications.find(
      (notification) =>
        notification['method'] === COMMAND_HOST_NOTIFICATIONS.output,
    );
    if (output !== undefined) {
      const params = output['params'] as Record<string, unknown>;
      assert.equal(params['chunk'], 'streamed');
      assert.equal(params['startOffset'], 0);
      assert.equal(params['endOffset'], 'streamed'.length);
      await client.request(COMMAND_HOST_METHODS.interact, {
        stateRoot: harness.stateRoot,
        threadId: threadId(9105),
        outputRef,
        terminate: true,
        yieldTimeMs: 2_000,
      });
      client.destroy();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('no output notification arrived');
});

void test('T21: pre-initialize connections are bounded by oldest-eviction without timers', async (t) => {
  const harness = await makeHarness(t);
  const idle: TestRpcClient[] = [];
  for (let index = 0; index < 4; index += 1) {
    const client = new TestRpcClient();
    await client.connect(harness.socketPath);
    idle.push(client);
  }
  // 5번째 pre-init 접속은 가장 오래된 pre-init을 퇴거시킨다.
  const fifth = new TestRpcClient();
  await fifth.connect(harness.socketPath);
  const oldest = idle[0];
  assert.ok(oldest !== undefined);
  for (let attempt = 0; attempt < 200 && !oldest.closedByPeer; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(oldest.closedByPeer, true);

  // 새 연결은 정상적으로 initialize까지 진행된다.
  const init = await fifth.initialize();
  assert.ok(init['result'] !== undefined);
  fifth.destroy();
  for (const client of idle.slice(1)) {
    client.destroy();
  }
});

void test('T13: the idle signal never precedes terminal durability', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();
  const thread = threadId(31);
  const releasePath = join(harness.stateRoot, 't13-release');
  const releaseScript =
    `const { existsSync } = require('node:fs');` +
    `const releasePath = ${JSON.stringify(releasePath)};` +
    `const poll = setInterval(() => {` +
    `if (existsSync(releasePath)) clearInterval(poll);` +
    `}, 10);`;

  const started = (
    await client.request(
      COMMAND_HOST_METHODS.start,
      startParams(harness, thread, releaseScript),
    )
  )['result'] as { ok: true; outputRef: string };
  // claim해 두면 연결이 끊겨도 세션이 살아남는다 (§8.2).
  await client.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });

  assert.equal(harness.core.isQuiescent(), false, 'a running session is work');
  assert.equal(harness.idleSignals.length, 0);

  // 연결 0 · 이후 자식 종료 — 종료 신호는 내구화가 끝난 뒤에만 울려야 한다.
  client.destroy();
  await writeFile(releasePath, 'release', 'utf8');
  const paths = buildHostCommandPaths({
    stateRoot: harness.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
  });
  while (harness.idleSignals.length === 0) {
    await delay(10);
  }
  const metadata: unknown = JSON.parse(await readFile(paths.metadata, 'utf8'));
  assert.notEqual(
    (metadata as { status: string }).status,
    'running',
    'terminal metadata must already be durable when the worker may exit',
  );
  assert.equal(harness.core.isQuiescent(), true);
});

void test('shutdown reports Busy while active work exists (§6.3)', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();
  const thread = threadId(32);

  const started = (
    await client.request(COMMAND_HOST_METHODS.start, {
      ...startParams(harness, thread, 'process.stdin.resume();'),
      stdinMode: 'open',
    })
  )['result'] as { ok: true; outputRef: string };
  await client.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });

  const busy = await client.request(COMMAND_HOST_METHODS.shutdown, {});
  assert.equal(
    (busy['error'] as { message: string } | undefined)?.message,
    'Busy: active work exists',
  );

  let unsubscribeSettled = (): void => undefined;
  const settled = new Promise<void>((resolve) => {
    unsubscribeSettled = harness.core.onSettled(resolve);
  });
  t.after(unsubscribeSettled);
  const closedStdin = await client.request(COMMAND_HOST_METHODS.interact, {
    stateRoot: harness.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    closeStdin: true,
  });
  assert.equal(
    (closedStdin['result'] as { ok: boolean } | undefined)?.ok,
    true,
  );
  await settled;
  unsubscribeSettled();

  const terminal = await client.request(COMMAND_HOST_METHODS.interact, {
    stateRoot: harness.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(
    (
      terminal['result'] as {
        ok: true;
        value: { snapshot: { status: string } };
      }
    ).value.snapshot.status,
    'exit',
  );
  const accepted = await client.request(COMMAND_HOST_METHODS.shutdown, {});
  assert.deepEqual(accepted['result'], { ok: true });
});

void test('T21b: pre-initialize connections do not hold the idle gate', async (t) => {
  const harness = await makeHarness(t);
  const lurker = new TestRpcClient();
  await lurker.connect(harness.socketPath);
  t.after(() => {
    lurker.destroy();
  });

  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();
  const started = (
    await client.request(
      COMMAND_HOST_METHODS.start,
      startParams(harness, threadId(33), 'process.stdout.write("x");'),
    )
  )['result'] as { ok: true; outputRef: string };
  await client.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef: started.outputRef,
  });
  client.destroy();

  // §6.3 — 미초기화 연결은 세션도 작업도 없으므로 계상에서 제외된다.
  while (harness.idleSignals.length === 0) {
    await delay(10);
  }
  assert.ok(harness.server.connectionCount() >= 1, 'the lurker is still there');
  assert.equal(harness.server.initializedConnectionCount(), 0);
});

void test('T5/T18: a newer daemon negotiates against this worker version', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  const thread = threadId(34);

  const initialized = await client.request(COMMAND_HOST_METHODS.initialize, {
    protocolVersion: '2999-01-01',
    stateRootFingerprint: FINGERPRINT,
  });
  const result = initialized['result'] as {
    selectedVersion: string;
    supportedVersions: string[];
  };
  assert.equal(result.selectedVersion, COMMAND_HOST_PROTOCOL_VERSION);
  assert.ok(result.supportedVersions.includes(COMMAND_HOST_PROTOCOL_VERSION));

  // 협상 뒤에도 기존 세션 흐름(start→claim→interact)이 그대로 산다.
  const started = (
    await client.request(
      COMMAND_HOST_METHODS.start,
      startParams(
        harness,
        thread,
        'setTimeout(() => process.stdout.write("skew"), 40);',
      ),
    )
  )['result'] as { ok: true; outputRef: string };
  await client.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });

  for (;;) {
    const interacted = await client.request(COMMAND_HOST_METHODS.interact, {
      stateRoot: harness.stateRoot,
      threadId: thread,
      outputRef: started.outputRef,
      yieldTimeMs: 20,
      page: { stream: 'stdout', offsetBytes: 0, limitBytes: 64 },
    });
    const value = (
      interacted['result'] as {
        ok: true;
        value: {
          snapshot: { status: string };
          page: { content: string };
        };
      }
    ).value;
    if (value.snapshot.status !== 'running') {
      assert.equal(value.page.content, 'skew');
      break;
    }
  }
});

void test('§7.5: the worker-global in-flight request budget refuses the overflow', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();
  const thread = threadId(35);

  // 오래 매달리는 요청으로 예산을 붙들어 둔다 — waitInitial은 자식이 끝날
  // 때까지 응답하지 않는 long-poll이다.
  const running = (
    await client.request(
      COMMAND_HOST_METHODS.start,
      startParams(harness, thread, 'setInterval(() => {}, 1000);'),
    )
  )['result'] as { ok: true; outputRef: string };

  // 스키마가 무시하는 여분 필드로 프레임만 크게 만든다. 예산이 세는 것은
  // 해석된 파라미터가 아니라 워커가 실제로 붙들고 있는 wire 바이트다.
  const padding = 'p'.repeat(3 * 1024 * 1024);
  const inFlight = Array.from({ length: 8 }, () =>
    client.fire(COMMAND_HOST_METHODS.waitInitial, {
      outputRef: running.outputRef,
      padding,
    }),
  );

  // 예산 안에 든 요청은 자식이 끝날 때까지 응답하지 않는 long-poll이므로,
  // **가장 먼저 돌아오는 응답이 곧 거절**이다. 시간 창으로 기다리면 부하에서
  // 흔들리므로 사건으로 기다린다.
  const refusal = await Promise.race([
    ...inFlight.map(async (pending) => {
      const response = await pending.response;
      return (response['error'] as { message: string } | undefined)?.message;
    }),
    delay(10_000).then(() => 'timed out waiting for the budget refusal'),
  ]);
  assert.equal(refusal, 'worker in-flight request budget is exhausted');

  // 예산을 비우면 다시 받아준다 — 상한은 거절이지 연결 종료가 아니다.
  await client.request(COMMAND_HOST_METHODS.interact, {
    stateRoot: harness.stateRoot,
    threadId: thread,
    outputRef: running.outputRef,
    terminate: true,
    yieldTimeMs: 0,
  });
  for (const pending of inFlight) {
    await pending.response;
  }
  const accepted = await client.request(COMMAND_HOST_METHODS.list, {});
  assert.ok(Array.isArray(accepted['result']));
  client.destroy();
});

void test('each connection sees its own subscription id for a shared session', async (t) => {
  const harness = await makeHarness(t);
  const owner = new TestRpcClient();
  await owner.connect(harness.socketPath);
  await owner.initialize();
  const observer = new TestRpcClient();
  await observer.connect(harness.socketPath);
  await observer.initialize();
  t.after(() => {
    owner.destroy();
    observer.destroy();
  });
  const thread = threadId(36);

  const started = (
    await owner.request(
      COMMAND_HOST_METHODS.start,
      startParams(
        harness,
        thread,
        'setTimeout(() => process.stdout.write("shared"), 60);',
      ),
    )
  )['result'] as { ok: true; outputRef: string };

  const first = (
    await owner.request(COMMAND_HOST_METHODS.subscribe, {
      outputRef: started.outputRef,
    })
  )['result'] as { subscriptionId: string };
  const second = (
    await observer.request(COMMAND_HOST_METHODS.subscribe, {
      outputRef: started.outputRef,
    })
  )['result'] as { subscriptionId: string };
  assert.notEqual(first.subscriptionId, second.subscriptionId);

  await owner.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef: started.outputRef,
  });
  while (
    owner.notifications.length === 0 ||
    observer.notifications.length === 0
  ) {
    await delay(10);
  }

  // 두 번째 구독이 첫 번째의 id를 덮어써서는 안 된다 — 각 연결은 자기가
  // 받은 id로만 알림을 받는다.
  for (const notification of owner.notifications) {
    const params = notification['params'] as { subscriptionId: string };
    assert.equal(params.subscriptionId, first.subscriptionId);
  }
  for (const notification of observer.notifications) {
    const params = notification['params'] as { subscriptionId: string };
    assert.equal(params.subscriptionId, second.subscriptionId);
  }
});

// T15 — 알림이 폐기된 뒤에도 byte offset 좌표계로 정확히 복구된다.
// 스트림 교차·다중바이트·폐기를 한 시나리오에 겹쳐 놓는다.
const T15_BLOCK = 'ㅁ'.repeat(500);
const T15_LINES = 2_000;
const T15_BATCH = 50;

function t15Expected(): { stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  for (let i = 0; i < T15_LINES; i += 1) {
    const line = `${i}:${T15_BLOCK}\n`;
    if (i % 10 === 9) {
      stderr += line;
    } else {
      stdout += line;
    }
  }
  return { stdout, stderr };
}

// 소비자가 멈춰 있는 창을 걸치도록 배치마다 쉬어 간다.
const T15_CHILD = `const BLOCK = ${JSON.stringify(T15_BLOCK)};
let i = 0;
function batch() {
  for (let n = 0; n < ${T15_BATCH} && i < ${T15_LINES}; n += 1, i += 1) {
    const line = i + ':' + BLOCK + '\\n';
    if (i % 10 === 9) { process.stderr.write(line); } else { process.stdout.write(line); }
  }
  if (i < ${T15_LINES}) { setTimeout(batch, 8); }
}
batch();`;

void test('T15: dropped notifications still resync exactly by byte offset', async (t) => {
  const harness = await makeHarness(t, {
    inlineMaxBytes: 16 * 1024,
    tailRingBytes: 256 * 1024,
  });
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();
  t.after(() => {
    client.destroy();
  });
  const thread = threadId(40);

  const started = (
    await client.request(
      COMMAND_HOST_METHODS.start,
      startParams(harness, thread, T15_CHILD),
    )
  )['result'] as { ok: true; outputRef: string };
  const subscribed = (
    await client.request(COMMAND_HOST_METHODS.subscribe, {
      outputRef: started.outputRef,
    })
  )['result'] as { subscriptionId: string };
  await client.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });

  // 여기서부터 소비를 멈춘다 — 자식은 계속 쏟아내고, 워커의 알림 큐는
  // §7.5 상한에서 델타를 버려야 한다(자식을 멈추거나 stdout을 pause해서는
  // 안 된다). 멈춘 동안에는 응답도 못 읽으므로 아무 것도 await하지 않는다.
  client.pause();
  await delay(600);
  client.resume();

  for (;;) {
    const observed = (
      await client.request(COMMAND_HOST_METHODS.interact, {
        stateRoot: harness.stateRoot,
        threadId: thread,
        outputRef: started.outputRef,
        yieldTimeMs: 30,
      })
    )['result'] as { ok: true; value: { snapshot: { status: string } } };
    if (observed.value.snapshot.status !== 'running') {
      break;
    }
  }

  const resyncs = client.notifications.filter(
    (message) =>
      message['method'] === COMMAND_HOST_NOTIFICATIONS.resyncRequired,
  );
  assert.ok(
    resyncs.length > 0,
    'a stalled consumer must be told that deltas were dropped',
  );
  assert.equal(
    (resyncs[0]?.['params'] as { subscriptionId: string }).subscriptionId,
    subscribed.subscriptionId,
  );

  // 폐기 이후의 진실은 페이지 조회다 — 두 스트림 각각을 창의 시작부터 끝까지
  // 이어 붙여 원본의 꼬리와 바이트로 대조한다(무중복·무누락).
  const expected = t15Expected();
  for (const stream of ['stdout', 'stderr'] as const) {
    const recovered = await drainStream(
      client,
      harness,
      thread,
      started.outputRef,
      stream,
    );
    const source = Buffer.from(expected[stream], 'utf8');
    const tail = source.subarray(source.length - recovered.byteLength);
    assert.equal(
      recovered.content,
      tail.toString('utf8'),
      `${stream} must recover its exact tail with no gap or duplication`,
    );
    assert.ok(
      recovered.byteLength > 64 * 1024,
      `${stream} recovery should span a meaningful window`,
    );
  }
});

async function drainStream(
  client: TestRpcClient,
  harness: Harness,
  thread: string,
  outputRef: string,
  stream: 'stdout' | 'stderr',
): Promise<{ content: string; byteLength: number }> {
  let offset = 0;
  let content = '';
  let start = -1;
  for (;;) {
    const page = (
      await client.request(COMMAND_HOST_METHODS.interact, {
        stateRoot: harness.stateRoot,
        threadId: thread,
        outputRef,
        yieldTimeMs: 0,
        page: { stream, offsetBytes: offset, limitBytes: 8 * 1024 },
      })
    )['result'] as {
      ok: true;
      value: {
        page: {
          contentStartOffset: number;
          endOffsetBytes: number;
          content: string;
          hasMore: boolean;
        };
      };
    };
    if (start < 0) {
      start = page.value.page.contentStartOffset;
    }
    content += page.value.page.content;
    offset = page.value.page.endOffsetBytes;
    if (!page.value.page.hasMore) {
      return { content, byteLength: offset - start };
    }
  }
}

void test('수용기준 6: a waiting interact is cancellable with -32800', async (t) => {
  const harness = await makeHarness(t);
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();
  t.after(() => {
    client.destroy();
  });
  const thread = threadId(41);

  const started = (
    await client.request(
      COMMAND_HOST_METHODS.start,
      startParams(harness, thread, 'setInterval(() => {}, 1000);'),
    )
  )['result'] as { ok: true; outputRef: string };
  const claimed = (
    await client.request(COMMAND_HOST_METHODS.waitInitial, {
      outputRef: started.outputRef,
      yieldTimeMs: 0,
    })
  )['result'] as { ok: true; value: { revision: number } };

  // 변화가 올 때까지 매달리는 interact — waitInitial만이 아니라 모든 대기
  // RPC가 취소 가능해야 한다.
  const waiting = client.fire(COMMAND_HOST_METHODS.interact, {
    stateRoot: harness.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    afterRevision: claimed.value.revision,
    yieldTimeMs: 60_000,
  });
  await delay(50);
  client.notify(COMMAND_HOST_NOTIFICATIONS.cancelRequest, { id: waiting.id });
  const cancelled = await waiting.response;
  assert.equal(
    (cancelled['error'] as { code: number } | undefined)?.code,
    REQUEST_CANCELLED_CODE,
  );

  // 취소는 이 요청만 끝낸다 — 세션은 그대로 살아 있어야 한다 (§4.2.1).
  const alive = (
    await client.request(COMMAND_HOST_METHODS.interact, {
      stateRoot: harness.stateRoot,
      threadId: thread,
      outputRef: started.outputRef,
      yieldTimeMs: 0,
    })
  )['result'] as { ok: true; value: { snapshot: { status: string } } };
  assert.equal(alive.value.snapshot.status, 'running');
});

void test('T14: a client that never reads cannot wedge the worker for anyone else', async (t) => {
  const harness = await makeHarness(t, {
    inlineMaxBytes: 1024 * 1024,
    tailRingBytes: 4 * 1024 * 1024,
  });
  const stalled = new TestRpcClient();
  await stalled.connect(harness.socketPath);
  await stalled.initialize();
  t.after(() => {
    stalled.destroy();
  });
  const thread = threadId(42);

  const started = (
    await stalled.request(
      COMMAND_HOST_METHODS.start,
      startParams(
        harness,
        thread,
        `const b='y'.repeat(65536);for(let i=0;i<64;i+=1){process.stdout.write(b);}`,
      ),
    )
  )['result'] as { ok: true; outputRef: string };
  await stalled.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef: started.outputRef,
  });

  // 읽기를 멈춘 채 거대한 페이지 응답을 계속 요구한다. §7.5의 응답 큐
  // 상한(soft pause / hard 종료)이 여기서 일한다.
  //
  // 상한이 **어느 단계에서** 걸리는지는 단언하지 않는다: 커널과 Node가
  // 얼마나 흡수하느냐에 달려 환경마다 다르고, 내부 전이를 못 박으면
  // 깨지기 쉬운 테스트가 된다. 단언할 것은 그 상한이 존재하는 이유다 —
  // 읽지 않는 소비자 하나가 워커를 남들 몫까지 붙들지 못한다.
  stalled.pause();
  for (let request = 0; request < 24; request += 1) {
    stalled.fire(COMMAND_HOST_METHODS.interact, {
      stateRoot: harness.stateRoot,
      threadId: thread,
      outputRef: started.outputRef,
      yieldTimeMs: 0,
      page: { stream: 'stdout', offsetBytes: 0, limitBytes: 1024 * 1024 },
    });
  }

  const healthy = new TestRpcClient();
  await healthy.connect(harness.socketPath);
  await healthy.initialize();
  t.after(() => {
    healthy.destroy();
  });
  const startedAt = Date.now();
  const served = (
    await healthy.request(COMMAND_HOST_METHODS.interact, {
      stateRoot: harness.stateRoot,
      threadId: thread,
      outputRef: started.outputRef,
      yieldTimeMs: 0,
      page: { stream: 'stdout', offsetBytes: 0, limitBytes: 1024 },
    })
  )['result'] as {
    ok: true;
    value: {
      snapshot: { stdoutBytes: number; status: string };
      page: { content: string };
    };
  };
  const elapsed = Date.now() - startedAt;

  assert.equal(served.value.snapshot.stdoutBytes, 64 * 65536);
  assert.equal(served.value.page.content, 'y'.repeat(1024));
  assert.ok(
    elapsed < 5_000,
    `a healthy connection must keep being served, took ${elapsed}ms`,
  );

  // 그리고 워커는 여전히 새 연결을 받는다.
  const late = new TestRpcClient();
  await late.connect(harness.socketPath);
  t.after(() => {
    late.destroy();
  });
  const initialized = await late.initialize();
  assert.ok(initialized['result'] !== undefined);
});

void test('T16: the socket and its runtime directory are owner-only', async (t) => {
  const harness = await makeHarness(t);
  // §6.4의 실제 방어선은 파일시스템 권한이다 — Node에는 SO_PEERCRED를
  // 읽을 API가 없고, 0700 런타임 디렉터리 + 0600 소켓이면 다른 uid는
  // 애초에 connect(2)에 도달하지 못한다.
  const socketStats = await stat(harness.socketPath);
  assert.equal(socketStats.mode & 0o777, 0o600);
  const uid = process.getuid?.();
  if (uid !== undefined) {
    assert.equal(socketStats.uid, uid);
  }

  const runtime = await resolveCommandHostPaths(harness.stateRoot);
  const runtimeStats = await stat(runtime.runtimeDir);
  assert.equal(runtimeStats.mode & 0o777, 0o700);
  if (uid !== undefined) {
    assert.equal(runtimeStats.uid, uid);
  }
});

void test('§4.7: an operation resent on a new connection is applied once', async (t) => {
  const harness = await makeHarness(t);
  const thread = threadId(9401);
  const first = new TestRpcClient();
  await first.connect(harness.socketPath);
  await first.initialize();
  const started = await first.request(COMMAND_HOST_METHODS.start, {
    ...startParams(
      harness,
      thread,
      'process.stdin.on("data", (d) => process.stdout.write("got:" + d)); process.stdin.on("end", () => process.exit(0));',
    ),
    stdinMode: 'open',
  });
  const outputRef = (started['result'] as Record<string, unknown>)[
    'outputRef'
  ] as string;
  // 세션을 claim해 둔다 — unclaimed 세션은 소유 연결이 끊길 때 정리된다(§7.4).
  await first.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef,
    yieldTimeMs: 0,
  });

  const interact = {
    stateRoot: harness.stateRoot,
    threadId: thread,
    outputRef,
    chars: 'ping',
    operation: { clientId: 'facade-a', seq: 1 },
    yieldTimeMs: 200,
  };
  const answered = await first.request(COMMAND_HOST_METHODS.interact, interact);
  assert.equal((answered['result'] as Record<string, unknown>)['ok'], true);
  // 응답은 돌아왔지만 파사드가 그것을 보기 전에 연결이 죽은 상황이다.
  first.destroy();

  const second = new TestRpcClient();
  await second.connect(harness.socketPath);
  t.after(() => {
    second.destroy();
  });
  await second.initialize();
  const resent = await second.request(COMMAND_HOST_METHODS.interact, interact);
  assert.equal(
    (resent['result'] as Record<string, unknown>)['ok'],
    true,
    'the retry is answered, not rejected',
  );

  await second.request(COMMAND_HOST_METHODS.interact, {
    stateRoot: harness.stateRoot,
    threadId: thread,
    outputRef,
    closeStdin: true,
    yieldTimeMs: 0,
  });
  for (;;) {
    const polled = await second.request(COMMAND_HOST_METHODS.interact, {
      stateRoot: harness.stateRoot,
      threadId: thread,
      outputRef,
      yieldTimeMs: 50,
      page: { stream: 'stdout', offsetBytes: 0, limitBytes: 128 },
    });
    const value = (polled['result'] as Record<string, unknown>)[
      'value'
    ] as Record<string, unknown>;
    const snapshot = value['snapshot'] as Record<string, unknown>;
    if (snapshot['status'] !== 'running') {
      const page = value['page'] as Record<string, unknown> | null;
      assert.equal(
        page?.['content'],
        'got:ping',
        'the child saw the write once, across two connections',
      );
      return;
    }
  }
});

void test('P7.6: touching a system session re-pins it beyond the re-adoption window', async (t) => {
  const harness = await makeHarness(t, { readoptionGraceMs: 50 });
  const first = new TestRpcClient();
  await first.connect(harness.socketPath);
  await first.initialize();
  const started = await first.request(COMMAND_HOST_METHODS.start, {
    ...startParams(harness, threadId(9501), 'setInterval(() => {}, 1000);'),
    owner: 'system',
    // 프로토콜 스트림 모드도 RPC를 건너야 한다 — 통과 경로를 함께 잠근다.
    streamMode: 'protocol',
  });
  const outputRef = (started['result'] as Record<string, unknown>)[
    'outputRef'
  ] as string;
  await first.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef,
    yieldTimeMs: 0,
  });

  // 데몬만 죽는다 — 창이 열린다.
  first.destroy();
  const second = new TestRpcClient();
  await second.connect(harness.socketPath);
  t.after(() => {
    second.destroy();
  });
  await second.initialize();

  const observed = await second.request(COMMAND_HOST_METHODS.interact, {
    stateRoot: harness.stateRoot,
    threadId: threadId(9501),
    owner: 'system',
    outputRef,
    yieldTimeMs: 0,
  });
  const value = (observed['result'] as Record<string, unknown>)[
    'value'
  ] as Record<string, unknown>;
  assert.equal(
    (value['snapshot'] as Record<string, unknown>)['status'],
    'running',
    'the server is still there for the daemon that came back',
  );

  await delay(150);
  assert.equal(
    harness.core
      .listSessions()
      .some((session) => session.running && session.outputRef === outputRef),
    true,
    'the replacement daemon renewed the session pin beyond the old connection window',
  );

  await second.request(COMMAND_HOST_METHODS.interact, {
    stateRoot: harness.stateRoot,
    threadId: threadId(9501),
    owner: 'system',
    outputRef,
    terminate: true,
    yieldTimeMs: 0,
  });
});

void test('P7.6: a system session is reclaimed when nobody comes back', async (t) => {
  // 창을 짧게 준다 — 재는 것은 "창이 지나면 회수한다"이지 창의 길이가 아니다.
  const harness = await makeHarness(t, { readoptionGraceMs: 50 });
  const client = new TestRpcClient();
  await client.connect(harness.socketPath);
  await client.initialize();
  const started = await client.request(COMMAND_HOST_METHODS.start, {
    ...startParams(harness, threadId(9502), 'setInterval(() => {}, 1000);'),
    owner: 'system',
  });
  const outputRef = (started['result'] as Record<string, unknown>)[
    'outputRef'
  ] as string;
  await client.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(
    harness.core.listSessions().filter((session) => session.running).length,
    1,
  );

  // 아무도 돌아오지 않는다.
  client.destroy();
  for (
    let attempt = 0;
    attempt < 100 &&
    harness.core.listSessions().some((session) => session.running);
    attempt += 1
  ) {
    await delay(50);
  }

  assert.deepEqual(
    harness.core
      .listSessions()
      .filter((session) => session.running)
      .map((session) => session.outputRef),
    [],
    'an unclaimed system session does not outlive the window',
  );
});

void test('P7.6: coming back without re-pinning does not save the session', async (t) => {
  // 창을 연결 수로 세던 시절의 누수: 데몬이 돌아오기만 하면 타이머가
  // 취소되어, 옛 세션을 다시 고정하지 않아도 그 세션이 영원히 남았다.
  // 재입양 경로가 없는 지금은 "돌아왔지만 고정은 안 한" 것이 정상 경로다.
  const harness = await makeHarness(t, { readoptionGraceMs: 50 });
  const first = new TestRpcClient();
  await first.connect(harness.socketPath);
  await first.initialize();
  const started = await first.request(COMMAND_HOST_METHODS.start, {
    ...startParams(harness, threadId(9503), 'setInterval(() => {}, 1000);'),
    owner: 'system',
  });
  const outputRef = (started['result'] as Record<string, unknown>)[
    'outputRef'
  ] as string;
  await first.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef,
    yieldTimeMs: 0,
  });

  // 데몬만 죽고 새 데몬이 돌아온다 — 그러나 옛 세션에 다시 붙지는 않는다.
  first.destroy();
  const second = new TestRpcClient();
  await second.connect(harness.socketPath);
  t.after(() => {
    second.destroy();
  });
  await second.initialize();

  for (
    let attempt = 0;
    attempt < 100 &&
    harness.core.listSessions().some((session) => session.running);
    attempt += 1
  ) {
    await delay(50);
  }
  assert.deepEqual(
    harness.core
      .listSessions()
      .filter((session) => session.running)
      .map((session) => session.outputRef),
    [],
    'a daemon does not pin an old session by merely existing',
  );
});

void test('P7.6: a reclaim window takes only the sessions it opened for', async (t) => {
  // 창을 세션 단위로 세는 이유. 옛 연결이 남긴 파도가 만료될 때, 그 사이에
  // 새 데몬이 세운 세션까지 쓸어가면 회수가 곧 새 누수가 된다.
  const harness = await makeHarness(t, { readoptionGraceMs: 200 });
  const first = new TestRpcClient();
  await first.connect(harness.socketPath);
  await first.initialize();
  const abandoned = await first.request(COMMAND_HOST_METHODS.start, {
    ...startParams(harness, threadId(9504), 'setInterval(() => {}, 1000);'),
    owner: 'system',
  });
  const abandonedRef = (abandoned['result'] as Record<string, unknown>)[
    'outputRef'
  ] as string;
  await first.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef: abandonedRef,
    yieldTimeMs: 0,
  });

  first.destroy();
  const second = new TestRpcClient();
  await second.connect(harness.socketPath);
  t.after(() => {
    second.destroy();
  });
  await second.initialize();
  const fresh = await second.request(COMMAND_HOST_METHODS.start, {
    ...startParams(harness, threadId(9505), 'setInterval(() => {}, 1000);'),
    owner: 'system',
  });
  const freshRef = (fresh['result'] as Record<string, unknown>)[
    'outputRef'
  ] as string;
  await second.request(COMMAND_HOST_METHODS.waitInitial, {
    outputRef: freshRef,
    yieldTimeMs: 0,
  });

  for (
    let attempt = 0;
    attempt < 100 &&
    harness.core
      .listSessions()
      .some((session) => session.running && session.outputRef === abandonedRef);
    attempt += 1
  ) {
    await delay(50);
  }
  assert.deepEqual(
    harness.core
      .listSessions()
      .filter((session) => session.running)
      .map((session) => session.outputRef),
    [freshRef],
    'the abandoned session is reclaimed and the pinned one is left alone',
  );

  await second.request(COMMAND_HOST_METHODS.interact, {
    stateRoot: harness.stateRoot,
    threadId: threadId(9505),
    owner: 'system',
    outputRef: freshRef,
    terminate: true,
    yieldTimeMs: 0,
  });
});
