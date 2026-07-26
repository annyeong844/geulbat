import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildHostCommandPaths,
  parseHostCommandOutputRef,
  SYSTEM_SESSION_OWNER,
} from '../daemon/host-command-output-store.js';
import { buildCommandHostJournalPath, readSpawnJournal } from './journal.js';
import { recoverCommandHostState } from './recovery.js';
import { createCommandSessionHost } from './session-core.js';
import type { CommandSessionHost, HostCommandRuntime } from './contract.js';

function threadId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface Fixture {
  host: CommandSessionHost;
  stateRoot: string;
}

async function makeFixture(
  t: { after(fn: () => Promise<void> | void): void },
  config: {
    inlineMaxBytes?: number;
    tailRingBytes?: number;
    maxYieldTimeMs?: number;
  } = {},
): Promise<Fixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-session-core-'));
  const host = createCommandSessionHost({
    inlineMaxBytes: config.inlineMaxBytes ?? 1024,
    tailRingBytes: config.tailRingBytes ?? 4096,
    ...(config.maxYieldTimeMs === undefined
      ? {}
      : { maxYieldTimeMs: config.maxYieldTimeMs }),
  });
  t.after(async () => {
    await host.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });
  return { host, stateRoot };
}

function startArgs(
  fixture: Fixture,
  thread: string,
  code: string,
  extra: Partial<Parameters<HostCommandRuntime['start']>[0]> = {},
): Parameters<HostCommandRuntime['start']>[0] {
  return {
    executable: process.execPath,
    args: ['-e', code],
    cwd: fixture.stateRoot,
    env: process.env,
    stateRoot: fixture.stateRoot,
    threadId: thread,
    runId: 'run-session-core',
    callId: 'call-session-core',
    stdinMode: 'closed',
    ...extra,
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function pollUntilTerminal(
  host: CommandSessionHost,
  fixture: Fixture,
  thread: string,
  outputRef: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const polled = await host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      outputRef,
      yieldTimeMs: 25,
    });
    assert.equal(polled.ok, true);
    if (polled.ok && polled.value.snapshot.status !== 'running') {
      return;
    }
  }
  assert.fail('session did not reach a terminal status');
}

void test('T1: terminal-before-claim small output returns inline with zero disk touch', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(9001);
  const started = await fixture.host.start(
    startArgs(
      fixture,
      thread,
      "process.stdout.write('hello'); process.stderr.write('warn');",
    ),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const result = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.outputRef, null);
  assert.equal(result.value.stdout, 'hello');
  assert.equal(result.value.stderr, 'warn');
  assert.equal(result.value.outputComplete, true);
  assert.equal(result.value.status, 'exit');
  const paths = buildHostCommandPaths({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
  });
  assert.equal(await directoryExists(paths.directory), false);
});

void test('terminal-before-claim protocol output remains pageable', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(9003);
  const output = 'fast-protocol';
  const started = await fixture.host.start(
    startArgs(
      fixture,
      thread,
      `process.stdout.write(${JSON.stringify(output)});`,
      { owner: 'system', streamMode: 'protocol' },
    ),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  const initial = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
  });
  assert.equal(initial.ok, true);
  if (!initial.ok) {
    return;
  }
  assert.equal(initial.value.outputRef, started.outputRef);
  assert.equal(initial.value.stdout, null);

  const observed = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    owner: 'system',
    outputRef: started.outputRef,
    yieldTimeMs: 0,
    page: {
      stream: 'stdout',
      offsetBytes: 0,
      limitBytes: 1024,
    },
  });
  assert.equal(observed.ok, true);
  if (observed.ok) {
    assert.equal(observed.value.page?.content, output);
    assert.equal(observed.value.page?.nextOffsetBytes, null);
  }
});

void test('T1: terminal-before-claim large output claims a durable tail artifact', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(9002);
  const started = await fixture.host.start(
    startArgs(fixture, thread, "process.stdout.write('x'.repeat(5000));"),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const result = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.outputRef, started.outputRef);
  assert.equal(result.value.stdout, null);
  assert.equal(result.value.stdoutBytes, 5000);
  assert.equal(result.value.stdoutOmittedBytes, 5000 - 4096);

  const page = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    page: { stream: 'stdout', offsetBytes: 0, limitBytes: 100 },
  });
  assert.equal(page.ok, true);
  if (!page.ok || page.value.page === null) {
    assert.fail('expected a page');
  }
  // 창 밖(이전) 오프셋은 earliestAvailableOffset으로 클램프된다 (§4.3).
  assert.equal(page.value.page.earliestAvailableOffset, 5000 - 4096);
  assert.equal(page.value.page.offsetBytes, 5000 - 4096);
  assert.equal(page.value.page.totalBytes, 5000);
  assert.equal(page.value.page.content, 'x'.repeat(100));

  // 재시작(새 코어) 후에도 같은 outputRef·같은 좌표로 조회된다.
  const restarted = createCommandSessionHost({
    inlineMaxBytes: 1024,
    tailRingBytes: 4096,
  });
  const recovered = await restarted.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    page: { stream: 'stdout', offsetBytes: 5000 - 4096, limitBytes: 100 },
  });
  assert.equal(recovered.ok, true);
  if (!recovered.ok || recovered.value.page === null) {
    assert.fail('expected a recovered page');
  }
  assert.equal(recovered.value.page.content, 'x'.repeat(100));
  assert.equal(recovered.value.snapshot.status, 'exit');
  await restarted.closeAll();
});

