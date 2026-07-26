import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { removeCommandHostWorkspace } from '../../../test-support/command-host-workspace.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createDaemonContext, type DaemonContext } from '../../context.js';
import { listCommandsTool } from './list-commands.js';

// P7.5 §12 — 압축이 outputRef를 지워도 돌고 있는 명령에 다시 닿을 수 있어야
// 한다. 이 도구가 그 유일한 경로다.

interface Listed {
  sessions: Array<{
    outputRef: string;
    command: string;
    status: string;
    running: boolean;
    stdinOpen: boolean;
    runningForMs: number;
    stdoutBytes: number;
  }>;
}

async function makeFixture(t: {
  after(fn: () => Promise<void> | void): void;
}): Promise<{ context: DaemonContext; stateRoot: string }> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-list-commands-'));
  const context = createDaemonContext({
    hostCommands: { inlineMaxBytes: 128 },
  });
  t.after(async () => {
    await context.hostCommands.closeAll();
    await removeCommandHostWorkspace(stateRoot);
  });
  return { context, stateRoot };
}

async function settle(
  context: DaemonContext,
  target: {
    stateRoot: string;
    threadId: ReturnType<typeof testThreadId>;
    outputRef: string;
  },
): Promise<void> {
  await context.hostCommands.interact({
    ...target,
    terminate: true,
    yieldTimeMs: 0,
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = await context.hostCommands.interact({
      ...target,
      yieldTimeMs: 50,
    });
    if (!observed.ok || observed.value.snapshot.status !== 'running') {
      return;
    }
  }
}

async function listFor(
  context: DaemonContext,
  stateRoot: string,
  thread: ReturnType<typeof testThreadId>,
): Promise<Listed> {
  const result = await listCommandsTool.execute(
    {},
    {
      callId: 'call-list-commands',
      stateRoot,
      threadId: thread,
      runtimeServices: context,
    },
  );
  if (!result.ok) {
    throw new Error(result.error ?? 'list_commands failed');
  }
  return JSON.parse(result.output) as Listed;
}

void test('list_commands recovers a running session whose ref left the view', async (t) => {
  const fixture = await makeFixture(t);
  const owner = testThreadId(2_001);
  const started = await fixture.context.hostCommands.start({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('up'); setInterval(() => {}, 1000);"],
    cwd: fixture.stateRoot,
    env: process.env,
    stateRoot: fixture.stateRoot,
    threadId: owner,
    runId: 'run-list',
    callId: 'call-list',
    stdinMode: 'open',
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  t.after(async () => {
    await settle(fixture.context, {
      stateRoot: fixture.stateRoot,
      threadId: owner,
      outputRef: started.outputRef,
    });
  });
  await fixture.context.hostCommands.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });

  // 모델이 ref를 잃어도(압축) 이 목록이 그것을 되돌려준다.
  const listed = await listFor(fixture.context, fixture.stateRoot, owner);
  assert.equal(listed.sessions.length, 1);
  const session = listed.sessions[0];
  assert.equal(session?.outputRef, started.outputRef);
  assert.equal(session?.running, true);
  assert.equal(session?.status, 'running');
  assert.equal(session?.stdinOpen, true, 'the writable session is marked open');
  assert.match(
    session?.command ?? '',
    /-e/u,
    'the listing says what is running',
  );
  assert.ok((session?.runningForMs ?? -1) >= 0);
});

void test('list_commands never shows another thread its sessions', async (t) => {
  const fixture = await makeFixture(t);
  const owner = testThreadId(2_002);
  const stranger = testThreadId(2_003);
  const started = await fixture.context.hostCommands.start({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000);'],
    cwd: fixture.stateRoot,
    env: process.env,
    stateRoot: fixture.stateRoot,
    threadId: owner,
    runId: 'run-list',
    callId: 'call-list',
    stdinMode: 'closed',
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  t.after(async () => {
    await settle(fixture.context, {
      stateRoot: fixture.stateRoot,
      threadId: owner,
      outputRef: started.outputRef,
    });
  });
  await fixture.context.hostCommands.waitForInitialResult({
    stateRoot: fixture.stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });

  assert.equal(
    (await listFor(fixture.context, fixture.stateRoot, owner)).sessions.length,
    1,
  );
  // §13 비목표 — 세션은 스레드 간에 공유되지 않는다.
  assert.deepEqual(
    (await listFor(fixture.context, fixture.stateRoot, stranger)).sessions,
    [],
  );
});

void test('list_commands is empty for a thread that started nothing', async (t) => {
  const fixture = await makeFixture(t);
  const listed = await listFor(
    fixture.context,
    fixture.stateRoot,
    testThreadId(2_004),
  );
  assert.deepEqual(listed.sessions, []);
});
