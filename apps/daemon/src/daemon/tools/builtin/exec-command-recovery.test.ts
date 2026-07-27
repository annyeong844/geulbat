import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type {
  CommandSessionListEntry,
  HostCommandRuntime,
} from '../../../command-host/contract.js';
import { removeCommandHostWorkspace } from '../../../test-support/command-host-workspace.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createDaemonContext } from '../../context.js';
import type { ToolExecutionContext } from '../types.js';
import { execCommandTool } from './exec-command.js';

interface ExecCommandTestArgs {
  cmd: string;
  cwd?: string;
  timeoutMs?: number;
  yieldTimeMs?: number;
  stdinMode?: 'closed' | 'open';
  maxOutputBytesPerStream?: number;
}

interface DurableExecFixture {
  stateRoot: string;
  context: ToolExecutionContext & {
    stateRoot: string;
    threadId: string;
    runId: string;
  };
  runtimeServices: ReturnType<typeof createDaemonContext>;
  registerRuntime(runtime: ReturnType<typeof createDaemonContext>): void;
}

void test('exec_command replacement daemon reattaches to the one surviving invocation session', async (t) => {
  const fixture = await createDurableExecFixture(t, 1_111);
  const commandArgs: ExecCommandTestArgs = {
    cmd: `node -e "process.stdout.write('original:' + process.pid); process.stdin.resume()"`,
    yieldTimeMs: 0,
    stdinMode: 'open',
  };
  let originalOutputRef: string | undefined;

  await interruptExecCommandAfterCheckpoint({
    toolArgs: commandArgs,
    context: fixture.context,
    runtimeServices: fixture.runtimeServices,
    delegateStart: fixture.runtimeServices.hostCommands.start,
    delegateWait: fixture.runtimeServices.hostCommands.waitForInitialResult,
    onStarted(outputRef) {
      originalOutputRef = outputRef;
    },
  });
  assert.match(originalOutputRef ?? '', /^command-output:/u);

  const disconnected = await fixture.runtimeServices.hostCommands.closeAll();
  assert.equal(disconnected.ok, true);
  const replacement = createExecRecoveryDaemonContext(fixture.stateRoot);
  fixture.registerRuntime(replacement);
  const recovered = await execCommandTool.execute(commandArgs, {
    ...fixture.context,
    runtimeServices: replacement,
  });

  assert.equal(recovered.ok, true, recovered.ok ? undefined : recovered.error);
  if (!recovered.ok) {
    return;
  }
  const output = JSON.parse(recovered.output) as {
    outputRef: string | null;
    status: string;
  };
  assert.equal(output.outputRef, originalOutputRef);
  assert.equal(output.status, 'running');
  const sessions = await replacement.hostCommands.listThreadSessions({
    stateRoot: fixture.stateRoot,
    threadId: fixture.context.threadId,
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.outputRef, originalOutputRef);
  const invocation = (
    await replacement.runCheckpoints.readThread(fixture.context.threadId)
  )?.toolInvocations[0];
  assert.equal(invocation?.status, 'reconciled');
  if (invocation?.status === 'reconciled') {
    assert.deepEqual(invocation.result, recovered);
  }
});

void test('exec_command restart recovery never starts a command when no surviving session exists', async (t) => {
  const fixture = await createDurableExecFixture(t, 1_112);
  const commandArgs: ExecCommandTestArgs = {
    cmd: `node -e "process.stdout.write('must-not-replay')"`,
  };
  await interruptExecCommandAfterCheckpoint({
    toolArgs: commandArgs,
    context: fixture.context,
    runtimeServices: fixture.runtimeServices,
  });
  let startCount = 0;
  const noSessionRuntime: HostCommandRuntime = {
    ...fixture.runtimeServices.hostCommands,
    async start() {
      startCount += 1;
      return {
        ok: false,
        reasonCode: 'spawn_failed',
        message: 'unexpected replay',
      };
    },
    async listThreadSessions() {
      return [];
    },
  };

  const recovered = await execCommandTool.execute(commandArgs, {
    ...fixture.context,
    runtimeServices: {
      ...fixture.runtimeServices,
      hostCommands: noSessionRuntime,
    },
  });

  assert.equal(startCount, 0);
  assert.equal(recovered.ok, false);
  if (!recovered.ok) {
    assert.equal(recovered.errorCode, 'execution_failed');
    assert.match(recovered.error, /outcome is unknown/u);
    assert.match(recovered.error, /was not replayed/u);
  }
});

void test('exec_command restart recovery fails closed when invocation identity matches multiple sessions', async (t) => {
  const fixture = await createDurableExecFixture(t, 1_113);
  const commandArgs: ExecCommandTestArgs = {
    cmd: `node -e "process.stdout.write('must-not-replay')"`,
  };
  await interruptExecCommandAfterCheckpoint({
    toolArgs: commandArgs,
    context: fixture.context,
    runtimeServices: fixture.runtimeServices,
  });
  let startCount = 0;
  const duplicateSessionRuntime: HostCommandRuntime = {
    ...fixture.runtimeServices.hostCommands,
    async start() {
      startCount += 1;
      return {
        ok: false,
        reasonCode: 'spawn_failed',
        message: 'unexpected replay',
      };
    },
    async listThreadSessions() {
      return [
        buildInvocationSession(fixture, 'duplicate-a'),
        buildInvocationSession(fixture, 'duplicate-b'),
      ];
    },
  };

  const recovered = await execCommandTool.execute(commandArgs, {
    ...fixture.context,
    runtimeServices: {
      ...fixture.runtimeServices,
      hostCommands: duplicateSessionRuntime,
    },
  });

  assert.equal(startCount, 0);
  assert.equal(recovered.ok, false);
  if (!recovered.ok) {
    assert.equal(recovered.errorCode, 'conflict');
    assert.match(recovered.error, /multiple surviving command sessions/u);
  }
});

void test('exec_command restart recovery rejects changed arguments without touching the worker', async (t) => {
  const fixture = await createDurableExecFixture(t, 1_114);
  await interruptExecCommandAfterCheckpoint({
    toolArgs: { cmd: `node -e "process.stdout.write('recorded')"` },
    context: fixture.context,
    runtimeServices: fixture.runtimeServices,
  });
  let listCount = 0;
  let startCount = 0;
  const guardedRuntime: HostCommandRuntime = {
    ...fixture.runtimeServices.hostCommands,
    async start() {
      startCount += 1;
      return {
        ok: false,
        reasonCode: 'spawn_failed',
        message: 'unexpected replay',
      };
    },
    async listThreadSessions() {
      listCount += 1;
      return [buildInvocationSession(fixture, 'must-not-be-read')];
    },
  };

  await assert.rejects(
    execCommandTool.execute(
      { cmd: `node -e "process.stdout.write('changed')"` },
      {
        ...fixture.context,
        runtimeServices: {
          ...fixture.runtimeServices,
          hostCommands: guardedRuntime,
        },
      },
    ),
    /exec_command recovery arguments conflict/u,
  );

  assert.equal(startCount, 0);
  assert.equal(listCount, 0);
  const invocation = (
    await fixture.runtimeServices.runCheckpoints.readThread(
      fixture.context.threadId,
    )
  )?.toolInvocations[0];
  assert.equal(invocation?.status, 'in_flight');
});

async function createDurableExecFixture(
  t: TestContext,
  contextId: number,
): Promise<DurableExecFixture> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-exec-recovery-'));
  const threadId = testThreadId(contextId);
  const runId = testRunId(contextId);
  const runtimeServices = createExecRecoveryDaemonContext(stateRoot);
  const runtimes = [runtimeServices];
  t.after(async () => {
    for (const runtime of runtimes) {
      await terminateThreadCommandSessions({
        runtime: runtime.hostCommands,
        stateRoot,
        threadId,
      });
      await runtime.hostCommands.closeAll();
    }
    await removeCommandHostWorkspace(stateRoot);
    await rm(stateRoot, { recursive: true, force: true });
  });
  await runtimeServices.runCheckpoints.startRun({
    threadId,
    runId,
    request: { workingDirectory: stateRoot, permissionMode: 'full_access' },
  });
  return {
    stateRoot,
    runtimeServices,
    registerRuntime(runtime) {
      runtimes.push(runtime);
    },
    context: {
      kind: 'agent',
      callId: `call-exec-command-recovery-${String(contextId)}`,
      signal: undefined,
      runSignal: undefined,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: true,
      computerSessionId: 'session-exec-command-recovery',
      computerFileRoot: stateRoot,
      permissionMode: 'full_access',
      stateRoot,
      threadId,
      runId,
      runOwnerKind: 'root_main',
      workingDirectory: stateRoot,
      runState: undefined,
      memoryIndex: runtimeServices.memoryIndex,
      runtimeServices,
      emitAgentEvent() {},
    },
  };
}

