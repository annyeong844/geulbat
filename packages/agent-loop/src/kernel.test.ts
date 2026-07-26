import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runAgentLoopKernel,
  type AgentLoopKernelEvent,
  type AgentLoopKernelPorts,
} from './kernel.js';

interface TestResult {
  ok: boolean;
  text: string;
}

interface TestFunctionCall {
  name: string;
}

interface TestStructuredOutput {
  kind: string;
}

type TestPorts = AgentLoopKernelPorts<
  TestResult,
  TestFunctionCall,
  TestStructuredOutput,
  string
>;

void test('kernel owns the model-to-tool-to-model round state machine and event order', async () => {
  const history = ['user'];
  const events: AgentLoopKernelEvent[] = [];
  const modelContexts: Array<[number, boolean]> = [];
  const settlements: TestResult[] = [];

  const result = await runAgentLoopKernel<
    TestResult,
    TestFunctionCall,
    TestStructuredOutput,
    string
  >({
    ports: {
      getHistoryItemCount: () => history.length,
      async runModelRound(context) {
        modelContexts.push([context.round, context.sawFirstModelRequest]);
        if (context.round === 0) {
          return {
            ok: true,
            value: {
              assistantText: 'checking',
              terminalResult: { ok: true, text: '' },
              functionCalls: [{ name: 'read_file' }],
            },
          };
        }
        return {
          ok: true,
          value: {
            assistantText: 'done',
            terminalResult: { ok: true, text: 'done' },
            functionCalls: [],
          },
        };
      },
      async processStructuredOutputs() {
        return { ok: true, handled: false };
      },
      appendAssistantText({ text }) {
        if (text !== '') history.push(`assistant:${text}`);
      },
      appendHistoryItems(items) {
        history.push(...items);
      },
      appendFunctionCalls(functionCalls) {
        history.push(...functionCalls.map((call) => `call:${call.name}`));
      },
      async processFunctionCalls({ functionCalls }) {
        history.push(...functionCalls.map((call) => `output:${call.name}`));
        return { ok: true, value: undefined };
      },
      createTerminalFailure(failure) {
        return { ok: false, text: failure.message };
      },
      settleTerminal({ result: terminalResult }) {
        settlements.push(terminalResult);
      },
      observe(event) {
        events.push(event);
      },
    },
  });

  assert.deepEqual(result, { ok: true, text: 'done' });
  assert.deepEqual(modelContexts, [
    [0, false],
    [1, true],
  ]);
  assert.deepEqual(history, [
    'user',
    'assistant:checking',
    'call:read_file',
    'output:read_file',
    'assistant:done',
  ]);
  assert.deepEqual(settlements, [result]);
  assert.deepEqual(events, [
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
  ]);
});

void test('kernel ends the turn after a successful turn-ending tool without another model call', async () => {
  let modelCallCount = 0;
  const terminalCandidates: string[] = [];
  const terminalSources: string[] = [];

  const result = await runAgentLoopKernel<
    TestResult,
    TestFunctionCall,
    TestStructuredOutput,
    string
  >({
    ports: createSingleRoundPorts({
      async runModelRound() {
        modelCallCount += 1;
        return {
          ok: true,
          value: {
            assistantText: '',
            terminalResult: { ok: true, text: '' },
            functionCalls: [{ name: 'ask_user' }],
          },
        };
      },
      shouldEndTurnAfterFunctionCalls({ functionCalls }) {
        return functionCalls.some((call) => call.name === 'ask_user');
      },
      async resolveTerminalCandidate({ source }) {
        terminalCandidates.push(source);
        return { kind: 'terminal' };
      },
      settleTerminal({ source }) {
        terminalSources.push(source);
      },
    }),
  });

  assert.deepEqual(result, { ok: true, text: '' });
  assert.equal(modelCallCount, 1);
  assert.deepEqual(terminalCandidates, ['tool_completion']);
  assert.deepEqual(terminalSources, ['tool_completion']);
});