void test('T2: waitForInitialResult is idempotent after a completed claim', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(9003);
  const started = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);', {
      stdinMode: 'open',
    }),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const first = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 25,
  });
  assert.equal(first.ok, true);
  const second = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 25,
  });
  assert.deepEqual(second, first);

  const terminated = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    terminate: true,
    yieldTimeMs: 2_000,
  });
  assert.equal(terminated.ok, true);
  await pollUntilTerminal(fixture.host, fixture, thread, started.outputRef);
});

void test('authoritative abort before claim discards the session without residue', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(9004);
  const started = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const controller = new AbortController();
  const waiting = fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    signal: controller.signal,
  });
  controller.abort();
  const aborted = await waiting;
  assert.equal(aborted.ok, false);
  if (aborted.ok) {
    return;
  }
  assert.equal(aborted.reasonCode, 'wait_aborted');

  const after = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
  });
  assert.equal(after.ok, false);
  if (!after.ok) {
    assert.equal(after.reasonCode, 'not_found');
  }
  const paths = buildHostCommandPaths({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
  });
  assert.equal(await directoryExists(paths.directory), false);
});

void test('explicit terminate uses the graceful path and persists lru-style reason metadata', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(9005);
  const started = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 25,
  });
  assert.equal(claimed.ok, true);
  const terminated = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    terminate: true,
    yieldTimeMs: 2_500,
  });
  assert.equal(terminated.ok, true);
  await pollUntilTerminal(fixture.host, fixture, thread, started.outputRef);

  const restarted = createCommandSessionHost({
    inlineMaxBytes: 1024,
    tailRingBytes: 4096,
  });
  const recovered = await restarted.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
  });
  assert.equal(recovered.ok, true);
  if (recovered.ok) {
    assert.equal(recovered.value.snapshot.status, 'signal');
    assert.equal(
      recovered.value.snapshot.terminationReason,
      'explicit_terminate',
    );
  }
  await restarted.closeAll();
});

void test('caller timeout force-kills with caller_timeout reason', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(9006);
  const started = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);', {
      timeoutMs: 150,
    }),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const result = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, 'timeout');
    assert.equal(result.value.terminationReason, 'caller_timeout');
  }
});

void test('caller output cap stops the process with output_limit_exceeded', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(9007);
  const started = await fixture.host.start(
    startArgs(
      fixture,
      thread,
      "setInterval(() => process.stdout.write('y'.repeat(256)), 5);",
      { maxOutputBytesPerStream: 600 },
    ),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const result = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, 'output_limit_exceeded');
    assert.deepEqual(result.value.outputLimitExceeded, {
      stream: 'stdout',
      maxOutputBytesPerStream: 600,
    });
    assert.equal(result.value.terminationReason, 'caller_output_limit');
  }
});

void test('T7: live ring page and terminal artifact page agree on multibyte offsets', async (t) => {
  const fixture = await makeFixture(t, { tailRingBytes: 4096 });
  const thread = threadId(9008);
  const started = await fixture.host.start(
    startArgs(
      fixture,
      thread,
      "process.stdout.write('가'.repeat(3000)); setInterval(() => {}, 1000);",
    ),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 400,
  });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) {
    return;
  }
  assert.equal(claimed.value.stdoutBytes, 9000);
  const omitted = claimed.value.stdoutOmittedBytes;
  assert.equal(omitted, 9000 - 4096);

  const probeOffset = omitted + 1; // 다중바이트 문자 중간을 노린다
  const live = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
    page: { stream: 'stdout', offsetBytes: probeOffset, limitBytes: 90 },
  });
  assert.equal(live.ok, true);
  if (!live.ok || live.value.page === null) {
    assert.fail('expected a live page');
  }
  const livePage = live.value.page;
  assert.ok(livePage.contentStartOffset !== undefined);
  assert.ok(livePage.contentStartOffset >= probeOffset);
  assert.ok(livePage.content.length > 0);

  const terminated = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    terminate: true,
    yieldTimeMs: 2_500,
  });
  assert.equal(terminated.ok, true);
  await pollUntilTerminal(fixture.host, fixture, thread, started.outputRef);

  const restarted = createCommandSessionHost({
    inlineMaxBytes: 1024,
    tailRingBytes: 4096,
  });
  const persisted = await restarted.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    page: { stream: 'stdout', offsetBytes: probeOffset, limitBytes: 90 },
  });
  assert.equal(persisted.ok, true);
  if (!persisted.ok || persisted.value.page === null) {
    assert.fail('expected a persisted page');
  }
  assert.equal(
    persisted.value.page.contentStartOffset,
    livePage.contentStartOffset,
  );
  assert.equal(persisted.value.page.content, livePage.content);
  await restarted.closeAll();
});

void test('claimed session interrupted by a lost host reports command_host_interrupted', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(9009);
  const started = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 25,
  });
  assert.equal(claimed.ok, true);

  // 크래시 시뮬레이션: 링을 가진 코어가 사라지고 새 코어가 디스크만 본다.
  const restarted = createCommandSessionHost({
    inlineMaxBytes: 1024,
    tailRingBytes: 4096,
  });
  const recovered = await restarted.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
  });
  assert.equal(recovered.ok, true);
  if (recovered.ok) {
    assert.equal(recovered.value.snapshot.status, 'command_host_interrupted');
    assert.equal(
      recovered.value.snapshot.terminationReason,
      'command_host_lost',
    );
    assert.equal(recovered.value.snapshot.stdinOpen, false);
  }
  await restarted.closeAll();

  // 원 코어 정리(테스트 종료 시 closeAll이 프로세스를 회수한다).
});

