import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPtcSessionDockerCommandFixture } from '../../../../test-support/ptc-session-docker.js';
import { testThreadId } from '../../../../test-support/thread-id.js';
import { makeRunContext } from '../../../../test-support/run-context.js';
import { createPtcExecuteCodeRuntime } from './execute-code-runtime.js';
import { createPtcSessionDockerLocalBatchCommandPolicy } from '../../lab/session/session-docker-contract.js';
import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
} from '../../shared/process-command.js';

const TEST_RUNNING_CELL_REAP_AFTER_MS = 600_000;

function makeTestCellConfig(initialYieldTimeMs: number) {
  return {
    enabled: true,
    initialYieldTimeMs,
    runningCellReapAfterMs: TEST_RUNNING_CELL_REAP_AFTER_MS,
  } as const;
}

void test('createPtcExecuteCodeRuntime spills overlap from request-scoped daemon provenance', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cold-spill-workspace-'),
  );
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-execute-code-cold-spill-runtime-'),
  );
  const threadId = testThreadId(939_1);
  const fixture = createPtcSessionDockerCommandFixture({
    policy: createPtcSessionDockerLocalBatchCommandPolicy(),
    containerId: 'container-agent-ptc-execute-code-cold-spill',
    commandResult: (invocation) =>
      invocation.args[0] === 'ps'
        ? { kind: 'exit', exitCode: 0, stdout: '', stderr: '' }
        : undefined,
  });
  const exits = [deferredExit(), deferredExit(), deferredExit()];
  let startCount = 0;
  const runtime = createPtcExecuteCodeRuntime({
    burstPlacement: { enabled: true },
    placementResourceBudgetProvider: () => ({
      resourceSnapshotRef: {
        snapshotId: 'runtime-cold-spill-capacity',
        source: 'agent_resource_budget_provider',
      },
      availableParallelism: { ok: true, value: 4 },
      constrainedMemoryBytes: { ok: true, value: 4 * 1_024 ** 3 },
      availableMemoryBytes: { ok: true, value: 2 * 1_024 ** 3 },
    }),
    commandRunner: fixture.runner,
    ptcCell: makeTestCellConfig(1),
    runtimeRootForState: () => runtimeRoot,
    startCellProcess: () => {
      const index = startCount;
      startCount += 1;
      const exit = exits[index];
      assert.ok(exit);
      return {
        ok: true,
        handle: makeDrainOnceDetachedHandle({
          output: makeDetachedSegment({ stdout: `cell-${index + 1}\n` }),
          exit: exit.promise,
        }),
      };
    },
  });
  const runContext = makeRunContext({
    threadId,
    stateRoot,
  });

  try {
    const warm = await runtime.executeCode({
      runContext,
      invocationId: 'call-cold-spill-warm',
      request: { code: 'await warm_owner', timeoutMs: 60_000 },
    });
    assert.equal(warm.ok, true);
    if (
      !warm.ok ||
      warm.value.executionSurface !== 'node_via_lab_detached_cell'
    ) {
      return;
    }
    assert.equal(warm.value.status, 'running');

    const cold = await runtime.executeCode({
      runContext,
      invocationId: 'call-cold-spill-first',
      placementContinuityProvenance: {
        independenceProof: { reason: 'self_contained' },
      },
      request: { code: 'await independent_one', timeoutMs: 60_000 },
    });
    assert.equal(cold.ok, true);
    if (
      !cold.ok ||
      cold.value.executionSurface !== 'node_via_lab_detached_cell'
    ) {
      return;
    }
    assert.equal(cold.value.status, 'running');
    assert.notEqual(cold.value.cellId, warm.value.cellId);

    const queued = await runtime.executeCode({
      runContext,
      invocationId: 'call-cold-spill-queued',
      placementContinuityProvenance: {
        independenceProof: { reason: 'self_contained' },
      },
      request: { code: 'await independent_two', timeoutMs: 60_000 },
    });
    assert.equal(queued.ok, true);
    if (
      !queued.ok ||
      queued.value.executionSurface !== 'node_via_lab_detached_cell'
    ) {
      return;
    }
    assert.equal(queued.value.status, 'queued');
    assert.equal(startCount, 2);

    exits[1]?.resolve({
      kind: 'exit',
      exitCode: 0,
      processTerminated: true,
    });
    const coldCompleted = await runtime.waitForCell({
      runContext: { threadId },
      request: { cellId: cold.value.cellId },
    });
    assert.equal(coldCompleted.ok, true);
    if (coldCompleted.ok) {
      assert.equal(coldCompleted.value.status, 'completed');
    }

    const promoted = await runtime.waitForCell({
      runContext: { threadId },
      request: { cellId: queued.value.cellId },
    });
    assert.equal(promoted.ok, true);
    if (promoted.ok) {
      assert.equal(promoted.value.status, 'running');
      assert.equal(promoted.value.stdout, 'cell-3\n');
    }
    assert.equal(startCount, 3);

    const cancelled = await runtime.executeCode({
      runContext,
      invocationId: 'call-cold-spill-cancelled',
      placementContinuityProvenance: {
        independenceProof: { reason: 'self_contained' },
      },
      request: { code: 'await independent_cancelled', timeoutMs: 60_000 },
    });
    assert.equal(cancelled.ok, true);
    if (
      !cancelled.ok ||
      cancelled.value.executionSurface !== 'node_via_lab_detached_cell'
    ) {
      return;
    }
    assert.equal(cancelled.value.status, 'queued');
    const cancelledWait = await runtime.waitForCell({
      runContext: { threadId },
      request: { cellId: cancelled.value.cellId, terminate: true },
    });
    assert.equal(cancelledWait.ok, true);
    if (cancelledWait.ok) {
      assert.equal(cancelledWait.value.status, 'terminated');
    }
    assert.equal(startCount, 3);

    exits[2]?.resolve({
      kind: 'exit',
      exitCode: 0,
      processTerminated: true,
    });
    const promotedCompleted = await runtime.waitForCell({
      runContext: { threadId },
      request: { cellId: queued.value.cellId },
    });
    assert.equal(promotedCompleted.ok, true);
    if (promotedCompleted.ok) {
      assert.equal(promotedCompleted.value.status, 'completed');
    }

    exits[0]?.resolve({
      kind: 'exit',
      exitCode: 0,
      processTerminated: true,
    });
    const warmCompleted = await runtime.waitForCell({
      runContext: { threadId },
      request: { cellId: warm.value.cellId },
    });
    assert.equal(warmCompleted.ok, true);
    if (warmCompleted.ok) {
      assert.equal(warmCompleted.value.status, 'completed');
    }
    await new Promise((resolve) => setImmediate(resolve));

    const creates = fixture.invocations.filter(
      (invocation) => invocation.args[0] === 'create',
    );
    assert.equal(creates.length, 3);
    assert.equal(
      creates.filter((invocation) =>
        invocation.args.includes('geulbat.ephemeral=true'),
      ).length,
      2,
    );
    const burstIdentityLabels = creates
      .filter((invocation) =>
        invocation.args.includes('geulbat.ephemeral=true'),
      )
      .map((invocation) =>
        invocation.args.find((arg) => arg.startsWith('geulbat.identityHash=')),
      );
    assert.equal(new Set(burstIdentityLabels).size, 2);
  } finally {
    for (const exit of exits) {
      exit.resolve({
        kind: 'signal',
        exitCode: null,
        processTerminated: false,
      });
    }
    await runtime.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

function makeDetachedSegment(
  args: Partial<DetachedProcessOutputSegment> = {},
): DetachedProcessOutputSegment {
  return {
    stdout: args.stdout ?? '',
    stderr: args.stderr ?? '',
  };
}

function makeDrainOnceDetachedHandle(args: {
  output: DetachedProcessOutputSegment;
  exit: Promise<DetachedProcessExitInfo>;
}): DetachedProcessHandle {
  let pending = args.output;
  return {
    drainNewOutput() {
      const output = pending;
      pending = makeDetachedSegment();
      return output;
    },
    exit: args.exit,
    terminate() {},
  };
}

function deferredExit(): {
  promise: Promise<DetachedProcessExitInfo>;
  resolve(exit: DetachedProcessExitInfo): void;
} {
  let resolveExit: (exit: DetachedProcessExitInfo) => void;
  const promise = new Promise<DetachedProcessExitInfo>((resolve) => {
    resolveExit = resolve;
  });
  return {
    promise,
    resolve: (exit) => resolveExit(exit),
  };
}
