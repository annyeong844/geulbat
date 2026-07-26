import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDaemonHostCommandRuntime,
  type CommandHostMode,
} from './runtime-selection.js';
import { removeCommandHostWorkspace } from '../test-support/command-host-workspace.js';
import type { HostCommandRuntime } from './contract.js';
import type { HostCommandSnapshot } from '../daemon/host-command-output-store.js';

// P7.5 spec v4 §14 수용기준 7 — "inline/worker 동일 스위트 통과(수명 분리
// 제외)". 같은 시나리오를 두 배치로 각각 돌려, 도구가 보는 계약이 배치와
// 무관하다는 것을 증거로 만든다. 수명(워커가 데몬보다 오래 사는 성질)은
// 정의상 배치별로 다르므로 여기서 다루지 않는다 — worker-server.test.ts의
// 생존 테스트가 그 몫이다.

const MODES: CommandHostMode[] = ['inline', 'worker'];
const THREAD = 'thread-equivalence';

interface Fixture {
  runtime: HostCommandRuntime;
  stateRoot: string;
}

async function makeFixture(
  t: { after(fn: () => Promise<void> | void): void },
  mode: CommandHostMode,
): Promise<Fixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), `geulbat-equiv-${mode}-`));
  const runtime = createDaemonHostCommandRuntime({
    config: { inlineMaxBytes: 1024, tailRingBytes: 4096 },
    requestedMode: mode,
  });
  t.after(async () => {
    await runtime.closeAll();
    await removeCommandHostWorkspace(stateRoot);
  });
  return { runtime, stateRoot };
}

function startArgs(
  fixture: Fixture,
  code: string,
  extra: Partial<Parameters<HostCommandRuntime['start']>[0]> = {},
): Parameters<HostCommandRuntime['start']>[0] {
  return {
    executable: process.execPath,
    args: ['-e', code],
    cwd: fixture.stateRoot,
    env: process.env,
    stateRoot: fixture.stateRoot,
    threadId: THREAD,
    runId: 'run-equivalence',
    callId: 'call-equivalence',
    stdinMode: 'closed',
    ...extra,
  };
}

async function pollUntilTerminal(
  fixture: Fixture,
  outputRef: string,
  page?: {
    stream: 'stdout' | 'stderr';
    offsetBytes: number;
    limitBytes: number;
  },
): Promise<{ snapshot: HostCommandSnapshot; content: string | null }> {
  for (;;) {
    const observed = await fixture.runtime.interact({
      stateRoot: fixture.stateRoot,
      threadId: THREAD,
      outputRef,
      yieldTimeMs: 20,
      ...(page === undefined ? {} : { page }),
    });
    if (!observed.ok) {
      throw new Error(
        `interact failed: ${observed.reasonCode} ${observed.message}`,
      );
    }
    if (observed.value.snapshot.status !== 'running') {
      return {
        snapshot: observed.value.snapshot,
        content: observed.value.page?.content ?? null,
      };
    }
  }
}