void test('T10: hard admission — the 65th start over 64 owner-live unclaimed sessions is refused', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(9010);
  const refs: string[] = [];
  const starts = await Promise.all(
    Array.from({ length: 64 }, () =>
      fixture.host.start(
        startArgs(fixture, thread, 'setInterval(() => {}, 1000);'),
      ),
    ),
  );
  for (const startResult of starts) {
    assert.equal(startResult.ok, true);
    if (startResult.ok) {
      refs.push(startResult.outputRef);
    }
  }
  const overflow = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);'),
  );
  assert.equal(overflow.ok, false);
  if (!overflow.ok) {
    assert.equal(overflow.reasonCode, 'session_capacity_exhausted');
  }
});

void test('a cancelled joiner detaches from the claim without touching the session', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(9014);
  const started = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 25,
  });
  assert.equal(claimed.ok, true);

  const controller = new AbortController();
  controller.abort();
  const joiner = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    signal: controller.signal,
  });
  assert.equal(joiner.ok, false);
  if (!joiner.ok) {
    assert.equal(joiner.reasonCode, 'wait_aborted');
  }

  // 세션은 여전히 살아 있고 조회 가능하다 — 취소는 그 RPC만 끝냈다.
  const alive = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(alive.ok, true);
  if (alive.ok) {
    assert.equal(alive.value.snapshot.status, 'running');
  }

  await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    terminate: true,
    yieldTimeMs: 2_000,
  });
  await pollUntilTerminal(fixture.host, fixture, thread, started.outputRef);
});

void test('T20: subscribe barrier partitions past output from future notifications', async (t) => {
  const fixture = await makeFixture(t, { tailRingBytes: 1 << 20 });
  const thread = threadId(9012);
  const started = await fixture.host.start(
    startArgs(
      fixture,
      thread,
      "process.stdout.write('before'); " +
        'setTimeout(() => process.stdout.write("after"), 60); ' +
        'setInterval(() => {}, 1000);',
    ),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 30,
  });
  assert.equal(claimed.ok, true);
  // 'before'의 도착을 확정한 뒤에 barrier를 세운다 — 부하에서도 결정론적.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const polled = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      outputRef: started.outputRef,
      yieldTimeMs: 25,
    });
    assert.equal(polled.ok, true);
    if (polled.ok && polled.value.snapshot.stdoutBytes >= 'before'.length) {
      break;
    }
  }

  const events: Array<{
    startOffset: number;
    endOffset: number;
    chunk: string;
  }> = [];
  const subscription = fixture.host.subscribe({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    onEvent: (event) => {
      if (event.kind === 'output') {
        events.push({
          startOffset: event.startOffset,
          endOffset: event.endOffset,
          chunk: event.chunk,
        });
      }
    },
  });
  assert.equal(subscription.ok, true);
  if (!subscription.ok) {
    return;
  }
  // barrier 시점까지의 'before'는 알림이 아니라 barrierOffset에 반영된다.
  assert.equal(subscription.stdout.barrierOffset, 'before'.length);
  assert.equal(subscription.stdout.earliestAvailableOffset, 0);
  assert.equal(subscription.resyncRequired, false);
  assert.equal(events.length, 0);

  // barrier 이후 'after'만 알림으로 도착하고, 그 startOffset은 barrier와 이어진다.
  for (let attempt = 0; attempt < 100 && events.length === 0; attempt += 1) {
    await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      outputRef: started.outputRef,
      yieldTimeMs: 25,
    });
  }
  subscription.unsubscribe();
  assert.ok(events.length >= 1);
  const first = events[0];
  assert.ok(first !== undefined);
  assert.equal(first.chunk, 'after');
  assert.equal(first.startOffset, subscription.stdout.barrierOffset);
  assert.equal(first.endOffset, 'before'.length + 'after'.length);

  await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    terminate: true,
    yieldTimeMs: 2_000,
  });
  await pollUntilTerminal(fixture.host, fixture, thread, started.outputRef);
});

void test('subscribe reports resyncRequired when the resume offset predates the ring', async (t) => {
  const fixture = await makeFixture(t, { tailRingBytes: 4096 });
  const thread = threadId(9013);
  const started = await fixture.host.start(
    startArgs(
      fixture,
      thread,
      "process.stdout.write('x'.repeat(9000)); setInterval(() => {}, 1000);",
    ),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(claimed.ok, true);
  // 링이 실제로 넘칠 때까지 기다린다 — 고정 시간 창은 부하에서 흔들린다.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const observed = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      outputRef: started.outputRef,
      yieldTimeMs: 25,
    });
    if (observed.ok && (observed.value.snapshot.stdoutOmittedBytes ?? 0) > 0) {
      break;
    }
  }
  const subscription = fixture.host.subscribe({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    stdoutAfterOffset: 0,
    onEvent: () => {},
  });
  assert.equal(subscription.ok, true);
  if (subscription.ok) {
    // 0은 이미 링 밖(omitted)이라 gap을 링에서 못 준다 → resync 필요.
    assert.equal(subscription.resyncRequired, true);
    assert.ok(subscription.stdout.earliestAvailableOffset > 0);
    subscription.unsubscribe();
  }
  await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    terminate: true,
    yieldTimeMs: 2_000,
  });
  await pollUntilTerminal(fixture.host, fixture, thread, started.outputRef);
});