function createExecRecoveryDaemonContext(
  stateRoot: string,
): ReturnType<typeof createDaemonContext> {
  const previousRoot = process.env['GEULBAT_COMPUTER_SESSION_ROOT'];
  process.env['GEULBAT_COMPUTER_SESSION_ROOT'] = stateRoot;
  try {
    return createDaemonContext({
      homeStateRoot: stateRoot,
      hostCommands: { inlineMaxBytes: 128 },
    });
  } finally {
    if (previousRoot === undefined) {
      delete process.env['GEULBAT_COMPUTER_SESSION_ROOT'];
    } else {
      process.env['GEULBAT_COMPUTER_SESSION_ROOT'] = previousRoot;
    }
  }
}

async function interruptExecCommandAfterCheckpoint(args: {
  toolArgs: ExecCommandTestArgs;
  context: DurableExecFixture['context'];
  runtimeServices: ReturnType<typeof createDaemonContext>;
  delegateStart?: HostCommandRuntime['start'];
  delegateWait?: HostCommandRuntime['waitForInitialResult'];
  onStarted?: (outputRef: string) => void;
}): Promise<void> {
  const interruptedRuntime: HostCommandRuntime = {
    ...args.runtimeServices.hostCommands,
    async start(startArgs) {
      const invocation = (
        await args.runtimeServices.runCheckpoints.readThread(
          args.context.threadId,
        )
      )?.toolInvocations.find(
        (candidate) => candidate.callId === args.context.callId,
      );
      assert.equal(
        invocation?.status,
        'in_flight',
        'exec_command must checkpoint its invocation before host start',
      );
      if (args.delegateStart !== undefined) {
        const started = await args.delegateStart(startArgs);
        assert.equal(started.ok, true);
        if (started.ok) {
          args.onStarted?.(started.outputRef);
        }
        if (args.delegateWait !== undefined) {
          return started;
        }
      }
      throw new Error('simulated daemon loss after exec_command checkpoint');
    },
    async waitForInitialResult(waitArgs) {
      if (args.delegateWait === undefined) {
        return await args.runtimeServices.hostCommands.waitForInitialResult(
          waitArgs,
        );
      }
      const waited = await args.delegateWait(waitArgs);
      assert.equal(waited.ok, true);
      throw new Error('simulated daemon loss after exec_command session claim');
    },
  };
  await assert.rejects(
    execCommandTool.execute(args.toolArgs, {
      ...args.context,
      runtimeServices: {
        ...args.runtimeServices,
        hostCommands: interruptedRuntime,
      },
    }),
    /simulated daemon loss/u,
  );
}

function buildInvocationSession(
  fixture: DurableExecFixture,
  suffix: string,
): CommandSessionListEntry & { runId: string; callId: string } {
  return {
    outputRef: `command-output:${fixture.context.threadId}:${suffix}`,
    threadId: fixture.context.threadId,
    stateRoot: fixture.stateRoot,
    runId: fixture.context.runId,
    callId: fixture.context.callId,
    running: true,
    revision: 0,
    command: 'redacted test command',
    status: 'running',
    startedAtMs: Date.now(),
    stdoutBytes: 0,
    stderrBytes: 0,
    stdinOpen: false,
  };
}

async function terminateThreadCommandSessions(args: {
  runtime: HostCommandRuntime;
  stateRoot: string;
  threadId: string;
}): Promise<void> {
  const sessions = await args.runtime.listThreadSessions({
    stateRoot: args.stateRoot,
    threadId: args.threadId,
  });
  for (const session of sessions) {
    await args.runtime.interact({
      stateRoot: args.stateRoot,
      threadId: args.threadId,
      outputRef: session.outputRef,
      terminate: true,
      yieldTimeMs: 0,
    });
  }
}