void test('kernel commits an opaque model history batch once and skips normalized replay', async () => {
  const history = ['user'];

  const result = await runAgentLoopKernel<
    TestResult,
    TestFunctionCall,
    TestStructuredOutput,
    string
  >({
    ports: {
      getHistoryItemCount: () => history.length,
      async runModelRound({ round }) {
        return round === 0
          ? {
              ok: true,
              value: {
                assistantText: 'checking',
                terminalResult: { ok: true, text: '' },
                functionCalls: [{ name: 'read_file' }],
                itemsToAppend: ['raw:reasoning', 'raw:function_call'],
              },
            }
          : {
              ok: true,
              value: {
                assistantText: 'done',
                terminalResult: { ok: true, text: 'done' },
                functionCalls: [],
                itemsToAppend: ['raw:message'],
              },
            };
      },
      async processStructuredOutputs() {
        return { ok: true, handled: false };
      },
      appendAssistantText() {
        assert.fail(
          'normalized assistant history must not duplicate raw items',
        );
      },
      appendHistoryItems(items) {
        history.push(...items);
      },
      appendFunctionCalls() {
        assert.fail('normalized function calls must not duplicate raw items');
      },
      async processFunctionCalls({ functionCalls }) {
        history.push(...functionCalls.map((call) => `output:${call.name}`));
        return { ok: true, value: undefined };
      },
      createTerminalFailure(failure) {
        return { ok: false, text: failure.message };
      },
      settleTerminal() {},
    },
  });

  assert.deepEqual(result, { ok: true, text: 'done' });
  assert.deepEqual(history, [
    'user',
    'raw:reasoning',
    'raw:function_call',
    'output:read_file',
    'raw:message',
  ]);
});

void test('kernel continues a handled structured result only through the terminal-candidate port', async () => {
  const history: string[] = [];
  const sources: string[] = [];

  const result = await runAgentLoopKernel<
    TestResult,
    TestFunctionCall,
    TestStructuredOutput,
    string
  >({
    ports: {
      getHistoryItemCount: () => history.length,
      async runModelRound({ round }) {
        return round === 0
          ? {
              ok: true,
              value: {
                assistantText: '',
                terminalResult: { ok: true, text: '' },
                functionCalls: [],
                structuredOutputs: [{ kind: 'artifact' }],
              },
            }
          : {
              ok: true,
              value: {
                assistantText: 'after steer',
                terminalResult: { ok: true, text: 'after steer' },
                functionCalls: [],
              },
            };
      },
      async processStructuredOutputs({ structuredOutputs }) {
        return structuredOutputs.length > 0
          ? {
              ok: true,
              handled: true,
              result: { ok: true, text: 'artifact accepted' },
            }
          : { ok: true, handled: false };
      },
      appendAssistantText({ text }) {
        if (text !== '') history.push(text);
      },
      appendHistoryItems(items) {
        history.push(...items);
      },
      appendFunctionCalls() {
        assert.fail('structured output must not fall through to tool calls');
      },
      async processFunctionCalls() {
        assert.fail('structured output must not execute tools');
      },
      async resolveTerminalCandidate({ source }) {
        sources.push(source);
        return source === 'structured_output'
          ? { kind: 'continue', historyText: 'artifact accepted' }
          : { kind: 'terminal' };
      },
      createTerminalFailure(failure) {
        return { ok: false, text: failure.message };
      },
      settleTerminal() {},
    },
  });

  assert.deepEqual(result, { ok: true, text: 'after steer' });
  assert.deepEqual(sources, ['structured_output', 'natural']);
  assert.deepEqual(history, ['artifact accepted', 'after steer']);
});

void test('kernel fails closed for blocked and unavailable terminal assessments', async () => {
  for (const assessment of [
    {
      kind: 'blocked' as const,
      message: 'completion is blocked on user authority',
    },
    {
      kind: 'verification_unavailable' as const,
      message: 'completion evidence could not be read',
    },
  ]) {
    const failures: string[] = [];
    const settlements: string[] = [];

    const result = await runAgentLoopKernel<
      TestResult,
      TestFunctionCall,
      TestStructuredOutput,
      string
    >({
      ports: createSingleRoundPorts({
        async resolveTerminalCandidate() {
          return assessment;
        },
        createTerminalFailure(failure) {
          failures.push(failure.kind);
          return { ok: false, text: failure.message };
        },
        settleTerminal({ source }) {
          settlements.push(source);
        },
      }),
    });

    assert.deepEqual(result, { ok: false, text: assessment.message });
    assert.deepEqual(failures, [assessment.kind]);
    assert.deepEqual(settlements, [assessment.kind]);
  }
});