void test('LRU: the 65th start evicts the least-recently-touched claimed session', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(9011);
  const refs: string[] = [];
  for (let index = 0; index < 64; index += 1) {
    const startResult = await fixture.host.start(
      startArgs(fixture, thread, 'setInterval(() => {}, 1000);'),
    );
    assert.equal(startResult.ok, true);
    if (!startResult.ok) {
      return;
    }
    const claimed = await fixture.host.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: startResult.outputRef,
      yieldTimeMs: 0,
    });
    assert.equal(claimed.ok, true);
    refs.push(startResult.outputRef);
  }

  const overflow = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);'),
  );
  assert.equal(overflow.ok, true);

  const victimRef = refs[0];
  assert.ok(victimRef !== undefined);
  const victim = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: victimRef,
  });
  assert.equal(victim.ok, true);
  if (victim.ok) {
    assert.equal(victim.value.snapshot.status, 'signal');
    assert.equal(victim.value.snapshot.terminationReason, 'lru_evicted');
  }
});

void test('a started session is journaled before it runs and retired when it finishes', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(71);
  const started = await fixture.host.start(
    startArgs(fixture, thread, 'process.stdout.write("j".repeat(4000));'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const journalPath = buildCommandHostJournalPath(fixture.stateRoot);
  const duringRun = await readSpawnJournal(journalPath);
  assert.equal(duringRun.ok, true);
  if (duringRun.ok) {
    const row = duringRun.open.find(
      (candidate) => candidate.outputRef === started.outputRef,
    );
    // GO는 이 행이 fdatasync된 뒤에만 쓰였다 (§5.1).
    assert.ok(row !== undefined, 'the open row exists before the child runs');
    assert.equal(row?.gated, true);
    assert.ok((row?.pid ?? 0) > 0);
  }

  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
  });
  assert.equal(claimed.ok, true);

  const afterFinish = await readSpawnJournal(journalPath);
  assert.equal(afterFinish.ok, true);
  if (afterFinish.ok) {
    assert.equal(
      afterFinish.open.some(
        (candidate) => candidate.outputRef === started.outputRef,
      ),
      false,
      'the open row is retired once the session is durable',
    );
    const parsed = parseHostCommandOutputRef(started.outputRef);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      const closed = afterFinish.closed.get(parsed.sessionId);
      assert.equal(closed?.phase, 'finished');
      assert.equal(closed?.terminal?.status, 'exit');
      assert.equal(closed?.terminal?.exitCode, 0);
    }
  }
});

void test('restart survival: a fresh host serves a finished session after recovery', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(72);
  const started = await fixture.host.start(
    startArgs(fixture, thread, 'process.stdout.write("s".repeat(4000));'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
  });
  assert.equal(claimed.ok, true);
  await fixture.host.closeAll();

  // 데몬/워커 재시작을 재현한다 — 새 코어는 세션을 메모리에 갖고 있지 않다.
  const report = await recoverCommandHostState({
    stateRoot: fixture.stateRoot,
  });
  assert.equal(report.markedInterrupted, 0, 'a finished session is untouched');
  const revived = createCommandSessionHost({
    inlineMaxBytes: 1024,
    tailRingBytes: 4096,
  });
  t.after(async () => {
    await revived.closeAll();
  });

  const read = await revived.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    page: { stream: 'stdout', offsetBytes: 0, limitBytes: 16 },
  });
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.value.snapshot.status, 'exit');
    assert.equal(read.value.page?.content, 's'.repeat(16));
  }
});

void test('§7.5: stdin refuses to buffer past the per-session cap', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(81);
  // 자식이 stdin을 전혀 읽지 않는다 — 파이프가 차면 버퍼가 자란다.
  const started = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);', {
      stdinMode: 'open',
    }),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });

  let refused: { reasonCode: string; message: string } | undefined;
  for (let attempt = 0; attempt < 8 && refused === undefined; attempt += 1) {
    const written = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      outputRef: started.outputRef,
      chars: 'p'.repeat(512 * 1024),
      yieldTimeMs: 0,
    });
    if (!written.ok) {
      refused = { reasonCode: written.reasonCode, message: written.message };
    }
  }
  assert.equal(refused?.reasonCode, 'stdin_backpressure');
  assert.match(refused?.message ?? '', /not reading/u);

  // 세션은 여전히 살아 있다 — 되돌린 것은 이 쓰기뿐이다.
  const alive = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(alive.ok, true);
  if (alive.ok) {
    assert.equal(alive.value.snapshot.status, 'running');
  }
});

void test('§7.5: every output notification stays within the chunk bound', async (t) => {
  const fixture = await makeFixture(t, { tailRingBytes: 1024 * 1024 });
  const thread = threadId(82);
  const started = await fixture.host.start(
    startArgs(
      fixture,
      thread,
      'setTimeout(() => { process.stdout.write("c".repeat(300 * 1024)); }, 20);',
    ),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const ranges: Array<{ startOffset: number; endOffset: number }> = [];
  const subscription = fixture.host.subscribe({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    onEvent: (event) => {
      if (event.kind === 'output') {
        ranges.push({
          startOffset: event.startOffset,
          endOffset: event.endOffset,
        });
      }
    },
  });
  assert.equal(subscription.ok, true);

  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
  });
  assert.equal(claimed.ok, true);
  if (claimed.ok) {
    assert.equal(claimed.value.stdoutBytes, 300 * 1024);
  }

  // 알림 1건은 §7.5 상한을 넘지 않는다. 파이프가 이미 그보다 작게 끊어
  // 주더라도, 더 큰 조각이 오는 환경에서 이 상한이 지켜지는 것이 규범이다.
  assert.ok(ranges.length > 0);
  for (const range of ranges) {
    assert.ok(
      range.endOffset - range.startOffset <= 64 * 1024,
      `notification range ${range.startOffset}-${range.endOffset} exceeds the bound`,
    );
  }
  // 그리고 범위들은 빈틈도 겹침도 없이 이어진다.
  let expected = 0;
  for (const range of ranges) {
    assert.equal(range.startOffset, expected);
    expected = range.endOffset;
  }
  assert.equal(expected, 300 * 1024);
});

