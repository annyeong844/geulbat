import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentLoopKernelEvent } from '@geulbat/agent-loop/kernel';

import {
  createHarnessRunTrace,
  parseHarnessRunTrace,
  serializeHarnessRunTrace,
} from './run-trace.js';

const HARNESS_SNAPSHOT_ID: `sha256:${string}` = `sha256:${'0'.repeat(64)}`;
const EVENTS = [
  {
    kind: 'round_started',
    round: 0,
    historyItemCount: 1,
    sawFirstModelRequest: false,
  },
  { kind: 'model_call_started', round: 0 },
  {
    kind: 'model_call_completed',
    round: 0,
    outcome: 'success',
    functionCallCount: 1,
    structuredOutputCount: 0,
  },
  {
    kind: 'structured_outputs_started',
    round: 0,
    structuredOutputCount: 0,
  },
  { kind: 'structured_outputs_completed', round: 0, outcome: 'none' },
  { kind: 'tool_calls_started', round: 0, functionCallCount: 1 },
  { kind: 'tool_calls_completed', round: 0, outcome: 'success' },
  { kind: 'round_completed', round: 0, outcome: 'continue' },
  {
    kind: 'round_started',
    round: 1,
    historyItemCount: 4,
    sawFirstModelRequest: true,
  },
  { kind: 'model_call_started', round: 1 },
  {
    kind: 'model_call_completed',
    round: 1,
    outcome: 'success',
    functionCallCount: 0,
    structuredOutputCount: 0,
  },
  {
    kind: 'structured_outputs_started',
    round: 1,
    structuredOutputCount: 0,
  },
  { kind: 'structured_outputs_completed', round: 1, outcome: 'none' },
  {
    kind: 'round_completed',
    round: 1,
    outcome: 'terminal',
    terminalOk: true,
    terminalSource: 'natural',
  },
] satisfies readonly AgentLoopKernelEvent[];

void test('creates a content-redacted portable trace with a stable identity', () => {
  const first = createHarnessRunTrace({
    taskId: 'task-1',
    attemptId: 'attempt-1',
    modelConfigId: 'model-config-1',
    harnessSnapshotId: HARNESS_SNAPSHOT_ID,
    loopImplementation: {
      implementationId: 'geulbat.agent-loop.kernel',
      contractVersion: '1',
    },
    events: EVENTS,
    outcomeOk: true,
  });
  const same = createHarnessRunTrace({
    taskId: 'task-1',
    attemptId: 'attempt-1',
    modelConfigId: 'model-config-1',
    harnessSnapshotId: HARNESS_SNAPSHOT_ID,
    loopImplementation: {
      implementationId: 'geulbat.agent-loop.kernel',
      contractVersion: '1',
    },
    events: EVENTS,
    outcomeOk: true,
  });
  const changedAttempt = createHarnessRunTrace({
    taskId: 'task-1',
    attemptId: 'attempt-2',
    modelConfigId: 'model-config-1',
    harnessSnapshotId: HARNESS_SNAPSHOT_ID,
    loopImplementation: {
      implementationId: 'geulbat.agent-loop.kernel',
      contractVersion: '1',
    },
    events: EVENTS,
    outcomeOk: true,
  });

  assert.match(first.traceId, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.traceId, same.traceId);
  assert.notEqual(first.traceId, changedAttempt.traceId);
  assert.deepEqual(first.outcome, {
    ok: true,
    terminalSource: 'natural',
  });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.events), true);
  assert.equal(
    first.events.every((event) => Object.isFrozen(event)),
    true,
  );
  assert.equal(Object.isFrozen(first.loopImplementation), true);
  assert.equal(Object.isFrozen(first.outcome), true);
});

void test('serializes and parses canonical trace bytes without runtime content', () => {
  const trace = createHarnessRunTrace({
    taskId: 'task-1',
    attemptId: 'attempt-1',
    modelConfigId: 'model-config-1',
    harnessSnapshotId: HARNESS_SNAPSHOT_ID,
    loopImplementation: {
      implementationId: 'geulbat.agent-loop.kernel',
      contractVersion: '1',
    },
    events: EVENTS,
    outcomeOk: true,
  });

  const serialized = serializeHarnessRunTrace(trace);
  const parsed = parseHarnessRunTrace(serialized);

  assert.deepEqual(parsed, trace);
  assert.equal(serializeHarnessRunTrace(parsed), serialized);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(serialized.includes('assistantText'), false);
  assert.equal(serialized.includes('toolOutput'), false);
  assert.equal(serialized.includes('prompt'), false);
  const contaminatedTrace = {
    ...trace,
    rawPrompt: 'must not cross the trace boundary',
  };
  assert.throws(
    () => serializeHarnessRunTrace(contaminatedTrace),
    /unexpected fields/u,
  );
});

void test('rejects tampering and structurally invalid event sequences', () => {
  const trace = createHarnessRunTrace({
    taskId: 'task-1',
    attemptId: 'attempt-1',
    modelConfigId: 'model-config-1',
    harnessSnapshotId: HARNESS_SNAPSHOT_ID,
    loopImplementation: {
      implementationId: 'geulbat.agent-loop.kernel',
      contractVersion: '1',
    },
    events: EVENTS,
    outcomeOk: true,
  });
  const serialized = serializeHarnessRunTrace(trace);

  assert.throws(
    () => parseHarnessRunTrace(serialized.replace('task-1', 'task-2')),
    /traceId does not match/u,
  );
  assert.throws(
    () =>
      parseHarnessRunTrace(
        serialized.replace(',"terminalSource":"natural"', ''),
      ),
    /unexpected fields/u,
  );
  assert.throws(
    () =>
      createHarnessRunTrace({
        taskId: 'task-1',
        attemptId: 'attempt-1',
        modelConfigId: 'model-config-1',
        harnessSnapshotId: HARNESS_SNAPSHOT_ID,
        loopImplementation: {
          implementationId: 'geulbat.agent-loop.kernel',
          contractVersion: '1',
        },
        events: EVENTS.slice(0, 8),
        outcomeOk: true,
      }),
    /final round must be terminal/u,
  );
  assert.throws(
    () =>
      createHarnessRunTrace({
        taskId: 'task-1',
        attemptId: 'attempt-1',
        modelConfigId: 'model-config-1',
        harnessSnapshotId: HARNESS_SNAPSHOT_ID,
        loopImplementation: {
          implementationId: 'geulbat.agent-loop.kernel',
          contractVersion: '1',
        },
        events: [
          ...EVENTS.slice(0, 2),
          {
            kind: 'round_completed',
            round: 0,
            outcome: 'terminal',
            terminalOk: true,
            terminalSource: 'natural',
          },
        ],
        outcomeOk: true,
      }),
    /phase events must contain adjacent start\/completion pairs/u,
  );
  assert.throws(
    () =>
      createHarnessRunTrace({
        taskId: 'task-1',
        attemptId: 'attempt-1',
        modelConfigId: 'model-config-1',
        harnessSnapshotId: HARNESS_SNAPSHOT_ID,
        loopImplementation: {
          implementationId: 'geulbat.agent-loop.kernel',
          contractVersion: '1',
        },
        events: EVENTS,
        outcomeOk: false,
      }),
    /terminal event does not match outcome\.ok/u,
  );
});
