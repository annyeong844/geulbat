import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import net from 'node:net';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  buildRequest,
  COMMAND_HOST_METHODS,
  COMMAND_HOST_NOTIFICATIONS,
  COMMAND_HOST_PROTOCOL_VERSION,
  encodeFrame,
  FrameDecoder,
} from './protocol.js';
import {
  readCommandHostLock,
  resolveCommandHostPaths,
  type CommandHostPaths,
} from './runtime-paths.js';
import { createDaemonHostCommandRuntime } from './runtime-selection.js';
import { removeCommandHostWorkspace } from '../test-support/command-host-workspace.js';

// P7.5 spec v4 §14 T4 — "느린 subscriber + `yes`: child는 계속 실행, 링·
// 알림 큐·워커 RSS 모두 상한 내, resyncRequired 후 클라이언트가 페이지로
// 복구". 워커 RSS는 별도 프로세스에서만 잴 수 있으므로 이 파일만 실제
// 워커를 띄운다. 폐기 후 복구의 정확성은 T15(worker-server.test.ts)가 본다.

const THREAD_ID = 'thread-load';
const FLOOD_BLOCK_BYTES = 64 * 1024;
const FLOOD_BLOCKS = 1_000; // 64MiB — 무유계 버퍼링이면 RSS가 따라 오른다.
const TAIL_RING_BYTES = 1024 * 1024;
/** 출력량이 아니라 상한에 비례해야 한다 — 링·큐 예산의 넉넉한 상계. */
const MAX_RSS_GROWTH_BYTES = 64 * 1024 * 1024;

const FLOOD_CHILD = `const block = 'x'.repeat(${FLOOD_BLOCK_BYTES});
let sent = 0;
function pump() {
  while (sent < ${FLOOD_BLOCKS}) {
    sent += 1;
    if (!process.stdout.write(block)) {
      process.stdout.once('drain', pump);
      return;
    }
  }
  process.exit(0);
}
pump();`;

async function readRssBytes(pid: number): Promise<number | undefined> {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    return match?.[1] === undefined ? undefined : Number(match[1]) * 1024;
  } catch {
    return undefined;
  }
}

/** initialize + subscribe만 하고 읽기를 멈춘 연결 — 느린 소비자 대역. */
async function attachStalledSubscriber(
  paths: CommandHostPaths,
  outputRef: string,
): Promise<{ socket: net.Socket; notifications: () => string[] }> {
  const socket = net.connect(paths.socketPath);
  await once(socket, 'connect');
  const decoder = new FrameDecoder();
  const methods: string[] = [];
  const answered = new Map<number, (value: unknown) => void>();
  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      const message = frame.message as {
        id?: number;
        method?: string;
        result?: unknown;
      };
      if (message.id !== undefined) {
        answered.get(message.id)?.(message.result);
        answered.delete(message.id);
      } else if (message.method !== undefined) {
        methods.push(message.method);
      }
    }
  });
  const call = async (id: number, method: string, params: unknown) => {
    const answer = new Promise((resolve) => answered.set(id, resolve));
    socket.write(encodeFrame(buildRequest(id, method, params)));
    return await answer;
  };
  await call(1, COMMAND_HOST_METHODS.initialize, {
    protocolVersion: COMMAND_HOST_PROTOCOL_VERSION,
    stateRootFingerprint: paths.stateRootFingerprint,
  });
  await call(2, COMMAND_HOST_METHODS.subscribe, { outputRef });
  socket.pause();
  return { socket, notifications: () => methods };
}

void test('T4: a flood past a stalled subscriber stays bounded everywhere', async (t) => {
  if (platform() !== 'linux') {
    t.skip('worker RSS is read from /proc');
    return;
  }
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-load-'));
  const paths = await resolveCommandHostPaths(stateRoot);
  const runtime = createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 16 * 1024, tailRingBytes: TAIL_RING_BYTES },
    requestedMode: 'worker',
  });
  t.after(async () => {
    await runtime.closeAll();
    await removeCommandHostWorkspace(stateRoot);
  });

  const started = await runtime.start({
    executable: process.execPath,
    args: ['-e', FLOOD_CHILD],
    cwd: stateRoot,
    env: process.env,
    stateRoot,
    threadId: THREAD_ID,
    runId: 'run-load',
    callId: 'call-load',
    stdinMode: 'closed',
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  await runtime.waitForInitialResult({
    stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });

  const lock = await readCommandHostLock(paths.lockPath);
  if (lock === 'missing' || lock === 'unparsable') {
    assert.fail(`the worker lock was not readable: ${lock}`);
  }
  const workerPid = lock.pid;
  const baselineRss = await readRssBytes(workerPid);
  assert.ok(baselineRss !== undefined);

  const stalled = await attachStalledSubscriber(paths, started.outputRef);
  t.after(() => {
    stalled.socket.destroy();
  });

  // 홍수가 흐르는 동안 워커 RSS를 계속 지켜본다.
  let peakRss = baselineRss;
  let status = 'running';
  for (let sample = 0; sample < 200 && status === 'running'; sample += 1) {
    const observed = await runtime.interact({
      stateRoot,
      threadId: THREAD_ID,
      outputRef: started.outputRef,
      yieldTimeMs: 25,
    });
    assert.equal(observed.ok, true);
    if (!observed.ok) {
      return;
    }
    status = observed.value.snapshot.status;
    peakRss = Math.max(peakRss, (await readRssBytes(workerPid)) ?? peakRss);
  }

  const final = await runtime.interact({
    stateRoot,
    threadId: THREAD_ID,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(final.ok, true);
  if (!final.ok) {
    return;
  }
  const snapshot = final.value.snapshot;

  // 1) 프로세스는 출력량으로 죽지 않는다 (§3 원칙).
  assert.equal(snapshot.status, 'exit');
  assert.equal(snapshot.exitCode, 0);
  assert.equal(snapshot.stdoutBytes, FLOOD_BLOCK_BYTES * FLOOD_BLOCKS);

  // 2) 링은 예산에서 멈춘다 — 나머지는 omitted로 계상된다 (§4.1).
  const retained = snapshot.stdoutBytes - (snapshot.stdoutOmittedBytes ?? 0);
  assert.ok(
    retained <= TAIL_RING_BYTES,
    `retained window ${retained} must stay inside the ring budget`,
  );
  assert.ok(
    (snapshot.stdoutOmittedBytes ?? 0) > 0,
    'the flood must have pushed bytes out of the ring',
  );

  // 3) 워커 메모리는 출력량이 아니라 상한에 비례한다. 알림을 유계 없이
  //    쌓았다면 64MiB 홍수가 그대로 RSS에 나타난다.
  assert.ok(
    peakRss - baselineRss < MAX_RSS_GROWTH_BYTES,
    `worker RSS grew ${peakRss - baselineRss} bytes while ${snapshot.stdoutBytes} flowed`,
  );

  // 4) 멈춰 있던 소비자는 델타가 버려졌음을 통보받는다 (§7.5).
  stalled.socket.resume();
  for (
    let attempt = 0;
    attempt < 100 &&
    !stalled
      .notifications()
      .includes(COMMAND_HOST_NOTIFICATIONS.resyncRequired);
    attempt += 1
  ) {
    await delay(20);
  }
  assert.ok(
    stalled.notifications().includes(COMMAND_HOST_NOTIFICATIONS.resyncRequired),
    'a stalled subscriber must be told to resync',
  );
});
