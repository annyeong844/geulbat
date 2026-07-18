import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunContext } from '../run-context.js';
import { createRunState } from './runtime/run-state.js';
import { createResourceBudgetProvider } from './resource-budget-provider.js';
import { testRunId } from '../../test-support/run-id.js';
import { testThreadId } from '../../test-support/thread-id.js';

function createReader(
  overrides: {
    availableParallelism?: number | undefined;
    hostTotalMemoryBytes?: number | undefined;
    hostFreeMemoryBytes?: number | undefined;
    daemonConstrainedMemoryBytes?: number | undefined;
    daemonAvailableMemoryBytes?: number | undefined;
  } = {},
) {
  return {
    createSnapshotId: () => 'resource-snapshot-test',
    now: () => '2026-06-18T00:00:00.000Z',
    readAvailableParallelism: () => overrides.availableParallelism,
    readHostTotalMemoryBytes: () => overrides.hostTotalMemoryBytes,
    readHostFreeMemoryBytes: () => overrides.hostFreeMemoryBytes,
    readDaemonConstrainedMemoryBytes: () =>
      overrides.daemonConstrainedMemoryBytes,
    readDaemonAvailableMemoryBytes: () => overrides.daemonAvailableMemoryBytes,
  };
}

function createTestRunState() {
  return createRunState({
    runId: 'resource-budget-run',
    runContext: createRunContext({
      threadId: testThreadId(61),
      stateRoot: '/tmp/home-state',
    }),
  });
}

void test('ResourceBudgetProvider captures labeled observations without choosing a wave size', () => {
  const runState = createTestRunState();
  runState.backgroundChildRunIds.add(testRunId('active-background-child'));
  runState.backgroundChildLaunchReservationIds.add('reserved-child');
  const provider = createResourceBudgetProvider({
    reader: createReader({
      availableParallelism: 12,
      hostTotalMemoryBytes: 8_000,
      hostFreeMemoryBytes: 4_000,
      daemonConstrainedMemoryBytes: 6_000,
      daemonAvailableMemoryBytes: 3_000,
    }),
  });

  const snapshot = provider.captureSnapshot({ runState });

  assert.equal(snapshot.snapshotId, 'resource-snapshot-test');
  assert.equal(snapshot.capturedAt, '2026-06-18T00:00:00.000Z');
  assert.deepEqual(snapshot.cpu.availableParallelism, {
    ok: true,
    value: 12,
    source: 'node_os_available_parallelism',
    confidence: 'trusted',
  });
  assert.deepEqual(snapshot.memory.hostTotalBytes, {
    ok: true,
    value: 8_000,
    source: 'node_os_memory',
    confidence: 'advisory',
  });
  assert.equal(snapshot.memory.precedence, 'daemon_cgroup_limit');
  assert.deepEqual(snapshot.subagents.activeBackgroundChildren, {
    ok: true,
    value: 2,
    source: 'run_state_background_children',
    confidence: 'trusted',
  });
  assert.equal('selectedItemIds' in snapshot, false);
  assert.equal('waveSize' in snapshot, false);
});

void test('ResourceBudgetProvider reports unavailable observations instead of falling back', () => {
  const provider = createResourceBudgetProvider({
    reader: createReader({
      availableParallelism: undefined,
      hostTotalMemoryBytes: undefined,
      hostFreeMemoryBytes: undefined,
      daemonConstrainedMemoryBytes: Number.MAX_SAFE_INTEGER + 1,
      daemonAvailableMemoryBytes: undefined,
    }),
  });

  const snapshot = provider.captureSnapshot();

  assert.deepEqual(snapshot.cpu.availableParallelism, {
    ok: false,
    source: 'node_os_available_parallelism',
    confidence: 'unavailable',
    reasonCode: 'unavailable',
    message: 'available parallelism unavailable',
  });
  assert.deepEqual(snapshot.memory.daemonConstrainedMemoryBytes, {
    ok: false,
    source: 'node_process_constrained_memory',
    confidence: 'unavailable',
    reasonCode: 'invalid',
    message: `daemon constrained memory bytes invalid: ${String(Number.MAX_SAFE_INTEGER + 1)}`,
  });
  assert.equal(snapshot.memory.precedence, 'unavailable');
  assert.deepEqual(snapshot.subagents.activeBackgroundChildren, {
    ok: false,
    source: 'run_state_background_children',
    confidence: 'unavailable',
    reasonCode: 'unavailable',
    message: 'active background children unavailable',
  });
});

void test('ResourceBudgetProvider treats host memory as context when daemon cgroup evidence is unavailable', () => {
  const provider = createResourceBudgetProvider({
    reader: createReader({
      availableParallelism: 4,
      hostTotalMemoryBytes: 16_000,
      hostFreeMemoryBytes: 12_000,
      daemonConstrainedMemoryBytes: undefined,
      daemonAvailableMemoryBytes: undefined,
    }),
  });

  const snapshot = provider.captureSnapshot();

  assert.equal(snapshot.memory.precedence, 'host_os_context_only');
  assert.equal(snapshot.memory.hostTotalBytes.ok, true);
  assert.equal(snapshot.memory.daemonConstrainedMemoryBytes.ok, false);
});
