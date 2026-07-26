import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentLoopKernelEvent } from '@geulbat/agent-loop/kernel';

import { compareHarnessRunTraces } from './run-trace-comparison.js';
import { createHarnessRunTrace, type HarnessRunTrace } from './run-trace.js';

const BASE_HARNESS_SNAPSHOT_ID: `sha256:${string}` = `sha256:${'0'.repeat(64)}`;
const CANDIDATE_HARNESS_SNAPSHOT_ID: `sha256:${string}` = `sha256:${'1'.repeat(64)}`;
const BASE_EVENTS = [
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
    functionCallCount: 0,
    structuredOutputCount: 0,
  },
  {
    kind: 'structured_outputs_started',
    round: 0,
    structuredOutputCount: 0,
  },
  { kind: 'structured_outputs_completed', round: 0, outcome: 'none' },
  {
    kind: 'round_completed',
    round: 0,
    outcome: 'terminal',
    terminalOk: true,
    terminalSource: 'natural',
  },
] satisfies readonly AgentLoopKernelEvent[];

function createTrace(args?: {
  readonly attemptId?: string;
  readonly harnessSnapshotId?: `sha256:${string}`;
  readonly contractVersion?: string;
  readonly events?: readonly AgentLoopKernelEvent[];
  readonly outcomeOk?: boolean;
}): HarnessRunTrace {
  return createHarnessRunTrace({
    taskId: 'task-1',
    attemptId: args?.attemptId ?? 'attempt-1',
    modelConfigId: 'model-config-1',
    harnessSnapshotId: args?.harnessSnapshotId ?? BASE_HARNESS_SNAPSHOT_ID,
    loopImplementation: {
      implementationId: 'geulbat.agent-loop.kernel',
      contractVersion: args?.contractVersion ?? '1',
    },
    events: args?.events ?? BASE_EVENTS,
    outcomeOk: args?.outcomeOk ?? true,
  });
}

void test('reports identical immutable traces without manufacturing differences', () => {
  const comparison = compareHarnessRunTraces(createTrace(), createTrace());

  assert.deepEqual(comparison, {
    identical: true,
    identityDifferences: [],
    eventDifferences: [],
    outcomeDifferences: [],
  });
  assert.equal(Object.isFrozen(comparison), true);
  assert.equal(Object.isFrozen(comparison.identityDifferences), true);
  assert.equal(Object.isFrozen(comparison.eventDifferences), true);
  assert.equal(Object.isFrozen(comparison.outcomeDifferences), true);
});

void test('reports identity and phase field names without exposing their values', () => {
  const candidateEvents = [
    BASE_EVENTS[0]!,
    BASE_EVENTS[1]!,
    {
      kind: 'model_call_completed',
      round: 0,
      outcome: 'success',
      functionCallCount: 0,
      structuredOutputCount: 1,
    },
    {
      kind: 'structured_outputs_started',
      round: 0,
      structuredOutputCount: 1,
    },
    {
      kind: 'structured_outputs_completed',
      round: 0,
      outcome: 'handled',
    },
    {
      kind: 'round_completed',
      round: 0,
      outcome: 'terminal',
      terminalOk: true,
      terminalSource: 'structured_output',
    },
  ] satisfies readonly AgentLoopKernelEvent[];
  const comparison = compareHarnessRunTraces(
    createTrace(),
    createTrace({
      attemptId: 'attempt-candidate',
      harnessSnapshotId: CANDIDATE_HARNESS_SNAPSHOT_ID,
      contractVersion: '2',
      events: candidateEvents,
    }),
  );

  assert.equal(comparison.identical, false);
  assert.deepEqual(comparison.identityDifferences, [
    'attemptId',
    'harnessSnapshotId',
    'loopImplementation.contractVersion',
  ]);
  assert.deepEqual(comparison.eventDifferences, [
    {
      eventIndex: 2,
      baselineRound: 0,
      candidateRound: 0,
      baselineKind: 'model_call_completed',
      candidateKind: 'model_call_completed',
      differingFields: ['structuredOutputCount'],
    },
    {
      eventIndex: 3,
      baselineRound: 0,
      candidateRound: 0,
      baselineKind: 'structured_outputs_started',
      candidateKind: 'structured_outputs_started',
      differingFields: ['structuredOutputCount'],
    },
    {
      eventIndex: 4,
      baselineRound: 0,
      candidateRound: 0,
      baselineKind: 'structured_outputs_completed',
      candidateKind: 'structured_outputs_completed',
      differingFields: ['outcome'],
    },
    {
      eventIndex: 5,
      baselineRound: 0,
      candidateRound: 0,
      baselineKind: 'round_completed',
      candidateKind: 'round_completed',
      differingFields: ['terminalSource'],
    },
  ]);
  assert.deepEqual(comparison.outcomeDifferences, ['terminalSource']);
  assert.equal(Object.isFrozen(comparison.eventDifferences[0]), true);
  assert.equal(
    Object.isFrozen(comparison.eventDifferences[0]?.differingFields),
    true,
  );
  const serialized = JSON.stringify(comparison);
  assert.equal(serialized.includes('attempt-candidate'), false);
  assert.equal(serialized.includes(CANDIDATE_HARNESS_SNAPSHOT_ID), false);
});

void test('marks the side missing an event when valid traces have different round counts', () => {
  const candidateEvents = [
    ...BASE_EVENTS.slice(0, -1),
    { kind: 'round_completed', round: 0, outcome: 'continue' },
    {
      kind: 'round_started',
      round: 1,
      historyItemCount: 2,
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
    {
      kind: 'structured_outputs_completed',
      round: 1,
      outcome: 'none',
    },
    {
      kind: 'round_completed',
      round: 1,
      outcome: 'terminal',
      terminalOk: true,
      terminalSource: 'natural',
    },
  ] satisfies readonly AgentLoopKernelEvent[];
  const comparison = compareHarnessRunTraces(
    createTrace(),
    createTrace({ events: candidateEvents }),
  );

  assert.deepEqual(comparison.eventDifferences[1], {
    eventIndex: 6,
    baselineRound: null,
    candidateRound: 1,
    baselineKind: null,
    candidateKind: 'round_started',
    differingFields: [
      'kind',
      'round',
      'historyItemCount',
      'sawFirstModelRequest',
    ],
  });
});