void test('§4.6: an endless command yields a ref at the ceiling instead of hanging', async (t) => {
  // 상한을 작게 잡아 관측한다 — 규범은 "상한이 있다"이고 값은 config다.
  const fixture = await makeFixture(t, { maxYieldTimeMs: 150 });
  const thread = threadId(91);
  const started = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  // yieldTimeMs를 주지 않는다 = 예전에는 "끝날 때까지" 였다. 이 명령은
  // 끝나지 않으므로 턴이 영원히 막혔다.
  const startedAt = Date.now();
  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(claimed.ok, true);
  if (claimed.ok) {
    // 기다림만 끊었을 뿐 프로세스는 살아 있고, ref로 계속 관측된다.
    assert.equal(claimed.value.status, 'running');
    assert.equal(claimed.value.outputRef, started.outputRef);
  }
  assert.ok(
    elapsed < 5_000,
    `the wait must end at the ceiling, took ${elapsed}ms`,
  );

  await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    terminate: true,
    yieldTimeMs: 0,
  });
  await pollUntilTerminal(fixture.host, fixture, thread, started.outputRef);
});

void test('§4.6: a caller asking beyond the ceiling is clamped to it', async (t) => {
  const fixture = await makeFixture(t, { maxYieldTimeMs: 150 });
  const thread = threadId(92);
  const started = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const startedAt = Date.now();
  await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 60_000,
  });
  assert.ok(
    Date.now() - startedAt < 5_000,
    'no caller can ask to wait past the ceiling',
  );

  // 상한은 interact의 대기에도 똑같이 적용된다.
  const polled = Date.now();
  await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    yieldTimeMs: 60_000,
  });
  assert.ok(Date.now() - polled < 5_000, 'interact honours the same ceiling');

  await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: started.outputRef,
    terminate: true,
    yieldTimeMs: 0,
  });
  await pollUntilTerminal(fixture.host, fixture, thread, started.outputRef);
});

// §4.7 — 부수효과 재시도 의미론. 응답만 유실된 요청을 같은 operation으로
// 다시 보내면, 세션은 그것이 이미 적용된 요청임을 순서로 알아본다.

async function startEchoSession(
  fixture: Fixture,
  thread: string,
): Promise<string> {
  const started = await fixture.host.start(
    startArgs(
      fixture,
      thread,
      'process.stdin.on("data", (d) => process.stdout.write("got:" + d)); process.stdin.on("end", () => process.exit(0));',
      { stdinMode: 'open' },
    ),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    throw new Error('echo session did not start');
  }
  await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  return started.outputRef;
}

async function readAllStdout(
  fixture: Fixture,
  thread: string,
  outputRef: string,
): Promise<string> {
  const closed = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef,
    closeStdin: true,
    yieldTimeMs: 0,
  });
  assert.equal(closed.ok, true);
  await pollUntilTerminal(fixture.host, fixture, thread, outputRef);
  const read = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef,
    page: { stream: 'stdout', offsetBytes: 0, limitBytes: 256 },
    yieldTimeMs: 0,
  });
  assert.equal(read.ok, true);
  return read.ok ? (read.value.page?.content ?? '') : '';
}

void test('§4.7: the same operation resent writes stdin exactly once', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(93);
  const outputRef = await startEchoSession(fixture, thread);
  const operation = { clientId: 'facade-a', seq: 1 };

  const first = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef,
    chars: 'ping',
    operation,
    yieldTimeMs: 200,
  });
  assert.equal(first.ok, true);

  // 파사드가 응답을 못 받고 같은 요청을 다시 보낸 상황.
  const resent = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef,
    chars: 'ping',
    operation,
    yieldTimeMs: 50,
  });
  assert.equal(resent.ok, true, 'a duplicate still answers with observation');

  assert.equal(await readAllStdout(fixture, thread, outputRef), 'got:ping');
});

void test('§4.7: a later operation from the same facade still applies', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(94);
  const outputRef = await startEchoSession(fixture, thread);

  for (const seq of [1, 2]) {
    const written = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      outputRef,
      chars: `p${seq}`,
      operation: { clientId: 'facade-a', seq },
      yieldTimeMs: 200,
    });
    assert.equal(written.ok, true);
  }

  assert.equal(
    await readAllStdout(fixture, thread, outputRef),
    'got:p1got:p2',
    'distinct operations are two writes, not one',
  );
});

