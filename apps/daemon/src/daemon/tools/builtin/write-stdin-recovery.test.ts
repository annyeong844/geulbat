import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { HostCommandRuntime } from '../../../command-host/contract.js';
import { removeCommandHostWorkspace } from '../../../test-support/command-host-workspace.js';
import { testRunId } from '../../../test-support/run-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { createDaemonContext } from '../../context.js';
import type { ToolExecutionContext } from '../types.js';
import { writeStdinTool } from './write-stdin.js';

interface DurableWriteStdinFixture {
  stateRoot: string;
  context: ToolExecutionContext & {
    stateRoot: string;
    threadId: string;
    runId: string;
  };
  runtimeServices: ReturnType<typeof createDaemonContext>;
  registerRuntime(runtime: ReturnType<typeof createDaemonContext>): void;
}

void test('replacement daemon does not apply a durable write_stdin effect twice to the surviving command session', async (t) => {
  const fixture = await createDurableWriteStdinFixture(t, 821);
  const started = await fixture.runtimeServices.hostCommands.start({
    executable: process.execPath,
    args: [
      '-e',
      "const hold = setInterval(() => {}, 1000); process.stdout.write('ready;'); process.stdin.on('data', chunk => process.stdout.write('got:' + chunk)); process.stdin.on('end', () => { clearInterval(hold); process.exit(0); })",
    ],
    cwd: fixture.stateRoot,
    env: process.env,
    stateRoot: fixture.stateRoot,
    threadId: fixture.context.threadId,
    runId: fixture.context.runId,
    callId: 'call-write-stdin-target-command',
    stdinMode: 'open',
  });
  assert.equal(started.ok, true, started.ok ? undefined : started.message);
  if (!started.ok) {
    return;
  }
  const outputRef = started.outputRef;
  const ready = await fixture.runtimeServices.hostCommands.waitForInitialResult(
    {
      stateRoot: fixture.stateRoot,
      outputRef,
      yieldTimeMs: 1_000,
    },
  );
  assert.equal(ready.ok, true, ready.ok ? undefined : ready.message);
  if (!ready.ok) {
    return;
  }
  assert.equal(ready.value.status, 'running');
  assert.equal(ready.value.stdinOpen, true);
  assert.equal(ready.value.stdout, 'ready;');
  let effectApplied = false;
  const interruptedHostCommands: HostCommandRuntime = {
    ...fixture.runtimeServices.hostCommands,
    interact: async (args) => {
      const result = await fixture.runtimeServices.hostCommands.interact(args);
      if (args.chars === 'ping' && result.ok) {
        effectApplied = true;
      }
      return result;
    },
  };

  await assert.rejects(
    writeStdinTool.execute(
      {
        outputRef,
        chars: 'ping',
        yieldTimeMs: 0,
      },
      {
        ...fixture.context,
        runtimeServices: {
          ...fixture.runtimeServices,
          hostCommands: interruptedHostCommands,
          runCheckpoints: {
            ...fixture.runtimeServices.runCheckpoints,
            recordToolInvocationResult: async () => {
              assert.equal(effectApplied, true);
              throw new Error('simulated daemon loss after write_stdin effect');
            },
          },
        },
      },
    ),
    /simulated daemon loss after write_stdin effect/u,
  );

  const pending = (
    await fixture.runtimeServices.runCheckpoints.readThread(
      fixture.context.threadId,
    )
  )?.toolInvocations.find(
    (candidate) => candidate.callId === fixture.context.callId,
  );
  assert.equal(pending?.status, 'in_flight');
  const firstSessions =
    await fixture.runtimeServices.hostCommands.listThreadSessions({
      stateRoot: fixture.stateRoot,
      threadId: fixture.context.threadId,
    });
  assert.equal(firstSessions.length, 1);
  assert.equal(firstSessions[0]?.outputRef, outputRef);
  assert.equal(firstSessions[0]?.running, true);
  assert.equal(firstSessions[0]?.stdinOpen, true);

  const disconnected = await fixture.runtimeServices.hostCommands.closeAll();
  assert.equal(
    disconnected.ok,
    true,
    disconnected.ok ? undefined : disconnected.message,
  );
  const replacement = createRecoveryDaemonContext(fixture.stateRoot);
  fixture.registerRuntime(replacement);
  const replacementSessions = await replacement.hostCommands.listThreadSessions(
    {
      stateRoot: fixture.stateRoot,
      threadId: fixture.context.threadId,
    },
  );
  assert.equal(replacementSessions.length, 1);
  assert.equal(replacementSessions[0]?.outputRef, outputRef);
  assert.equal(replacementSessions[0]?.running, true);
  assert.equal(replacementSessions[0]?.stdinOpen, true);
  const recovered = await writeStdinTool.execute(
    {
      outputRef,
      chars: 'ping',
      yieldTimeMs: 0,
    },
    {
      ...fixture.context,
      runtimeServices: replacement,
    },
  );
  assert.equal(recovered.ok, true, recovered.ok ? undefined : recovered.error);

  const closed = await replacement.hostCommands.interact({
    stateRoot: fixture.stateRoot,
    threadId: fixture.context.threadId,
    outputRef,
    closeStdin: true,
    yieldTimeMs: 1_000,
  });
  assert.equal(closed.ok, true, closed.ok ? undefined : closed.message);

  const page = await replacement.hostCommands.interact({
    stateRoot: fixture.stateRoot,
    threadId: fixture.context.threadId,
    outputRef,
    page: {
      stream: 'stdout',
      offsetBytes: 0,
      limitBytes: 128,
    },
    yieldTimeMs: 0,
  });
  assert.equal(page.ok, true, page.ok ? undefined : page.message);
  if (!page.ok) {
    return;
  }
  assert.equal(page.value.page?.content, 'ready;got:ping');

  const reconciled = (
    await replacement.runCheckpoints.readThread(fixture.context.threadId)
  )?.toolInvocations.find(
    (candidate) => candidate.callId === fixture.context.callId,
  );
  assert.equal(reconciled?.status, 'reconciled');
  if (reconciled?.status === 'reconciled') {
    assert.deepEqual(reconciled.result, recovered);
  }

  let replayInteractionCount = 0;
  const replayed = await writeStdinTool.execute(
    {
      outputRef,
      chars: 'ping',
      yieldTimeMs: 0,
    },
    {
      ...fixture.context,
      runtimeServices: {
        ...replacement,
        hostCommands: {
          ...replacement.hostCommands,
          async interact() {
            replayInteractionCount += 1;
            throw new Error('reconciled replay touched the command worker');
          },
        },
      },
    },
  );
  assert.equal(replayInteractionCount, 0);
  assert.deepEqual(replayed, recovered);
});

