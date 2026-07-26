import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type AgentLoopKernelEvent,
  type AgentLoopKernelPorts,
} from '@geulbat/agent-loop/kernel';

import { runXHarness } from './runner.js';
import { createHarnessConfigSnapshot } from './harness-snapshot.js';

interface TestResult {
  ok: boolean;
  text: string;
}

interface TestFunctionCall {
  name: string;
}

type TestPorts = AgentLoopKernelPorts<
  TestResult,
  TestFunctionCall,
  never,
  string
>;

void test('runs a daemon-free model-tool-model flow and returns the portable trace', async () => {
  const history: string[] = [];
  const observedEvents: AgentLoopKernelEvent[] = [];
  const terminalSettlements: Array<{ result: TestResult; source: string }> = [];
  const functionCall = { name: 'look_up_weather' };
  const ports: TestPorts = {
    getHistoryItemCount: () => history.length,
    async runModelRound(context) {
      if (context.round === 0) {
        return {
          ok: true,
          value: {
            assistantText: 'I will check.',
            terminalResult: { ok: true, text: 'unused' },
            functionCalls: [functionCall],
          },
        };
      }
      return {
        ok: true,
        value: {
          assistantText: 'It is sunny.',
          terminalResult: { ok: true, text: 'It is sunny.' },
          functionCalls: [],
        },
      };
    },
    async processStructuredOutputs() {
      return { ok: true, handled: false };
    },
    appendAssistantText({ text }) {
      history.push(`assistant:${text}`);
    },
    appendHistoryItems(items) {
      history.push(...items);
    },
    appendFunctionCalls(functionCalls) {
      history.push(...functionCalls.map((call) => `call:${call.name}`));
    },
    async processFunctionCalls({ functionCalls }) {
      history.push(...functionCalls.map((call) => `result:${call.name}:sunny`));
      return { ok: true, value: undefined };
    },
    createTerminalFailure(failure) {
      return { ok: false, text: failure.message };
    },
    settleTerminal({ result, source }) {
      terminalSettlements.push({ result, source });
    },
    observe(event) {
      observedEvents.push(event);
    },
  };

  const harnessSnapshot = createHarnessConfigSnapshot({
    harnessId: 'daemon-free-test',
    harnessVersion: 'v1',
    config: { traceMode: 'portable_events' },
  });
  const run = await runXHarness({
    harnessSnapshot,
    traceIdentity: {
      taskId: 'task-1',
      attemptId: 'attempt-1',
      modelConfigId: 'model-config-1',
    },
    ports,
  });

  assert.equal(run.trace.harnessSnapshotId, harnessSnapshot.harnessSnapshotId);
  assert.deepEqual(run.trace.loopImplementation, {
    implementationId: 'geulbat.agent-loop.kernel',
    contractVersion: '1',
  });
  assert.deepEqual(run.result, { ok: true, text: 'It is sunny.' });
  assert.deepEqual(history, [
    'assistant:I will check.',
    'call:look_up_weather',
    'result:look_up_weather:sunny',
    'assistant:It is sunny.',
  ]);
  assert.deepEqual(run.trace.events, [
    {
      kind: 'round_started',
      round: 0,
      historyItemCount: 0,
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
      historyItemCount: 3,
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
  ]);
  assert.deepEqual(run.trace.outcome, {
    ok: true,
    terminalSource: 'natural',
  });
  assert.equal(JSON.stringify(run.trace).includes('look_up_weather'), false);
  assert.deepEqual(observedEvents, run.trace.events);
  assert.deepEqual(terminalSettlements, [
    {
      result: { ok: true, text: 'It is sunny.' },
      source: 'natural',
    },
  ]);
});