void test('§4.7: a retry that lost its turn is refused, not applied late', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(95);
  const outputRef = await startEchoSession(fixture, thread);

  for (const seq of [1, 2]) {
    await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      outputRef,
      chars: `p${seq}`,
      operation: { clientId: 'facade-a', seq },
      yieldTimeMs: 200,
    });
  }
  // seq 1의 뒤늦은 재전송 — 지금 적용하면 호출자가 의도한 순서가 뒤집힌다.
  const late = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef,
    chars: 'p1',
    operation: { clientId: 'facade-a', seq: 1 },
    yieldTimeMs: 0,
  });
  assert.equal(late.ok, false);
  if (!late.ok) {
    assert.equal(late.reasonCode, 'operation_superseded');
  }

  assert.equal(await readAllStdout(fixture, thread, outputRef), 'got:p1got:p2');
});

void test('§4.7: a new facade instance is not measured against the old one', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(96);
  const outputRef = await startEchoSession(fixture, thread);

  await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef,
    chars: 'old',
    operation: { clientId: 'facade-a', seq: 7 },
    yieldTimeMs: 200,
  });
  // 데몬이 다시 서면 번호도 1부터다. 사라진 파사드는 재시도하지 않으므로
  // 그 번호와 비교할 이유가 없다.
  const fresh = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef,
    chars: 'new',
    operation: { clientId: 'facade-b', seq: 1 },
    yieldTimeMs: 200,
  });
  assert.equal(fresh.ok, true);

  assert.equal(
    await readAllStdout(fixture, thread, outputRef),
    'got:oldgot:new',
  );
});

// P7.6 §5.1·§5.3 — 시스템 세션: 데몬 자신이 소유하고, exec_command의 정원 64를
// 쓰지 않으며, 퇴거되지 않고, 어떤 스레드의 열거에도 나타나지 않는다.

void test('P7.6: a system session does not consume the exec_command capacity', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(97);
  const started = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);', {
      owner: 'system',
    }),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });

  // 정원은 스레드 세션만 센다 — 시스템 세션이 하나 떠 있어도 64개가 그대로다.
  const threadRefs: string[] = [];
  for (let index = 0; index < 64; index += 1) {
    const spawned = await fixture.host.start(
      startArgs(fixture, thread, 'process.stdout.write("x");'),
    );
    assert.equal(spawned.ok, true, `session ${index} should be admitted`);
    if (spawned.ok) {
      threadRefs.push(spawned.outputRef);
    }
  }
  assert.equal(threadRefs.length, 64);

  // 시스템 세션은 여전히 살아 있다 — 퇴거 후보가 아니다.
  const alive = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    owner: 'system',
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(alive.ok, true);
  if (alive.ok) {
    assert.equal(alive.value.snapshot.status, 'running');
  }

  await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    owner: 'system',
    outputRef: started.outputRef,
    terminate: true,
    yieldTimeMs: 0,
  });
});

void test('P7.6: a thread cannot reach a system session, and the reverse', async (t) => {
  const fixture = await makeFixture(t);
  const thread = threadId(98);
  const system = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);', {
      owner: 'system',
    }),
  );
  const owned = await fixture.host.start(
    startArgs(fixture, thread, 'setInterval(() => {}, 1000);'),
  );
  assert.equal(system.ok && owned.ok, true);
  if (!system.ok || !owned.ok) {
    return;
  }

  // 스레드 자격으로 시스템 세션에 닿을 수 없다.
  const stolen = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    outputRef: system.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(stolen.ok, false);
  if (!stolen.ok) {
    assert.equal(stolen.reasonCode, 'access_denied');
  }

  // 반대로 시스템 자격이 스레드 세션을 열지도 못한다.
  const overreach = await fixture.host.interact({
    stateRoot: fixture.stateRoot,
    threadId: thread,
    owner: 'system',
    outputRef: owned.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(overreach.ok, false);
  if (!overreach.ok) {
    assert.equal(overreach.reasonCode, 'access_denied');
  }

  // 스레드 열거에도 시스템 세션은 없다.
  const listed = await fixture.host.listThreadSessions({
    stateRoot: fixture.stateRoot,
    threadId: thread,
  });
  assert.deepEqual(
    listed.map((entry) => entry.outputRef),
    [owned.outputRef],
  );

  for (const [ref, owner] of [
    [system.outputRef, 'system'],
    [owned.outputRef, 'thread'],
  ] as const) {
    await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      owner,
      outputRef: ref,
      terminate: true,
      yieldTimeMs: 0,
    });
  }
});

void test('P7.6: a terminal system session leaves resident memory but remains pageable', async (t) => {
  const fixture = await makeFixture(t, {
    inlineMaxBytes: 16,
    tailRingBytes: 1024,
  });
  const thread = threadId(101);
  const output = 'resident-memory-must-be-released';
  const started = await fixture.host.start(
    startArgs(
      fixture,
      thread,
      `process.stdout.write(${JSON.stringify(output)});`,
      { owner: 'system' },
    ),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  const initial = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
  });
  assert.equal(initial.ok, true);
  if (!initial.ok) {
    return;
  }
  if (initial.value.status === 'running') {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const observed = await fixture.host.interact({
        stateRoot: fixture.stateRoot,
        threadId: thread,
        owner: 'system',
        outputRef: started.outputRef,
        yieldTimeMs: 25,
      });
      assert.equal(observed.ok, true);
      if (observed.ok && observed.value.snapshot.status !== 'running') {
        break;
      }
    }
  }

  assert.equal(
    fixture.host
      .listSessions()
      .some((session) => session.outputRef === started.outputRef),
    false,
    'a fully persisted terminal system session is no longer resident',
  );

  let recovered = '';
  let offsetBytes = 0;
  for (;;) {
    const pageResult = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      owner: 'system',
      outputRef: started.outputRef,
      yieldTimeMs: 0,
      page: { stream: 'stdout', offsetBytes, limitBytes: 16 },
    });
    assert.equal(pageResult.ok, true);
    if (!pageResult.ok) {
      return;
    }
    const page = pageResult.value.page;
    assert.notEqual(page, null);
    if (page === null) {
      return;
    }
    recovered += page.content;
    if (page.nextOffsetBytes === null) {
      break;
    }
    offsetBytes = page.nextOffsetBytes;
  }
  assert.equal(recovered, output);
});

