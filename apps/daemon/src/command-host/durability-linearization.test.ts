import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildHostCommandPaths,
  type HostCommandMetadata,
} from '../daemon/host-command-output-store.js';
import type { DurabilityStage } from './durability.js';
import { recoverCommandHostState } from './recovery.js';
import { createCommandSessionHost } from './session-core.js';
import type { CommandSessionHost, HostCommandRuntime } from './contract.js';

// P7.5 spec v4 §14 — T3(내구화 failpoint) · T9(claim 선형화 경합) ·
// T19(claiming cancel matrix). 셋 다 "시퀀스 **안쪽**의 시각"을 묻는다:
// temp를 쓴 직후, fsync 직후, rename 직후, 부모 dir fsync 직후 각 지점에
// 실패·취소·자식 종료를 끼워 넣었을 때 §4.2 표의 허용 상태 하나로
//수렴하는가. 그 시각은 밖에서 만들 수 없으므로 config의 단계 관찰자를
// 쓴다 — 저장소는 대역이 아니고 실제 fsync·rename이 그대로 일어난다.

const THREAD = 'thread-linearization';

/** claim 커밋점은 `claim.committed`(부모 dir fsync)이다 — §4.2.1. */
const CLAIM_STAGES_BEFORE_COMMIT: readonly DurabilityStage[] = [
  'claim.begin',
  'claim.temp_written',
  'claim.temp_synced',
  'claim.renamed',
];

interface Fixture {
  host: CommandSessionHost;
  stateRoot: string;
}

async function makeFixture(
  t: { after(fn: () => Promise<void> | void): void },
  observe?: (stage: DurabilityStage) => Promise<void> | void,
): Promise<Fixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-linearize-'));
  const host = createCommandSessionHost({
    inlineMaxBytes: 64,
    tailRingBytes: 4096,
    ...(observe === undefined ? {} : { onDurabilityStage: observe }),
  });
  t.after(async () => {
    await host.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });
  return { host, stateRoot };
}

function startArgs(
  fixture: Fixture,
  code: string,
): Parameters<HostCommandRuntime['start']>[0] {
  return {
    executable: process.execPath,
    args: ['-e', code],
    cwd: fixture.stateRoot,
    env: process.env,
    stateRoot: fixture.stateRoot,
    threadId: THREAD,
    runId: 'run-linearize',
    callId: 'call-linearize',
    stdinMode: 'closed',
  };
}

async function sessionDirectoryEntries(
  fixture: Fixture,
  outputRef: string,
): Promise<string[]> {
  const paths = buildHostCommandPaths({
    stateRoot: fixture.stateRoot,
    threadId: THREAD,
    outputRef,
  });
  try {
    return (await readdir(paths.directory)).sort();
  } catch {
    return [];
  }
}