void test('kernel fails closed when structured output remains unhandled', async () => {
  const failures: string[] = [];
  const settlements: string[] = [];
  const events: AgentLoopKernelEvent[] = [];

  const result = await runAgentLoopKernel<
    TestResult,
    TestFunctionCall,
    TestStructuredOutput,
    string
  >({
    ports: createSingleRoundPorts({
      async runModelRound() {
        return {
          ok: true,
          value: {
            assistantText: '',
            terminalResult: { ok: true, text: '' },
            functionCalls: [],
            structuredOutputs: [{ kind: 'unknown' }],
          },
        };
      },
      createTerminalFailure(failure) {
        failures.push(failure.kind);
        return { ok: false, text: failure.message };
      },
      settleTerminal({ source }) {
        settlements.push(source);
      },
      observe(event) {
        events.push(event);
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.text, /structured_output_unhandled/);
  assert.deepEqual(failures, ['structured_output_unhandled']);
  assert.deepEqual(settlements, ['structured_output_unhandled']);
  assert.deepEqual(events, [
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
      outcome: 'unhandled',
    },
    {
      kind: 'round_completed',
      round: 0,
      outcome: 'terminal',
      terminalOk: false,
      terminalSource: 'structured_output_unhandled',
    },
  ]);
});

void test('kernel records a redacted model failure envelope', async () => {
  const events: AgentLoopKernelEvent[] = [];

  const result = await runAgentLoopKernel<
    TestResult,
    TestFunctionCall,
    TestStructuredOutput,
    string
  >({
    ports: createSingleRoundPorts({
      async runModelRound() {
        return {
          ok: false,
          result: { ok: false, text: 'private provider failure body' },
        };
      },
      observe(event) {
        events.push(event);
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(events, [
    {
      kind: 'round_started',
      round: 0,
      historyItemCount: 0,
      sawFirstModelRequest: false,
    },
    { kind: 'model_call_started', round: 0 },
    { kind: 'model_call_completed', round: 0, outcome: 'failure' },
    {
      kind: 'round_completed',
      round: 0,
      outcome: 'terminal',
      terminalOk: false,
      terminalSource: 'model_failure',
    },
  ]);
  assert.equal(
    JSON.stringify(events).includes('private provider failure'),
    false,
  );
});

void test('kernel records a redacted tool failure envelope', async () => {
  const events: AgentLoopKernelEvent[] = [];

  const result = await runAgentLoopKernel<
    TestResult,
    TestFunctionCall,
    TestStructuredOutput,
    string
  >({
    ports: createSingleRoundPorts({
      async runModelRound() {
        return {
          ok: true,
          value: {
            assistantText: 'calling a tool',
            terminalResult: { ok: true, text: 'unused' },
            functionCalls: [{ name: 'private_tool_name' }],
          },
        };
      },
      async processFunctionCalls() {
        return {
          ok: false,
          result: { ok: false, text: 'private tool output body' },
        };
      },
      observe(event) {
        events.push(event);
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(events, [
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
    { kind: 'tool_calls_completed', round: 0, outcome: 'failure' },
    {
      kind: 'round_completed',
      round: 0,
      outcome: 'terminal',
      terminalOk: false,
      terminalSource: 'tool_failure',
    },
  ]);
  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes('private_tool_name'), false);
  assert.equal(serializedEvents.includes('private tool output'), false);
});

void test('kernel checks abort before model dispatch and still completes the round trace', async () => {
  const controller = new AbortController();
  controller.abort();
  const events: AgentLoopKernelEvent[] = [];
  let modelCalled = false;

  const result = await runAgentLoopKernel<
    TestResult,
    TestFunctionCall,
    TestStructuredOutput,
    string
  >({
    signal: controller.signal,
    ports: createSingleRoundPorts({
      async runModelRound() {
        modelCalled = true;
        return {
          ok: true,
          value: {
            assistantText: 'unexpected',
            terminalResult: { ok: true, text: 'unexpected' },
            functionCalls: [],
          },
        };
      },
      observe(event) {
        events.push(event);
      },
    }),
  });

  assert.equal(modelCalled, false);
  assert.deepEqual(result, { ok: false, text: 'run cancelled' });
  assert.deepEqual(events, [
    {
      kind: 'round_started',
      round: 0,
      historyItemCount: 0,
      sawFirstModelRequest: false,
    },
    {
      kind: 'round_completed',
      round: 0,
      outcome: 'terminal',
      terminalOk: false,
      terminalSource: 'aborted',
    },
  ]);
});

void test('kernel awaits each durable checkpoint before observation and later host work', async () => {
  const order: string[] = [];
  let releaseFirstCheckpoint: (() => void) | undefined;
  let markFirstCheckpointStarted: (() => void) | undefined;
  const firstCheckpointStarted = new Promise<void>((resolve) => {
    markFirstCheckpointStarted = resolve;
  });
  const firstCheckpointRelease = new Promise<void>((resolve) => {
    releaseFirstCheckpoint = resolve;
  });

  const run = runAgentLoopKernel<
    TestResult,
    TestFunctionCall,
    TestStructuredOutput,
    string
  >({
    ports: createSingleRoundPorts({
      async checkpointEvent(event) {
        order.push(`checkpoint:${event.kind}`);
        if (event.kind === 'round_started') {
          markFirstCheckpointStarted?.();
          await firstCheckpointRelease;
        }
      },
      observe(event) {
        order.push(`observe:${event.kind}`);
      },
      async runModelRound() {
        order.push('model');
        return {
          ok: true,
          value: {
            assistantText: 'done',
            terminalResult: { ok: true, text: 'done' },
            functionCalls: [],
          },
        };
      },
      settleTerminal() {
        order.push('settle');
      },
    }),
  });

  const firstProgress = await Promise.race([
    firstCheckpointStarted.then(() => 'checkpoint' as const),
    run.then(() => 'completed' as const),
  ]);
  assert.equal(firstProgress, 'checkpoint');
  assert.deepEqual(order, ['checkpoint:round_started']);
  releaseFirstCheckpoint?.();
  await run;

  for (let index = 0; index < order.length; index += 1) {
    const entry = order[index];
    if (entry?.startsWith('observe:') !== true) {
      continue;
    }
    assert.equal(order[index - 1], entry.replace('observe:', 'checkpoint:'));
  }
  assert.ok(order.indexOf('observe:round_started') < order.indexOf('model'));
  assert.ok(
    order.indexOf('checkpoint:round_completed') < order.indexOf('settle'),
  );
});

void test('kernel propagates checkpoint rejection before model or terminal settlement', async () => {
  let modelCalled = false;
  let observed = false;
  let settled = false;

  await assert.rejects(
    runAgentLoopKernel<
      TestResult,
      TestFunctionCall,
      TestStructuredOutput,
      string
    >({
      ports: createSingleRoundPorts({
        async checkpointEvent() {
          throw new Error('durable checkpoint failed');
        },
        observe() {
          observed = true;
        },
        async runModelRound() {
          modelCalled = true;
          return {
            ok: true,
            value: {
              assistantText: 'unexpected',
              terminalResult: { ok: true, text: 'unexpected' },
              functionCalls: [],
            },
          };
        },
        settleTerminal() {
          settled = true;
        },
      }),
    }),
    /durable checkpoint failed/,
  );
  assert.equal(observed, false);
  assert.equal(modelCalled, false);
  assert.equal(settled, false);
});

function createSingleRoundPorts(overrides: Partial<TestPorts> = {}): TestPorts {
  return {
    getHistoryItemCount: () => 0,
    async runModelRound() {
      return {
        ok: true,
        value: {
          assistantText: 'done',
          terminalResult: { ok: true, text: 'done' },
          functionCalls: [],
        },
      };
    },
    async processStructuredOutputs() {
      return { ok: true, handled: false };
    },
    appendAssistantText() {},
    appendHistoryItems() {},
    appendFunctionCalls() {},
    async processFunctionCalls() {
      return { ok: true, value: undefined };
    },
    createTerminalFailure(failure) {
      return { ok: false, text: failure.message };
    },
    settleTerminal() {},
    ...overrides,
  };
}