void test('write_stdin replacement recovery rejects changed arguments before touching the worker', async (t) => {
  const fixture = await createDurableWriteStdinFixture(t, 822);
  const started = await fixture.runtimeServices.hostCommands.start({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: fixture.stateRoot,
    env: process.env,
    stateRoot: fixture.stateRoot,
    threadId: fixture.context.threadId,
    runId: fixture.context.runId,
    callId: 'call-write-stdin-args-target',
    stdinMode: 'open',
  });
  assert.equal(started.ok, true, started.ok ? undefined : started.message);
  if (!started.ok) {
    return;
  }

  const interruptedHostCommands: HostCommandRuntime = {
    ...fixture.runtimeServices.hostCommands,
    interact: async (args) => {
      if (args.chars === 'recorded') {
        const invocation = (
          await fixture.runtimeServices.runCheckpoints.readThread(
            fixture.context.threadId,
          )
        )?.toolInvocations.find(
          (candidate) => candidate.callId === fixture.context.callId,
        );
        assert.equal(
          invocation?.status,
          'in_flight',
          'write_stdin must checkpoint before crossing the worker effect boundary',
        );
        throw new Error('simulated daemon loss before write_stdin effect');
      }
      return await fixture.runtimeServices.hostCommands.interact(args);
    },
  };
  await assert.rejects(
    writeStdinTool.execute(
      {
        outputRef: started.outputRef,
        chars: 'recorded',
        yieldTimeMs: 0,
      },
      {
        ...fixture.context,
        runtimeServices: {
          ...fixture.runtimeServices,
          hostCommands: interruptedHostCommands,
        },
      },
    ),
    /simulated daemon loss before write_stdin effect/u,
  );

  const pending = (
    await fixture.runtimeServices.runCheckpoints.readThread(
      fixture.context.threadId,
    )
  )?.toolInvocations.find(
    (candidate) => candidate.callId === fixture.context.callId,
  );
  assert.equal(pending?.status, 'in_flight');
  assert.equal(
    JSON.stringify(pending?.recoveryState).includes('recorded'),
    false,
  );

  const disconnected = await fixture.runtimeServices.hostCommands.closeAll();
  assert.equal(
    disconnected.ok,
    true,
    disconnected.ok ? undefined : disconnected.message,
  );
  const replacement = createRecoveryDaemonContext(fixture.stateRoot);
  fixture.registerRuntime(replacement);
  let interactionCount = 0;
  const guardedHostCommands: HostCommandRuntime = {
    ...replacement.hostCommands,
    async interact(args) {
      interactionCount += 1;
      return await replacement.hostCommands.interact(args);
    },
  };
  await assert.rejects(
    writeStdinTool.execute(
      {
        outputRef: started.outputRef,
        chars: 'changed',
        yieldTimeMs: 0,
      },
      {
        ...fixture.context,
        runtimeServices: {
          ...replacement,
          hostCommands: guardedHostCommands,
        },
      },
    ),
    /write_stdin recovery arguments conflict/u,
  );
  assert.equal(interactionCount, 0);
});

async function createDurableWriteStdinFixture(
  t: TestContext,
  contextId: number,
): Promise<DurableWriteStdinFixture> {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-write-stdin-recovery-'),
  );
  const threadId = testThreadId(contextId);
  const runId = testRunId(contextId);
  const runtimeServices = createRecoveryDaemonContext(stateRoot);
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
      callId: `call-write-stdin-recovery-${String(contextId)}`,
      signal: undefined,
      runSignal: undefined,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: true,
      computerSessionId: 'session-write-stdin-recovery',
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

function createRecoveryDaemonContext(
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
