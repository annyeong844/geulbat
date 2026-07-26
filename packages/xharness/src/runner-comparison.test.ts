import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentLoopKernelPorts } from '@geulbat/agent-loop/kernel';

import { createHarnessConfigSnapshot } from './harness-snapshot.js';
import { runXHarnessComparison } from './runner.js';

interface TestResult {
  readonly ok: boolean;
  readonly text: string;
}

type TestPorts = AgentLoopKernelPorts<TestResult, never, never, never>;

const ignore = () => undefined;

function createPorts(args: {
  readonly label: 'baseline' | 'candidate';
  readonly result: TestResult;
  readonly executionOrder: string[];
}): TestPorts {
  return {
    getHistoryItemCount: () => 0,
    async runModelRound() {
      args.executionOrder.push(args.label);
      if (!args.result.ok) {
        return { ok: false, result: args.result };
      }
      return {
        ok: true,
        value: {
          assistantText: args.result.text,
          terminalResult: args.result,
          functionCalls: [],
        },
      };
    },
    async processStructuredOutputs() {
      return { ok: true, handled: false };
    },
    appendAssistantText: ignore,
    appendHistoryItems: ignore,
    appendFunctionCalls: ignore,
    async processFunctionCalls() {
      return { ok: true, value: undefined };
    },
    createTerminalFailure(failure) {
      return { ok: false, text: failure.message };
    },
    settleTerminal: ignore,
  };
}

void test('runs two daemon-free attempts and reports their first round phase difference', async () => {
  const executionOrder: string[] = [];
  const harnessSnapshot = createHarnessConfigSnapshot({
    harnessId: 'comparison-test',
    harnessVersion: 'v1',
    config: { traceMode: 'portable_events' },
  });
  const baselineResult = { ok: true, text: 'baseline terminal' };
  const candidateResult = { ok: false, text: 'private candidate failure' };
  const comparisonRun = await runXHarnessComparison({
    baseline: {
      harnessSnapshot,
      traceIdentity: {
        taskId: 'task-1',
        attemptId: 'attempt-baseline',
        modelConfigId: 'model-config-1',
      },
      ports: createPorts({
        label: 'baseline',
        result: baselineResult,
        executionOrder,
      }),
    },
    candidate: {
      harnessSnapshot,
      traceIdentity: {
        taskId: 'task-1',
        attemptId: 'attempt-candidate',
        modelConfigId: 'model-config-1',
      },
      ports: createPorts({
        label: 'candidate',
        result: candidateResult,
        executionOrder,
      }),
    },
  });

  assert.deepEqual(executionOrder, ['baseline', 'candidate']);
  assert.deepEqual(comparisonRun.baseline.result, baselineResult);
  assert.deepEqual(comparisonRun.candidate.result, candidateResult);
  assert.deepEqual(comparisonRun.traceComparison.identityDifferences, [
    'attemptId',
  ]);
  assert.deepEqual(comparisonRun.traceComparison.eventDifferences[0], {
    eventIndex: 2,
    baselineRound: 0,
    candidateRound: 0,
    baselineKind: 'model_call_completed',
    candidateKind: 'model_call_completed',
    differingFields: ['outcome', 'functionCallCount', 'structuredOutputCount'],
  });
  assert.deepEqual(comparisonRun.traceComparison.outcomeDifferences, [
    'ok',
    'terminalSource',
  ]);
  assert.equal(Object.isFrozen(comparisonRun), true);
  assert.equal(
    JSON.stringify(comparisonRun.traceComparison).includes(
      'private candidate failure',
    ),
    false,
  );
});