async function readMetadata(
  fixture: Fixture,
  outputRef: string,
): Promise<HostCommandMetadata | undefined> {
  const paths = buildHostCommandPaths({
    stateRoot: fixture.stateRoot,
    threadId: THREAD,
    outputRef,
  });
  try {
    return JSON.parse(
      await readFile(paths.metadata, 'utf8'),
    ) as HostCommandMetadata;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// T3 — 각 내구화 단계에서 실패시키고 §5.3 사분법 · §5.5 복구표와 대조한다.
// ---------------------------------------------------------------------------

for (const failAt of CLAIM_STAGES_BEFORE_COMMIT) {
  void test(`T3: a claim that fails at ${failAt} leaves no half-claimed session`, async (t) => {
    const fixture = await makeFixture(t, (stage) => {
      if (stage === failAt) {
        throw new Error(`injected failure at ${stage}`);
      }
    });
    const started = await fixture.host.start(
      startArgs(fixture, 'setInterval(() => {}, 1000);'),
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
    // §5.3 — claim 메타 실패는 claim 실패 응답 + discard다.
    assert.equal(claimed.ok, false);
    if (!claimed.ok) {
      assert.equal(claimed.reasonCode, 'output_store_failed');
    }

    // 커밋 전 실패이므로 반쯤 claim된 세션이 디스크에 남아서는 안 된다.
    // temp 잔재는 허용되지만(§5.2 5단계가 수거) metadata는 없어야 한다.
    const entries = await sessionDirectoryEntries(fixture, started.outputRef);
    assert.equal(
      entries.includes('metadata.json'),
      false,
      `a failure before the commit point must not publish metadata, saw ${JSON.stringify(entries)}`,
    );

    // 그리고 기동 복구가 그 잔재를 남김없이 수거한다 (§14 수용기준 5).
    await recoverCommandHostState({ stateRoot: fixture.stateRoot });
    assert.deepEqual(
      await sessionDirectoryEntries(fixture, started.outputRef),
      [],
    );
  });
}

void test('T3: artifact success with metadata failure keeps the terminal truth in the journal', async (t) => {
  const fixture = await makeFixture(t, (stage) => {
    // §5.3 3행 — artifact는 남고 terminal metadata만 실패한 창.
    if (stage === 'terminal.metadata_begin') {
      throw new Error('injected terminal metadata failure');
    }
  });
  const started = await fixture.host.start(
    startArgs(
      fixture,
      'process.stdout.write("x".repeat(400)); setTimeout(() => {}, 120);',
    ),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  // 자식이 살아 있는 동안 claim한다 — 그래야 metadata가 running으로 커밋되고
  // §5.3 3행("artifact 성공 + terminal metadata 실패")의 창이 열린다.
  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(claimed.ok, true);

  // claim 시점의 metadata는 running으로 남아 있다 — terminal 갱신이 실패했다.
  const stale = await readMetadata(fixture, started.outputRef);
  assert.equal(stale?.status, 'running');

  // 자식이 끝나고 terminal 내구화가 실패하기를 기다린다.
  for (;;) {
    const observed = await fixture.host.interact({
      stateRoot: fixture.stateRoot,
      threadId: THREAD,
      outputRef: started.outputRef,
      yieldTimeMs: 50,
    });
    if (!observed.ok || observed.value.snapshot.status !== 'running') {
      break;
    }
  }

  // 재시작하면 journal closed 행의 terminal 기술자가 진실의 원천이 된다.
  await fixture.host.closeAll();
  const report = await recoverCommandHostState({
    stateRoot: fixture.stateRoot,
  });
  assert.equal(report.promotedToFinished, 1);
  const promoted = await readMetadata(fixture, started.outputRef);
  assert.equal(promoted?.status, 'exit');
  assert.equal(promoted?.exitCode, 0);
  assert.equal(promoted?.stdoutBytes, 400);
});

void test('T3: artifact failure is reported without losing the terminal status', async (t) => {
  const fixture = await makeFixture(t, (stage) => {
    // §5.3 2행 — artifact만 실패하고 metadata는 성공한다.
    if (stage === 'terminal.artifacts_begin') {
      throw new Error('injected artifact failure');
    }
  });
  const started = await fixture.host.start(
    startArgs(fixture, 'process.stdout.write("y".repeat(400));'),
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
  if (claimed.ok) {
    assert.equal(claimed.value.status, 'exit');
    assert.equal(claimed.value.outputPersistFailed, true);
  }
  const persisted = await readMetadata(fixture, started.outputRef);
  assert.equal(persisted?.status, 'exit');
  assert.equal(persisted?.outputPersistFailed, true);
});

// ---------------------------------------------------------------------------
// T19 — claiming cancel matrix. 커밋 전 취소는 결정론적 discard,
//       커밋 후 취소는 커밋된 결과, 비소유 waiter 취소는 세션 무영향.
// ---------------------------------------------------------------------------

for (const cancelAt of CLAIM_STAGES_BEFORE_COMMIT) {
  void test(`T19: an owning cancel at ${cancelAt} discards deterministically`, async (t) => {
    const controller = new AbortController();
    const fixture = await makeFixture(t, (stage) => {
      if (stage === cancelAt) {
        controller.abort();
      }
    });
    const started = await fixture.host.start(
      startArgs(fixture, 'setInterval(() => {}, 1000);'),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }

    const claimed = await fixture.host.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
      yieldTimeMs: 0,
      signal: controller.signal,
    });
    // §4.2.1 — 커밋 전의 authoritative 취소는 "할 수 있다"가 아니라
    // 결정론적으로 discard다. 어느 쪽으로 끝나든 세션은 남지 않는다.
    assert.equal(claimed.ok, false);

    const listed = fixture.host.listSessions();
    assert.equal(
      listed.some((session) => session.outputRef === started.outputRef),
      false,
      'a cancelled claim must not leave a resident session',
    );
    await recoverCommandHostState({ stateRoot: fixture.stateRoot });
    assert.deepEqual(
      await sessionDirectoryEntries(fixture, started.outputRef),
      [],
    );
  });
}

void test('T19: a cancel after the commit point returns the committed claim', async (t) => {
  const controller = new AbortController();
  const fixture = await makeFixture(t, (stage) => {
    // 커밋점을 지난 직후에 취소가 도착한다.
    if (stage === 'claim.committed') {
      controller.abort();
    }
  });
  const started = await fixture.host.start(
    startArgs(fixture, 'setInterval(() => {}, 1000);'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  const claimed = await fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
    signal: controller.signal,
  });
  assert.equal(claimed.ok, true, 'the commit already happened');
  if (claimed.ok) {
    assert.equal(claimed.value.outputRef, started.outputRef);
  }
  const persisted = await readMetadata(fixture, started.outputRef);
  assert.equal(persisted?.outputRef, started.outputRef);
});

void test('T19: cancelling a non-owning waiter leaves the session untouched', async (t) => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await makeFixture(t, async (stage) => {
    // 커밋 직전에 claim을 붙들어, 두 번째 waiter가 합류할 창을 만든다.
    if (stage === 'claim.renamed') {
      await held;
    }
  });
  const started = await fixture.host.start(
    startArgs(fixture, 'setInterval(() => {}, 1000);'),
  );
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }

  const owner = fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  // 합류한 비소유 waiter를 취소한다 — 이 RPC만 끝나야 한다 (§4.2.1).
  const joiner = new AbortController();
  const joined = fixture.host.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
    signal: joiner.signal,
  });
  joiner.abort();
  const joinedResult = await joined;
  assert.equal(joinedResult.ok, false);
  if (!joinedResult.ok) {
    assert.equal(joinedResult.reasonCode, 'wait_aborted');
  }

  release?.();
  const ownerResult = await owner;
  assert.equal(ownerResult.ok, true, 'the owning claim is unaffected');
  if (ownerResult.ok) {
    assert.equal(ownerResult.value.outputRef, started.outputRef);
    assert.equal(ownerResult.value.status, 'running');
  }
});

