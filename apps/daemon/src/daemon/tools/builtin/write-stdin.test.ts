import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { testThreadId } from '../../../test-support/thread-id.js';
import { createDaemonContext, type DaemonContext } from '../../context.js';
import { isToolObjectParameters } from '../types.js';
import { writeStdinTool } from './write-stdin.js';

void test('write_stdin exposes an approval-free thread-bound continuation schema', () => {
  assert.equal(writeStdinTool.name, 'write_stdin');
  assert.equal(writeStdinTool.sideEffectLevel, 'destructive');
  assert.equal(writeStdinTool.mayMutateComputerFiles, true);
  assert.equal(writeStdinTool.requiresApproval, false);
  assert.ok(isToolObjectParameters(writeStdinTool.parameters));
  assert.deepEqual(writeStdinTool.parameters.required, ['outputRef']);
  assert.deepEqual(Object.keys(writeStdinTool.parameters.properties), [
    'outputRef',
    'chars',
    'closeStdin',
    'terminate',
    'afterRevision',
    'yieldTimeMs',
    'stream',
    'offsetBytes',
    'limitBytes',
  ]);
  assert.match(writeStdinTool.description, /never starts a new command/u);
  assert.match(writeStdinTool.description, /does not allocate a PTY/u);
});

void test('write_stdin validates mutually exclusive actions and page shape', async (t) => {
  const daemonContext = createDaemonContext();
  t.after(() => daemonContext.hostCommands.closeAll());
  const context = {
    callId: 'call-write-stdin-validation',
    stateRoot: '/tmp',
    threadId: testThreadId(1_001),
    runtimeServices: daemonContext,
  };
  const invalidActions = await writeStdinTool.execute(
    {
      outputRef: 'command-output:thread/00000000-0000-0000-0000-000000000000',
      closeStdin: true,
      terminate: true,
    },
    context,
  );
  assert.equal(invalidActions.ok, false);
  assert.equal(invalidActions.errorCode, 'invalid_args');

  const invalidPage = await writeStdinTool.execute(
    {
      outputRef: 'command-output:thread/00000000-0000-0000-0000-000000000000',
      stream: 'stdout',
    },
    context,
  );
  assert.equal(invalidPage.ok, false);
  assert.equal(invalidPage.errorCode, 'invalid_args');

  const undersizedPage = await writeStdinTool.execute(
    {
      outputRef: 'command-output:thread/00000000-0000-0000-0000-000000000000',
      stream: 'stdout',
      limitBytes: 3,
    },
    context,
  );
  assert.equal(undersizedPage.ok, false);
  assert.equal(undersizedPage.errorCode, 'invalid_args');
});

/**
 * 워커 배치에서 `closeAll`은 disconnect다 — 세션이 호출자보다 오래 사는 것이
 * 그 계층의 존재 이유이므로, 테스트가 작업공간을 지우기 전에 자기가 시작한
 * 세션을 끝내고 **내구화가 끝날 때까지** 기다려야 한다. 안 그러면 워커가
 * 산출물을 쓰는 동안 디렉터리가 사라진다.
 */
async function settleHostCommand(
  hostCommands: DaemonContext['hostCommands'],
  target: { stateRoot: string; threadId: string; outputRef: string },
  options: { terminate?: boolean } = {},
): Promise<void> {
  if (options.terminate === true) {
    await hostCommands.interact({ ...target, terminate: true, yieldTimeMs: 0 });
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // terminal 스냅샷은 내구화 배리어 뒤에서만 관찰된다 — 이 호출이
    // 돌아왔다는 것이 곧 산출물이 디스크에 앉았다는 뜻이다.
    const observed = await hostCommands.interact({
      ...target,
      yieldTimeMs: 50,
    });
    if (!observed.ok || observed.value.snapshot.status !== 'running') {
      return;
    }
  }
}

void test('write_stdin polls and pages the exact yielded host command', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-stdin-'));
  const threadId = testThreadId(1_003);
  // host command core는 컨텍스트 config로 구성한다 (인스턴스 주입 금지).
  const daemonContext = createDaemonContext({
    hostCommands: { inlineMaxBytes: 128 },
  });
  const hostCommands = daemonContext.hostCommands;
  let pendingRef: string | undefined;
  t.after(async () => {
    if (pendingRef !== undefined) {
      await settleHostCommand(hostCommands, {
        stateRoot,
        threadId,
        outputRef: pendingRef,
      });
    }
    await hostCommands.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });
  const started = await hostCommands.start({
    executable: process.execPath,
    args: ['-e', "setTimeout(() => process.stdout.write('done'), 40)"],
    cwd: stateRoot,
    env: process.env,
    stateRoot,
    threadId,
    runId: 'run-write-stdin-test',
    callId: 'call-exec-command-test',
    stdinMode: 'closed',
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  pendingRef = started.outputRef;
  const yielded = await hostCommands.waitForInitialResult({
    stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(yielded.ok, true);
  if (!yielded.ok) {
    return;
  }

  const observed = await writeStdinTool.execute(
    {
      outputRef: started.outputRef,
      afterRevision: yielded.value.revision,
      yieldTimeMs: 2_000,
      stream: 'stdout',
      offsetBytes: 0,
      limitBytes: 64,
    },
    {
      callId: 'call-write-stdin-test',
      stateRoot,
      threadId,
      runtimeServices: daemonContext,
    },
  );

  assert.equal(observed.ok, true);
  if (!observed.ok) {
    return;
  }
  const output = JSON.parse(observed.output) as {
    snapshot: { outputRef: string; status: string };
    page: { content: string };
  };
  assert.equal(output.snapshot.outputRef, started.outputRef);
  assert.equal(output.page.content, 'done');
  assert.ok(
    output.snapshot.status === 'running' || output.snapshot.status === 'exit',
  );
});

void test('write_stdin rejects a continuation reference owned by another thread', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-write-stdin-'));
  const ownerThreadId = testThreadId(1_004);
  // host command core는 컨텍스트 config로 구성한다 (인스턴스 주입 금지).
  const daemonContext = createDaemonContext({
    hostCommands: { inlineMaxBytes: 128 },
  });
  const hostCommands = daemonContext.hostCommands;
  let endlessRef: string | undefined;
  t.after(async () => {
    // 워커 배치에서 closeAll은 disconnect다 — 세션이 데몬보다 오래 사는
    // 것이 이 계층의 존재 이유이므로, 끝나지 않는 명령을 시작한 쪽이
    // 직접 끝내야 한다. 안 그러면 워커와 자식이 테스트를 넘어 살아남는다.
    if (endlessRef !== undefined) {
      await settleHostCommand(
        hostCommands,
        { stateRoot, threadId: ownerThreadId, outputRef: endlessRef },
        { terminate: true },
      );
    }
    await hostCommands.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });
  const started = await hostCommands.start({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: stateRoot,
    env: process.env,
    stateRoot,
    threadId: ownerThreadId,
    runId: 'run-write-stdin-test',
    callId: 'call-exec-command-test',
    stdinMode: 'closed',
  });
  assert.equal(started.ok, true);
  if (!started.ok) {
    return;
  }
  endlessRef = started.outputRef;
  const yielded = await hostCommands.waitForInitialResult({
    stateRoot,
    outputRef: started.outputRef,
    yieldTimeMs: 0,
  });
  assert.equal(yielded.ok, true);

  const result = await writeStdinTool.execute(
    { outputRef: started.outputRef, yieldTimeMs: 0 },
    {
      callId: 'call-write-stdin-test',
      stateRoot,
      threadId: testThreadId(1_005),
      runtimeServices: daemonContext,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'access_denied');
});