void test('P7.6: a protocol stream loses no bytes when the reader keeps up', async (t) => {
  // 링 예산보다 훨씬 많이 쏟아내되, 읽는 쪽이 따라가면 한 바이트도 잃지 않는다.
  const fixture = await makeFixture(t, { tailRingBytes: 4096 });
  const thread = threadId(99);
  const totalBytes = 64 * 1024;
  const started = await fixture.host.start(
    startArgs(
      fixture,
      thread,
      `let sent = 0; const step = () => { if (sent >= ${totalBytes}) { process.exit(0); } process.stdout.write("y".repeat(1024)); sent += 1024; setTimeout(step, 1); }; step();`,
      { owner: 'system', streamMode: 'protocol' },
    ),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });

  let readBytes = 0;
  let terminal = false;
  for (let attempt = 0; attempt < 400 && !terminal; attempt += 1) {
    const observed = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      owner: 'system',
      outputRef: started.outputRef,
      yieldTimeMs: 20,
      page: { stream: 'stdout', offsetBytes: readBytes, limitBytes: 1024 },
    });
    assert.equal(observed.ok, true);
    if (!observed.ok) {
      return;
    }
    const page = observed.value.page;
    if (page !== null) {
      assert.equal(
        page.offsetBytes,
        readBytes,
        'the reader never has to skip a gap',
      );
      readBytes = page.endOffsetBytes;
    }
    terminal =
      observed.value.snapshot.status !== 'running' &&
      readBytes >= observed.value.snapshot.stdoutBytes;
  }

  assert.equal(readBytes, totalBytes, 'every byte reached the reader');
});

void test('P7.6: lossless stderr pauses at its budget and resumes after page release', async (t) => {
  const tailRingBytes = 4096;
  const fixture = await makeFixture(t, {
    inlineMaxBytes: tailRingBytes,
    tailRingBytes,
  });
  const thread = threadId(990);
  const totalBytes = 256 * 1024;
  const code = [
    'const chunk = "e".repeat(4096);',
    'let sent = 0;',
    'const write = () => {',
    `  while (sent < ${totalBytes}) {`,
    '    const writable = process.stderr.write(chunk);',
    '    sent += chunk.length;',
    '    if (!writable) {',
    '      process.stderr.once("drain", write);',
    '      return;',
    '    }',
    '  }',
    '  process.exitCode = 0;',
    '};',
    'write();',
  ].join('');
  const started = await fixture.host.start(
    startArgs(fixture, thread, code, {
      owner: 'system',
      streamMode: 'lossless',
    }),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) {
    return;
  }

  let held = claimed.value;
  for (
    let attempt = 0;
    attempt < 40 && held.stderrBytes < tailRingBytes;
    attempt += 1
  ) {
    const observed = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      owner: 'system',
      outputRef: started.outputRef,
      yieldTimeMs: 20,
    });
    assert.equal(observed.ok, true);
    if (!observed.ok) {
      return;
    }
    held = observed.value.snapshot;
  }

  assert.equal(held.stderrOmittedBytes, 0);
  assert.ok(
    held.stderrBytes >= tailRingBytes,
    'stderr reaches the configured backpressure budget',
  );
  assert.ok(
    held.stderrBytes < totalBytes,
    'the unread stderr source is paused before the child finishes writing',
  );
  assert.equal(held.status, 'running');

  let stderr = '';
  let readBytes = 0;
  let terminal = false;
  for (let attempt = 0; attempt < 400 && !terminal; attempt += 1) {
    const observed = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      owner: 'system',
      outputRef: started.outputRef,
      yieldTimeMs: 20,
      page: {
        stream: 'stderr',
        offsetBytes: readBytes,
        limitBytes: tailRingBytes,
      },
    });
    assert.equal(observed.ok, true);
    if (!observed.ok) {
      return;
    }
    const page = observed.value.page;
    if (page !== null) {
      assert.equal(page.offsetBytes, readBytes);
      stderr += page.content;
      readBytes = page.endOffsetBytes;
    }
    terminal =
      observed.value.snapshot.status !== 'running' &&
      readBytes >= observed.value.snapshot.stderrBytes;
  }

  assert.equal(readBytes, totalBytes, 'every stderr byte reached the reader');
  assert.equal(Buffer.byteLength(stderr, 'utf8'), totalBytes);
  assert.equal(stderr, 'e'.repeat(totalBytes));
});