for (const mode of MODES) {
  void test(`[${mode}] a small terminal result comes back inline with no ref`, async (t) => {
    const fixture = await makeFixture(t, mode);
    const started = await fixture.runtime.start(
      startArgs(fixture, 'process.stdout.write("hello");'),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    const claimed = await fixture.runtime.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
    });
    assert.equal(claimed.ok, true);
    if (claimed.ok) {
      assert.equal(claimed.value.stdout, 'hello');
      assert.equal(claimed.value.status, 'exit');
      assert.equal(claimed.value.exitCode, 0);
      // 인라인으로 전부 돌려줬으므로 나중에 찾아갈 ref가 없다 (§4.2).
      assert.equal(claimed.value.outputRef, null);
    }
  });

  void test(`[${mode}] exact-marker redaction happens before any output is surfaced`, async (t) => {
    const fixture = await makeFixture(t, mode);
    const marker = `private-marker-${mode}-split-across-writes`;
    const replacement = '[redacted:worker-boundary]';
    const started = await fixture.runtime.start(
      startArgs(
        fixture,
        [
          `const marker = ${JSON.stringify(marker)};`,
          'process.stdout.write(marker.slice(0, 11));',
          'setTimeout(() => {',
          '  process.stdout.write(marker.slice(11));',
          '  process.stderr.write(marker);',
          '}, 20);',
          'setTimeout(() => process.exit(0), 50);',
        ].join(''),
        {
          outputRedaction: {
            exactMarkers: [marker],
            replacement,
          },
        },
      ),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    const claimed = await fixture.runtime.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) {
      return;
    }
    assert.equal(claimed.value.stdout, replacement);
    assert.equal(claimed.value.stderr, replacement);
    assert.doesNotMatch(claimed.value.stdout ?? '', new RegExp(marker, 'u'));
    assert.doesNotMatch(claimed.value.stderr ?? '', new RegExp(marker, 'u'));
  });

  void test(`[${mode}] a large result claims a durable ref and pages exactly`, async (t) => {
    const fixture = await makeFixture(t, mode);
    const started = await fixture.runtime.start(
      startArgs(fixture, 'process.stdout.write("x".repeat(3000));'),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    const claimed = await fixture.runtime.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
    });
    assert.equal(claimed.ok, true);
    if (!claimed.ok) {
      return;
    }
    assert.equal(claimed.value.outputRef, started.outputRef);
    assert.equal(claimed.value.stdout, null, 'too large to inline');
    assert.equal(claimed.value.stdoutBytes, 3000);

    const page = await fixture.runtime.interact({
      stateRoot: fixture.stateRoot,
      threadId: THREAD,
      outputRef: started.outputRef,
      page: { stream: 'stdout', offsetBytes: 10, limitBytes: 16 },
    });
    assert.equal(page.ok, true);
    if (page.ok) {
      assert.equal(page.value.page?.content, 'x'.repeat(16));
      assert.equal(page.value.page?.offsetBytes, 10);
    }
  });

  void test(`[${mode}] a non-zero exit is a command status, not a tool failure`, async (t) => {
    const fixture = await makeFixture(t, mode);
    const started = await fixture.runtime.start(
      startArgs(fixture, 'process.stderr.write("nope"); process.exit(3);'),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    const claimed = await fixture.runtime.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
    });
    assert.equal(claimed.ok, true);
    if (claimed.ok) {
      assert.equal(claimed.value.status, 'exit');
      assert.equal(claimed.value.exitCode, 3);
      assert.equal(claimed.value.stderr, 'nope');
    }
  });

  void test(`[${mode}] stdin round-trips and closeStdin ends the session`, async (t) => {
    const fixture = await makeFixture(t, mode);
    const started = await fixture.runtime.start(
      startArgs(
        fixture,
        'process.stdin.on("data", (d) => process.stdout.write("got:" + d)); process.stdin.on("end", () => process.exit(0));',
        { stdinMode: 'open' },
      ),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    const claimed = await fixture.runtime.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
      yieldTimeMs: 0,
    });
    assert.equal(claimed.ok, true);

    const wrote = await fixture.runtime.interact({
      stateRoot: fixture.stateRoot,
      threadId: THREAD,
      outputRef: started.outputRef,
      chars: 'ping',
      yieldTimeMs: 200,
    });
    assert.equal(wrote.ok, true);

    const closed = await fixture.runtime.interact({
      stateRoot: fixture.stateRoot,
      threadId: THREAD,
      outputRef: started.outputRef,
      closeStdin: true,
      yieldTimeMs: 0,
    });
    assert.equal(closed.ok, true);

    const final = await pollUntilTerminal(fixture, started.outputRef, {
      stream: 'stdout',
      offsetBytes: 0,
      limitBytes: 64,
    });
    assert.equal(final.snapshot.status, 'exit');
    assert.equal(final.content, 'got:ping');
  });

  void test(`[${mode}] terminate uses the graceful path with an explicit reason`, async (t) => {
    const fixture = await makeFixture(t, mode);
    const started = await fixture.runtime.start(
      startArgs(fixture, 'setInterval(() => {}, 1000);'),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await fixture.runtime.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
      yieldTimeMs: 0,
    });
    const terminated = await fixture.runtime.interact({
      stateRoot: fixture.stateRoot,
      threadId: THREAD,
      outputRef: started.outputRef,
      terminate: true,
      yieldTimeMs: 0,
    });
    assert.equal(terminated.ok, true);

    const final = await pollUntilTerminal(fixture, started.outputRef);
    assert.equal(final.snapshot.status, 'signal');
    assert.equal(final.snapshot.terminationReason, 'explicit_terminate');
  });

  void test(`[${mode}] a caller output cap stops the process`, async (t) => {
    const fixture = await makeFixture(t, mode);
    const started = await fixture.runtime.start(
      startArgs(
        fixture,
        'setInterval(() => process.stdout.write("y".repeat(1000)), 1);',
        { maxOutputBytesPerStream: 4000 },
      ),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    const claimed = await fixture.runtime.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
    });
    assert.equal(claimed.ok, true);
    if (claimed.ok) {
      assert.equal(claimed.value.status, 'output_limit_exceeded');
      assert.equal(claimed.value.terminationReason, 'caller_output_limit');
      assert.equal(
        claimed.value.outputLimitExceeded?.maxOutputBytesPerStream,
        4000,
      );
    }
  });

  void test(`[${mode}] a caller timeout kills without a grace window`, async (t) => {
    const fixture = await makeFixture(t, mode);
    const started = await fixture.runtime.start(
      startArgs(fixture, 'setInterval(() => {}, 1000);', { timeoutMs: 120 }),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    const claimed = await fixture.runtime.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
    });
    assert.equal(claimed.ok, true);
    if (claimed.ok) {
      assert.equal(claimed.value.status, 'timeout');
      assert.equal(claimed.value.terminationReason, 'caller_timeout');
    }
  });

  void test(`[${mode}] another thread cannot reach this thread's output`, async (t) => {
    const fixture = await makeFixture(t, mode);
    const started = await fixture.runtime.start(
      startArgs(fixture, 'process.stdout.write("z".repeat(3000));'),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await fixture.runtime.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
    });

    const trespass = await fixture.runtime.interact({
      stateRoot: fixture.stateRoot,
      threadId: 'thread-someone-else',
      outputRef: started.outputRef,
      page: { stream: 'stdout', offsetBytes: 0, limitBytes: 8 },
    });
    assert.equal(trespass.ok, false);
    if (!trespass.ok) {
      assert.equal(trespass.reasonCode, 'access_denied');
    }
  });

  void test(`[${mode}] a page larger than the inline budget is refused`, async (t) => {
    const fixture = await makeFixture(t, mode);
    const started = await fixture.runtime.start(
      startArgs(fixture, 'process.stdout.write("q".repeat(3000));'),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await fixture.runtime.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
    });

    const oversized = await fixture.runtime.interact({
      stateRoot: fixture.stateRoot,
      threadId: THREAD,
      outputRef: started.outputRef,
      page: { stream: 'stdout', offsetBytes: 0, limitBytes: 4096 },
    });
    assert.equal(oversized.ok, false);
    if (!oversized.ok) {
      assert.equal(oversized.reasonCode, 'invalid_args');
    }
  });

  void test(`[${mode}] streamed output reaches the caller's onOutput`, async (t) => {
    const fixture = await makeFixture(t, mode);
    const seen: string[] = [];
    const started = await fixture.runtime.start(
      startArgs(
        fixture,
        'process.stdout.write("early"); setTimeout(() => process.stdout.write("x".repeat(3000)), 30);',
        {
          onOutput: ({ text }) => {
            seen.push(text);
          },
        },
      ),
    );
    assert.equal(started.ok, true);
    if (!started.ok) {
      return;
    }
    await fixture.runtime.waitForInitialResult({
      stateRoot: fixture.stateRoot,
      outputRef: started.outputRef,
    });
    assert.ok(
      seen.join('').includes('early'),
      `streamed output must reach the caller, saw ${JSON.stringify(seen)}`,
    );
  });
}
