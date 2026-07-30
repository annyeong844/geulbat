import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { sha256Digest } from '@geulbat/content-identity/sha256';

import {
  DaemonRuntimeStateStoreError,
  createDaemonRuntimeStateStore,
  resolveDaemonRuntimeStateDatabasePath,
} from './runtime-state-store.js';
import type { BackgroundChildResult } from './subagent-runtime-contracts.js';
import { makeLaunchRequest } from '../test-support/runtime-state-store.js';
import { testRunId } from '../test-support/run-id.js';
import { testThreadId } from '../test-support/thread-id.js';

void test('runtime-state restart reconciliation preserves only checkpoint-correlated active children', async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-child-recovery-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  let store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const [accepted] = store.enqueueSubagentLaunchBatch([
    makeLaunchRequest(2, 'call-recoverable-started-child'),
  ]);
  assert.ok(accepted);
  store.markSubagentLaunchStarting(accepted.childRunId);
  store.markSubagentLaunchStarted(accepted.childRunId);
  store.close();

  try {
    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      deferSubagentRestartReconciliation: true,
    });
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(accepted.childRunId)
        ?.launchState,
      'started',
    );
    store.reconcileSubagentLaunchesAfterRestart?.({
      recoverableChildRunIds: [accepted.childRunId],
      recoverableParentRunIds: [],
    });
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(accepted.childRunId)
        ?.launchState,
      'started',
    );
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(accepted.childRunId),
      undefined,
    );
    store.close();

    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      deferSubagentRestartReconciliation: true,
    });
    store.reconcileSubagentLaunchesAfterRestart?.({
      recoverableChildRunIds: [],
      recoverableParentRunIds: [],
    });
    const interrupted = store.readSubagentLaunchRequestByChildRunId(
      accepted.childRunId,
    );
    assert.equal(interrupted?.launchState, 'interrupted');
    assert.equal(interrupted?.failureReason, 'daemon_restart_interrupted');
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(accepted.childRunId)?.result
        .reason,
      'daemon_restart',
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store replays terminal delivery after reopen and keeps exact outcome after acknowledgement', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const ownerThreadId = testThreadId(40);
  const result = makeTerminalResult(40, 'delivery-terminal-replay');
  let store = await createDaemonRuntimeStateStore({
    homeStateRoot,
    now: () => new Date('2026-07-23T04:00:00.000Z'),
  });

  try {
    const recorded = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result,
    });
    assert.equal(recorded.inserted, true);
    assert.equal(
      recorded.outcome.resultRef,
      `subagent-result:${result.deliveryId}`,
    );
    assert.equal(recorded.outcome.resultDigest, sha256Digest(result.result));
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByResultRef(recorded.outcome.resultRef),
      recorded.outcome,
    );
    assert.deepEqual(
      store.readPendingSubagentTerminalDeliveries(ownerThreadId),
      [recorded.outcome],
    );

    store.close();
    store = await createDaemonRuntimeStateStore({ homeStateRoot });
    assert.deepEqual(
      store.readPendingSubagentTerminalDeliveries(ownerThreadId),
      [recorded.outcome],
    );

    store.acknowledgeSubagentTerminalDeliveries({
      ownerThreadId,
      deliveryIds: [result.deliveryId],
    });
    const acknowledgedOutcome = {
      ...recorded.outcome,
      resultDeliveryState: 'acknowledged' as const,
    };
    assert.deepEqual(
      store.readPendingSubagentTerminalDeliveries(ownerThreadId),
      [],
    );
    assert.deepEqual(store.readSubagentTerminalDeliveries(ownerThreadId), [
      acknowledgedOutcome,
    ]);
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId),
      acknowledgedOutcome,
    );

    store.close();
    store = await createDaemonRuntimeStateStore({ homeStateRoot });
    assert.deepEqual(store.readSubagentTerminalDeliveries(ownerThreadId), [
      acknowledgedOutcome,
    ]);
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId),
      acknowledgedOutcome,
    );
    store.clearSubagentTerminalDeliveries(ownerThreadId);
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId),
      undefined,
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store preserves graceful daemon shutdown as a durable terminal reason', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const ownerThreadId = testThreadId(42);
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const result = {
    ...makeTerminalResult(42, 'delivery-daemon-shutdown'),
    terminalState: 'cancelled',
    reason: 'daemon_shutdown',
  } as const;

  try {
    const recorded = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result,
    });

    assert.equal(recorded.outcome.result.reason, 'daemon_shutdown');
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId),
      recorded.outcome,
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store migrates existing version-nine terminal history without loss', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const databasePath = resolveDaemonRuntimeStateDatabasePath(homeStateRoot);
  const ownerThreadId = testThreadId(43);
  const result = {
    ...makeTerminalResult(43, 'delivery-before-terminal-reason-upgrade'),
    terminalState: 'failed',
    reason: 'daemon_restart',
  } as const;
  let store = await createDaemonRuntimeStateStore({ homeStateRoot });

  try {
    const recorded = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result,
    }).outcome;
    store.close();

    const versionNineDatabase = new DatabaseSync(databasePath);
    versionNineDatabase.exec(`
      ALTER TABLE subagent_launch_requests
        DROP COLUMN provider_request_json;
      DROP TABLE ptc_execute_code_running_exec_deliveries;
      DROP TABLE ptc_execute_code_running_wait_deliveries;
      DROP INDEX ptc_execute_code_cell_coordinates_owner;
      DROP TABLE ptc_execute_code_cell_coordinates;
      DROP TABLE mcp_session_coordinates;
      DELETE FROM runtime_schema_migrations
      WHERE version IN (10, 11, 12, 13, 14, 15, 16, 17);
      PRAGMA user_version = 9;
    `);
    versionNineDatabase.close();

    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });

    assert.deepEqual(store.readDiagnostics().startupMigration, {
      backupCreated: true,
      fromVersion: 9,
      toVersion: 17,
    });
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(result.childRunId),
      recorded,
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store makes terminal recording idempotent but rejects divergent identity reuse', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const ownerThreadId = testThreadId(41);
  const store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const result = makeTerminalResult(41, 'delivery-terminal-idempotent');

  try {
    const first = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result,
    });
    const duplicate = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result: { ...result },
    });
    assert.equal(first.inserted, true);
    assert.deepEqual(duplicate, { inserted: false, outcome: first.outcome });

    assert.throws(
      () =>
        store.recordSubagentTerminalDelivery({
          ownerThreadId,
          result: { ...result, result: 'different terminal body' },
        }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation',
    );
    assert.throws(
      () =>
        store.recordSubagentTerminalDelivery({
          ownerThreadId,
          result: {
            ...result,
            childRunId: testRunId('different-child'),
          },
        }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'operation',
    );
    assert.deepEqual(
      store.readPendingSubagentTerminalDeliveries(ownerThreadId),
      [first.outcome],
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state restart reconciliation preserves queued children only for recoverable parents', async () => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-runtime-queued-parent-recovery-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  let store = await createDaemonRuntimeStateStore({ homeStateRoot });
  const [recoverable, orphaned] = store.enqueueSubagentLaunchBatch([
    makeLaunchRequest(3, 'call-recoverable-queued-child'),
    makeLaunchRequest(4, 'call-orphaned-queued-child'),
  ]);
  assert.ok(recoverable);
  assert.ok(orphaned);
  store.close();

  try {
    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      deferSubagentRestartReconciliation: true,
    });
    store.reconcileSubagentLaunchesAfterRestart?.({
      recoverableChildRunIds: [],
      recoverableParentRunIds: [recoverable.parentRunId],
    });

    const preserved = store.readSubagentLaunchRequestByChildRunId(
      recoverable.childRunId,
    );
    assert.equal(preserved?.launchState, 'queued');
    assert.equal(preserved?.deferReason, 'recovery_reconciliation');
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(recoverable.childRunId),
      undefined,
    );

    const interrupted = store.readSubagentLaunchRequestByChildRunId(
      orphaned.childRunId,
    );
    assert.equal(interrupted?.launchState, 'interrupted');
    assert.equal(interrupted?.deferReason, null);
    assert.equal(interrupted?.failureReason, 'daemon_restart_interrupted');
    const outcome = store.readSubagentTerminalOutcomeByChildRunId(
      orphaned.childRunId,
    );
    assert.ok(outcome);
    assert.equal(outcome.result.reason, 'daemon_restart');
    assert.match(outcome.result.result, /parent run could not be recovered/u);
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state store preserves queued work and atomically interrupts false-running child launches after restart', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const ownerThreadId = testThreadId(50);
  const queuedInput = makeLaunchRequest(50, 'call-recovery-queued');
  const startingInput = makeLaunchRequest(50, 'call-recovery-starting');
  const startedInput = makeLaunchRequest(50, 'call-recovery-started');
  const terminalInput = makeLaunchRequest(50, 'call-recovery-terminal');
  let store = await createDaemonRuntimeStateStore({
    homeStateRoot,
    now: () => new Date('2026-07-23T05:00:00.000Z'),
  });

  try {
    const [queued, starting, started, alreadyTerminal] =
      store.enqueueSubagentLaunchBatch([
        queuedInput,
        startingInput,
        startedInput,
        terminalInput,
      ]);
    assert.ok(queued);
    assert.ok(starting);
    assert.ok(started);
    assert.ok(alreadyTerminal);
    store.markSubagentLaunchStarting(starting.childRunId);
    store.markSubagentLaunchStarting(started.childRunId);
    store.markSubagentLaunchStarted(started.childRunId);
    store.markSubagentLaunchStarting(alreadyTerminal.childRunId);
    store.markSubagentLaunchStarted(alreadyTerminal.childRunId);

    const priorTerminalResult = {
      ...makeTerminalResult(50, 'delivery-before-restart'),
      parentRunId: alreadyTerminal.parentRunId,
      childRunId: alreadyTerminal.childRunId,
      childThreadId: alreadyTerminal.childThreadId,
    };
    const priorTerminal = store.recordSubagentTerminalDelivery({
      ownerThreadId,
      result: priorTerminalResult,
    }).outcome;

    store.close();
    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-23T05:05:00.000Z'),
    });

    assert.deepEqual(
      store.readSubagentLaunchRequestByChildRunId(queued.childRunId),
      {
        ...queued,
        deferReason: 'recovery_reconciliation',
        updatedAt: '2026-07-23T05:05:00.000Z',
      },
    );
    for (const active of [starting, started]) {
      const interrupted = store.readSubagentLaunchRequestByChildRunId(
        active.childRunId,
      );
      assert.equal(interrupted?.launchState as string, 'interrupted');
      assert.equal(interrupted?.deferReason, null);
      assert.equal(interrupted?.failureReason, 'daemon_restart_interrupted');
      assert.equal(interrupted?.updatedAt, '2026-07-23T05:05:00.000Z');

      const outcome = store.readSubagentTerminalOutcomeByChildRunId(
        active.childRunId,
      );
      assert.ok(outcome);
      assert.equal(outcome.ownerThreadId, ownerThreadId);
      assert.equal(outcome.result.parentRunId, active.parentRunId);
      assert.equal(outcome.result.childThreadId, active.childThreadId);
      assert.equal(outcome.result.subagentType, 'explorer');
      assert.equal(outcome.result.terminalState, 'failed');
      assert.equal(outcome.result.reason, 'daemon_restart');
      assert.equal(
        outcome.result.result,
        'sub-agent interrupted because the daemon restarted before a durable terminal outcome was recorded',
      );
      assert.equal(outcome.result.completedAt, '2026-07-23T05:05:00.000Z');
    }
    assert.deepEqual(
      store.readSubagentTerminalOutcomeByChildRunId(alreadyTerminal.childRunId),
      priorTerminal,
    );
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(alreadyTerminal.childRunId)
        ?.launchState,
      'started',
    );

    const firstPending =
      store.readPendingSubagentTerminalDeliveries(ownerThreadId);
    assert.equal(firstPending.length, 3);
    const firstPendingByChild = new Map(
      firstPending.map((outcome) => [outcome.result.childRunId, outcome]),
    );
    assert.deepEqual(
      firstPendingByChild.get(alreadyTerminal.childRunId),
      priorTerminal,
    );

    store.close();
    store = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-23T05:10:00.000Z'),
    });
    assert.deepEqual(
      store.readPendingSubagentTerminalDeliveries(ownerThreadId),
      firstPending,
    );
    assert.equal(
      store.readSubagentLaunchRequestByChildRunId(queued.childRunId)?.updatedAt,
      '2026-07-23T05:05:00.000Z',
    );
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state survives process death before commit and reconciles a committed active attempt after death', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-crash-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const databasePath = resolveDaemonRuntimeStateDatabasePath(homeStateRoot);
  const rollbackInput = makeLaunchRequest(90, 'call-crash-before-commit');
  const activeInput = makeLaunchRequest(90, 'call-crash-after-commit');
  let transactionChild: ChildProcess | undefined;
  let activeChild: ChildProcess | undefined;

  try {
    const initialStore = await createDaemonRuntimeStateStore({
      homeStateRoot,
    });
    const [rollbackProbe] = initialStore.enqueueSubagentLaunchBatch([
      rollbackInput,
    ]);
    assert.ok(rollbackProbe);
    initialStore.close();

    transactionChild = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import { DatabaseSync } from 'node:sqlite';
          const database = new DatabaseSync(process.env.RUNTIME_DATABASE_PATH);
          database.exec('BEGIN IMMEDIATE;');
          database
            .prepare("UPDATE subagent_launch_requests SET priority_class = 'high' WHERE child_run_id = ?")
            .run(process.env.CHILD_RUN_ID);
          process.send?.('ready');
          await new Promise(() => {});
        `,
      ],
      {
        env: {
          ...process.env,
          CHILD_RUN_ID: rollbackProbe.childRunId,
          RUNTIME_DATABASE_PATH: databasePath,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    await waitForCrashFixtureReady(transactionChild);
    const transactionExit = once(transactionChild, 'exit');
    assert.equal(transactionChild.kill('SIGKILL'), true);
    await transactionExit;

    const afterUncommittedDeath = new DatabaseSync(databasePath, {
      readOnly: true,
    });
    try {
      const row = afterUncommittedDeath
        .prepare(
          'SELECT priority_class AS priorityClass FROM subagent_launch_requests WHERE child_run_id = ?',
        )
        .get(rollbackProbe.childRunId);
      assert.ok(row);
      assert.equal(row['priorityClass'], 'normal');
    } finally {
      afterUncommittedDeath.close();
    }

    activeChild = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          const { createDaemonRuntimeStateStore } =
            await import(process.env.RUNTIME_STORE_MODULE_URL);
          const store = await createDaemonRuntimeStateStore({
            homeStateRoot: process.env.HOME_STATE_ROOT,
          });
          const [launch] = store.enqueueSubagentLaunchBatch([
            JSON.parse(process.env.ACTIVE_INPUT_JSON),
          ]);
          store.markSubagentLaunchStarting(launch.childRunId);
          store.markSubagentLaunchStarted(launch.childRunId);
          process.send?.('ready');
          await new Promise(() => {});
        `,
      ],
      {
        env: {
          ...process.env,
          ACTIVE_INPUT_JSON: JSON.stringify(activeInput),
          HOME_STATE_ROOT: homeStateRoot,
          RUNTIME_STORE_MODULE_URL: new URL(
            './runtime-state-store.js',
            import.meta.url,
          ).href,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    await waitForCrashFixtureReady(activeChild);
    const activeExit = once(activeChild, 'exit');
    assert.equal(activeChild.kill('SIGKILL'), true);
    await activeExit;

    const recovered = await createDaemonRuntimeStateStore({
      homeStateRoot,
      now: () => new Date('2026-07-23T07:30:00.000Z'),
    });
    try {
      const active = recovered.readSubagentLaunchRequest({
        parentRunId: activeInput.parentRunId,
        toolCallId: activeInput.toolCallId,
      });
      assert.ok(active);
      assert.equal(active.launchState, 'interrupted');
      assert.equal(active.failureReason, 'daemon_restart_interrupted');
      assert.ok(
        recovered.readSubagentTerminalOutcomeByChildRunId(active.childRunId),
      );
      assert.equal(
        recovered.readSubagentLaunchRequestByChildRunId(
          rollbackProbe.childRunId,
        )?.priorityClass,
        'normal',
      );
    } finally {
      recovered.close();
    }
  } finally {
    transactionChild?.kill('SIGKILL');
    activeChild?.kill('SIGKILL');
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

void test('runtime-state restart reconciliation rolls back every recovery mutation when one active launch input is invalid', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'geulbat-runtime-state-'));
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const databasePath = resolveDaemonRuntimeStateDatabasePath(homeStateRoot);
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot,
    now: () => new Date('2026-07-23T06:00:00.000Z'),
  });
  const queuedInput = makeLaunchRequest(60, 'call-rollback-queued');
  const validActiveInput = makeLaunchRequest(60, 'call-rollback-valid-active');
  const invalidActiveInput = makeLaunchRequest(
    60,
    'call-rollback-invalid-active',
  );

  try {
    const [queued, validActive, invalidActive] =
      store.enqueueSubagentLaunchBatch([
        queuedInput,
        validActiveInput,
        invalidActiveInput,
      ]);
    assert.ok(queued);
    assert.ok(validActive);
    assert.ok(invalidActive);
    store.markSubagentLaunchStarting(validActive.childRunId);
    store.markSubagentLaunchStarted(validActive.childRunId);
    store.markSubagentLaunchStarting(invalidActive.childRunId);
    store.markSubagentLaunchStarted(invalidActive.childRunId);
    store.close();

    const tampered = new DatabaseSync(databasePath);
    try {
      tampered
        .prepare(
          `
            UPDATE subagent_launch_requests
            SET input_json = '{}'
            WHERE child_run_id = ?
          `,
        )
        .run(invalidActive.childRunId);
    } finally {
      tampered.close();
    }

    await assert.rejects(
      () =>
        createDaemonRuntimeStateStore({
          homeStateRoot,
          now: () => new Date('2026-07-23T06:05:00.000Z'),
        }),
      (error: unknown) =>
        error instanceof DaemonRuntimeStateStoreError &&
        error.stage === 'recovery',
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = preserved
        .prepare(
          `
            SELECT
              child_run_id AS childRunId,
              launch_state AS launchState,
              defer_reason AS deferReason,
              failure_reason AS failureReason,
              updated_at AS updatedAt
            FROM subagent_launch_requests
            ORDER BY enqueue_order
        `,
        )
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(rows, [
        {
          childRunId: queued.childRunId,
          launchState: 'queued',
          deferReason: null,
          failureReason: null,
          updatedAt: '2026-07-23T06:00:00.000Z',
        },
        {
          childRunId: validActive.childRunId,
          launchState: 'started',
          deferReason: null,
          failureReason: null,
          updatedAt: '2026-07-23T06:00:00.000Z',
        },
        {
          childRunId: invalidActive.childRunId,
          launchState: 'started',
          deferReason: null,
          failureReason: null,
          updatedAt: '2026-07-23T06:00:00.000Z',
        },
      ]);
      const terminalCount = preserved
        .prepare('SELECT COUNT(*) AS count FROM subagent_terminal_outcomes')
        .get();
      assert.ok(terminalCount);
      assert.deepEqual({ ...terminalCount }, { count: 0 });
    } finally {
      preserved.close();
    }
  } finally {
    store.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function waitForCrashFixtureReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(
        new Error(
          `runtime-state crash fixture did not become ready: ${stderr.trim()}`,
        ),
      );
    }, 10_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectReady(error);
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      cleanup();
      rejectReady(
        new Error(
          `runtime-state crash fixture exited before ready: code=${code} signal=${signal} stderr=${stderr.trim()}`,
        ),
      );
    };
    const onMessage = (message: unknown): void => {
      if (message !== 'ready') {
        return;
      }
      cleanup();
      resolveReady();
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

function makeTerminalResult(
  threadSeed: number,
  deliveryId: string,
): BackgroundChildResult {
  return {
    deliveryId,
    parentRunId: testRunId(`terminal-parent-${threadSeed}`),
    childRunId: testRunId(`terminal-child-${threadSeed}`),
    childThreadId: testThreadId(threadSeed + 1),
    subagentType: 'worker',
    capabilities: ['ptc'],
    toolSurface: 'worker',
    terminalState: 'completed',
    result: `terminal result ${threadSeed}`,
    completedAt: '2026-07-23T04:00:00.000Z',
    elapsedMs: 25,
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
    },
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
  };
}