// ---------------------------------------------------------------------------
// T9 — claim 선형화 경합: 각 지점에서 자식이 끝나도 terminal 이벤트가
//      유실되지 않고 허용 상태 하나로 수렴한다.
// ---------------------------------------------------------------------------

for (const killAt of CLAIM_STAGES_BEFORE_COMMIT) {
  void test(`T9: a child that dies at ${killAt} still lands a terminal snapshot`, async (t) => {
    let killer: (() => void) | undefined;
    const fixture = await makeFixture(t, async (stage) => {
      if (stage === killAt && killer !== undefined) {
        const kill = killer;
        killer = undefined;
        kill();
        // 종료 이벤트가 코어에 도달할 틈을 준다.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });
    const started = await fixture.host.start(
      startArgs(fixture, 'setInterval(() => {}, 1000);'),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    killer = () => {
      void fixture.host.interact({
        stateRoot: fixture.stateRoot,
        threadId: THREAD,
        outputRef: started.outputRef,
        terminate: true,
        yieldTimeMs: 0,
      });
    };

    const claimed = await fixture.host.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
      yieldTimeMs: 0,
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) {
      return;
    }

    // §4.2 — claiming 중 도착한 terminal은 유실되지 않고 승격된다. 관찰
    // 시점에 따라 running(아직 전달 전)이거나 종료 상태이고, 어느 쪽이든
    // 결국 하나의 terminal로 수렴해야 한다.
    for (;;) {
      const observed = await fixture.host.interact({
        stateRoot: fixture.stateRoot,
        threadId: THREAD,
        outputRef: started.outputRef,
        yieldTimeMs: 50,
      });
      assert.equal(observed.ok, true);
      if (!observed.ok) {
        return;
      }
      if (observed.value.snapshot.status !== 'running') {
        assert.equal(observed.value.snapshot.status, 'signal');
        assert.equal(
          observed.value.snapshot.terminationReason,
          'explicit_terminate',
        );
        break;
      }
    }

    // 그리고 그 terminal이 디스크에 내구화돼 있다.
    const persisted = await readMetadata(fixture, started.outputRef);
    assert.equal(persisted?.status, 'signal');
  });
}
