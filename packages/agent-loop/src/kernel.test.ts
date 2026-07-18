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
    { kind: 'round_completed', round: 0, outcome: 'continue' },
    {
      kind: 'round_started',
      round: 1,
      historyItemCount: 4,
      sawFirstModelRequest: true,
    },
    {
      kind: 'round_completed',
      round: 1,
      outcome: 'terminal',
      terminalOk: true,
    },
  ]);
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
      resolveTerminalCandidate({ source }) {
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

void test('kernel fails closed when structured output remains unhandled', async () => {
  const failures: string[] = [];
  const settlements: string[] = [];

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
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.text, /structured_output_unhandled/);
  assert.deepEqual(failures, ['structured_output_unhandled']);
  assert.deepEqual(settlements, ['structured_output_unhandled']);
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
    },
  ]);
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