void test('exact markers are redacted before command labels, notifications, rings, and terminal artifacts', async (t) => {
  const fixture = await makeFixture(t, {
    inlineMaxBytes: 1024,
    tailRingBytes: 4096,
  });
  const thread = threadId(991);
  const markers = [
    'ptc-bridge-token-that-must-never-reach-durable-output',
    '/private/ptc/session/callback-host.sock',
    '/geulbat/callbacks/callback-container.sock',
  ] as const;
  const [token, hostSocketPath, containerSocketPath] = markers;
  const replacement = '[redacted:ptc-callback]';
  const observed: Record<'stdout' | 'stderr', string[]> = {
    stdout: [],
    stderr: [],
  };
  const code = [
    `const token = ${JSON.stringify(token)};`,
    `const hostSocketPath = ${JSON.stringify(hostSocketPath)};`,
    `const containerSocketPath = ${JSON.stringify(containerSocketPath)};`,
    'process.stdout.write(`visible:${token.slice(0, 19)}`);',
    'setTimeout(() => {',
    '  process.stdout.write(`${token.slice(19)}\\nhost:${hostSocketPath}\\n`);',
    '  process.stderr.write(`container:${containerSocketPath}\\n`);',
    '}, 40);',
    'setTimeout(() => process.exit(0), 100);',
  ].join('');
  const started = await fixture.host.start(
    startArgs(fixture, thread, code, {
      owner: 'system',
      outputRedaction: {
        exactMarkers: markers,
        replacement,
      },
      onOutput: ({ stream, text }) => {
        observed[stream].push(text);
      },
    }),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  const listed = fixture.host
    .listSessions()
    .find((session) => session.outputRef === started.outputRef);
  assert.ok(listed);
  for (const marker of markers) {
    assert.equal(listed.command.includes(marker), false);
  }
  assert.match(listed.command, /\[redacted:ptc-callback\]/u);

  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) {
    return;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const terminal = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      owner: 'system',
      outputRef: started.outputRef,
      yieldTimeMs: 25,
    });
    assert.equal(terminal.ok, true);
    if (terminal.ok && terminal.value.snapshot.status !== 'running') {
      break;
    }
  }

  const paths = buildHostCommandPaths({
    stateRoot: fixture.stateRoot,
    threadId: SYSTEM_SESSION_OWNER,
    outputRef: started.outputRef,
  });
  const stdout = await readFile(paths.stdout, 'utf8');
  const stderr = await readFile(paths.stderr, 'utf8');
  const metadata = await readFile(paths.metadata, 'utf8');
  const journal = await readFile(
    buildCommandHostJournalPath(fixture.stateRoot),
    'utf8',
  );
  assert.equal(stdout, `visible:${replacement}\nhost:${replacement}\n`);
  assert.equal(stderr, `container:${replacement}\n`);
  assert.equal(observed.stdout.join(''), stdout);
  assert.equal(observed.stderr.join(''), stderr);
  for (const surfaced of [
    listed.command,
    stdout,
    stderr,
    metadata,
    journal,
    observed.stdout.join(''),
    observed.stderr.join(''),
  ]) {
    for (const marker of markers) {
      assert.equal(surfaced.includes(marker), false);
    }
  }
});

void test('P7.6: backpressure holds the source instead of overwriting output', async (t) => {
  // 아무도 읽지 않을 때: tail 모드는 앞을 버리며 끝까지 다 쓰고, protocol
  // 모드는 버리지 않는 대신 **소스를 멈춘다**.
  const fixture = await makeFixture(t, { tailRingBytes: 4096 });
  const thread = threadId(100);
  const totalBytes = 256 * 1024;
  const code = `const chunk = "z".repeat(4096); for (let i = 0; i < 64; i += 1) { process.stdout.write(chunk); } setInterval(() => {}, 1000);`;

  const tailRun = await fixture.host.start(
    startArgs(fixture, thread, code, { owner: 'system' }),
  );
  const protocolRun = await fixture.host.start(
    startArgs(fixture, thread, code, {
      owner: 'system',
      streamMode: 'protocol',
    }),
  );
  assert.equal(tailRun.ok && protocolRun.ok, true);
  if (!tailRun.ok || !protocolRun.ok) {
    return;
  }

  const observe = async (outputRef: string) => {
    const observed = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      owner: 'system',
      outputRef,
      yieldTimeMs: 50,
    });
    assert.equal(observed.ok, true);
    return observed.ok ? observed.value.snapshot : undefined;
  };

  // 읽지 않고 관측만 반복한다 — tail은 끝까지 쓰고, protocol은 멈춘다.
  let tailSnapshot = await observe(tailRun.outputRef);
  let protocolSnapshot = await observe(protocolRun.outputRef);
  for (
    let attempt = 0;
    attempt < 40 && (tailSnapshot?.stdoutBytes ?? 0) < totalBytes;
    attempt += 1
  ) {
    tailSnapshot = await observe(tailRun.outputRef);
    protocolSnapshot = await observe(protocolRun.outputRef);
  }

  assert.equal(
    tailSnapshot?.stdoutBytes,
    totalBytes,
    'nothing holds the tail-mode child back',
  );
  assert.ok(
    (tailSnapshot?.stdoutOmittedBytes ?? 0) > 0,
    'tail mode drops the head once the budget is exceeded',
  );
  assert.equal(
    protocolSnapshot?.stdoutOmittedBytes ?? 0,
    0,
    'protocol mode reports no omission — it hands nothing away unread',
  );
  assert.ok(
    (protocolSnapshot?.stdoutBytes ?? 0) < totalBytes,
    'the protocol source is held back rather than overwriting its buffer',
  );

  for (const ref of [tailRun.outputRef, protocolRun.outputRef]) {
    await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: thread,
      owner: 'system',
      outputRef: ref,
      terminate: true,
      yieldTimeMs: 0,
    });
  }
});
