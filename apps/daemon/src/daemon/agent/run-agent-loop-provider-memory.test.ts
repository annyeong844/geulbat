import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { type ProviderReplayScopeId } from '@geulbat/protocol/provider-auth';
import { runAgentLoop } from './run-agent-loop.js';
import type { AgentEvent } from './events.js';
import { createDaemonContext } from '../context.js';
import { readProviderRoundHistory } from '../sessions/provider-round-journal.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import { createResponsesWebSocketSessionStore } from '../llm/provider/transport/responses-websocket-cache.js';
import type { ResponsesRequestMeasurement } from '../llm/provider/transport/responses-websocket.js';
import type { HistoryItem } from '../llm/index.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import {
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
} from '../../test-support/provider-response-fixtures.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';
import { createTestContextBudgetRound } from '../../test-support/run-agent-loop.js';

function testRequestMeasurement(
  serializedBytes: number,
): ResponsesRequestMeasurement {
  return {
    serializedBytes,
    dominantPressureSource: 'history',
    serializedBytesBySource: {
      history: serializedBytes,
      instructions: 0,
      toolDefinitions: 0,
      envelope: 0,
    },
  };
}

void test('runAgentLoop projects a run-selected model to its provider round', async () => {
  const threadId = testThreadId(31);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-provider-'));
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  let observedProviderId: string | undefined;
  let observedModel: string | undefined;
  let observedReasoningEffort: string | undefined;
  let observedServiceTier: string | undefined;

  const result = await runAgentLoop({
    runId: 'run-loop-provider',
    runContext,
    prompt: 'hello grok',
    providerModel: {
      providerId: 'grok_oauth',
      model: 'grok-4.5',
    },
    reasoningEffort: 'high',
    serviceTier: 'standard',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-provider',
    }),
    modelRoundPort: {
      async runModelRound(args) {
        observedProviderId = args.providerRequestOptions.providerId;
        observedModel = args.providerRequestOptions.model;
        observedReasoningEffort = args.providerRequestOptions.reasoning.effort;
        observedServiceTier = args.providerRequestOptions.serviceTier;
        return {
          ok: true,
          value: {
            assistantText: 'provider ok',
            terminalResult: {
              ok: true,
              finalProse: 'provider ok',
            },
            functionCalls: [],
          },
        };
      },
    },
    onEvent: () => undefined,
  });

  assert.deepEqual(result, { ok: true, finalProse: 'provider ok' });
  assert.equal(observedProviderId, 'grok_oauth');
  assert.equal(observedModel, 'grok-4.5');
  assert.equal(observedReasoningEffort, 'high');
  assert.equal(observedServiceTier, 'standard');
});

void test('runAgentLoop wires the runtime memory owner into pre-dispatch preparation', async () => {
  const threadId = testThreadId(311);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-context-preparation-'),
  );
  let preparationCalls = 0;
  let postRoundCalls = 0;

  const result = await runAgentLoop({
    runId: 'run-loop-context-preparation',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'continue safely',
    runtimeServices: {
      ...daemonContext,
      agent: {
        ...daemonContext.agent,
        loopMemory: {
          beginContextBudgetRound(args) {
            assert.equal(args.threadId, threadId);
            assert.equal(
              args.providerWebSocketSessions,
              daemonContext.provider.webSocketSessions,
            );
            return {
              onProviderRequestPrepared(measurement) {
                assert.equal(measurement.serializedBytes, 256);
                return { kind: 'prepare', reason: 'near_policy' };
              },
              async prepareBeforeModelRound() {
                preparationCalls += 1;
                return { kind: 'prepared' };
              },
              getRequestBytes() {
                return 256;
              },
              getToolResultContextBudget() {
                return {
                  kind: 'unknown',
                  modelKey: 'test\0test',
                  reason: 'usage_unavailable',
                };
              },
              publish() {},
            };
          },
          async compactAfterModelRound(args) {
            postRoundCalls += 1;
            assert.equal(
              args.providerWebSocketSessions,
              daemonContext.provider.webSocketSessions,
            );
            return { kind: 'not_needed', reason: 'under_threshold' };
          },
        },
      },
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-context-preparation',
    }),
    modelRoundPort: {
      async runModelRound(args) {
        assert.ok(args.onProviderRequestPrepared);
        assert.deepEqual(
          await args.onProviderRequestPrepared(testRequestMeasurement(256)),
          { kind: 'prepare', reason: 'near_policy' },
        );
        assert.ok(args.onContextPreparationRequired);
        assert.deepEqual(await args.onContextPreparationRequired(), {
          kind: 'prepared',
        });
        return {
          ok: true,
          value: {
            assistantText: 'prepared',
            terminalResult: { ok: true, finalProse: 'prepared' },
            functionCalls: [],
          },
        };
      },
    },
    onEvent: () => undefined,
  });

  assert.deepEqual(result, { ok: true, finalProse: 'prepared' });
  assert.equal(preparationCalls, 1);
  assert.equal(postRoundCalls, 1);
});

void test('runAgentLoop hands the completed model budget to the same-round tool owner after appending calls', async () => {
  const threadId = testThreadId(1311);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-tool-result-budget-'),
  );
  let modelRound = 0;
  let budgetReadAfterCallAppend = false;
  let observedBudget: unknown;

  const result = await runAgentLoop({
    runId: 'run-loop-tool-result-budget',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'measure the tool round',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-tool-result-budget',
    }),
    memoryPort: {
      beginContextBudgetRound(args) {
        return {
          onProviderRequestPrepared() {},
          async prepareBeforeModelRound() {
            return { kind: 'prepared' };
          },
          getRequestBytes() {
            return 1_000;
          },
          getToolResultContextBudget() {
            budgetReadAfterCallAppend = args.history.some(
              (item) =>
                item.kind === 'function_call' &&
                item.callId === 'call-tool-result-budget',
            );
            return {
              kind: 'available',
              quality: 'exact',
              modelKey: 'openai_codex_direct\0gpt-test',
              availableRequestBytes: 700,
            };
          },
          publish() {},
        };
      },
      async compactAfterModelRound() {
        return { kind: 'not_needed', reason: 'under_threshold' };
      },
    },
    modelRoundPort: {
      async runModelRound() {
        modelRound += 1;
        if (modelRound === 1) {
          return {
            ok: true,
            value: {
              assistantText: '',
              terminalResult: { ok: true, finalProse: '' },
              functionCalls: [
                {
                  id: 'fc-tool-result-budget',
                  callId: 'call-tool-result-budget',
                  name: 'list_files',
                  arguments: '{}',
                },
              ],
            },
          };
        }
        return {
          ok: true,
          value: {
            assistantText: 'done',
            terminalResult: { ok: true, finalProse: 'done' },
            functionCalls: [],
          },
        };
      },
    },
    toolRuntimePort: {
      async processFunctionCalls(args) {
        observedBudget = args.toolResultContextBudget;
        return { ok: true, value: undefined };
      },
    },
    onEvent() {},
  });

  assert.equal(budgetReadAfterCallAppend, true);
  assert.deepEqual(observedBudget, {
    kind: 'available',
    quality: 'exact',
    modelKey: 'openai_codex_direct\0gpt-test',
    availableRequestBytes: 700,
  });
  assert.deepEqual(result, { ok: true, finalProse: 'done' });
});

void test('runAgentLoop exposes one consent-backed cross-provider overflow recovery', async () => {
  const threadId = testThreadId(312);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-provider-transition-recovery-'),
  );
  const history: HistoryItem[] = [{ kind: 'user', text: 'continue' }];
  let recoveryCalls = 0;

  const result = await runAgentLoop({
    runId: 'run-loop-provider-transition-recovery',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'continue',
    providerModel: {
      providerId: 'openai_codex_direct',
      model: 'gpt-5.6-luna',
    },
    providerTransitionRecovery: {
      sourceModelId: 'grok-4.5',
      sourceReasoningEffort: 'high',
    },
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-provider-transition-recovery',
    }),
    historyPort: {
      async loadInitialHistory() {
        return history;
      },
    },
    modelRoundPort: {
      async runModelRound(args) {
        assert.ok(args.onContextOverflow);
        assert.equal(await args.onContextOverflow(), true);
        assert.equal(await args.onContextOverflow(), false);
        assert.deepEqual(args.history, [
          { kind: 'user', text: 'portable handoff' },
          { kind: 'user', text: 'continue' },
        ]);
        return {
          ok: true,
          value: {
            assistantText: 'continued',
            terminalResult: { ok: true, finalProse: 'continued' },
            functionCalls: [],
          },
        };
      },
    },
    memoryPort: {
      beginContextBudgetRound(args) {
        return createTestContextBudgetRound(args.onContextUsage);
      },
      async recoverProviderTransitionAfterOverflow(args) {
        recoveryCalls += 1;
        assert.equal(args.workspaceRoot, workspaceRoot);
        assert.equal(args.threadId, threadId);
        assert.equal(args.prompt, 'continue');
        assert.deepEqual(args.source, {
          providerId: 'grok_oauth',
          model: 'grok-4.5',
        });
        assert.deepEqual(args.target, {
          providerId: 'openai_codex_direct',
          model: 'gpt-5.6-luna',
        });
        assert.equal(args.sourceReasoningEffort, 'high');
        args.history.splice(
          0,
          args.history.length,
          { kind: 'user', text: 'portable handoff' },
          { kind: 'user', text: 'continue' },
        );
        return true;
      },
      async compactAfterModelRound() {
        return { kind: 'not_needed', reason: 'under_threshold' };
      },
    },
    onEvent: () => undefined,
  });

  assert.deepEqual(result, { ok: true, finalProse: 'continued' });
  assert.equal(recoveryCalls, 1);
});

void test('runAgentLoop keeps prior tool output bytes immutable after successful model consumption', async () => {
  const threadId = testThreadId(32);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-loop-output-'));
  const outputRef = `tool-output:${threadId}/run-previous/call-previous`;
  const originalOutput = JSON.stringify({
    status: 'exit',
    stdout: 'large output'.repeat(10_000),
    outputRef,
    fullOutputBytes: 120_000,
    fullOutputChars: 120_000,
  });
  const history: HistoryItem[] = [
    {
      kind: 'function_call',
      id: 'fc-previous',
      callId: 'call-previous',
      name: 'exec_command',
      arguments: '{"cmd":"rg pattern ."}',
    },
    {
      kind: 'function_call_output',
      callId: 'call-previous',
      output: originalOutput,
    },
  ];
  let observedOutput = '';

  const result = await runAgentLoop({
    runId: 'run-loop-output-compaction',
    runContext: makeRunContext({
      threadId,
      stateRoot: workspaceRoot,
    }),
    prompt: 'continue',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-output-compaction',
    }),
    historyPort: {
      async loadInitialHistory() {
        return history;
      },
    },
    modelRoundPort: {
      async runModelRound(args) {
        const output = args.history.find(
          (item) => item.kind === 'function_call_output',
        );
        if (output?.kind === 'function_call_output') {
          observedOutput = output.output;
        }
        return {
          ok: true,
          value: {
            assistantText: 'consumed',
            terminalResult: { ok: true, finalProse: 'consumed' },
            functionCalls: [],
          },
        };
      },
    },
    onEvent: () => undefined,
  });

  assert.deepEqual(result, { ok: true, finalProse: 'consumed' });
  assert.equal(observedOutput, originalOutput);
  const retained = history.find((item) => item.kind === 'function_call_output');
  assert.equal(retained?.kind, 'function_call_output');
  if (retained?.kind !== 'function_call_output') {
    throw new Error('expected retained function_call_output');
  }
  assert.equal(retained.output, originalOutput);
});

void test('runAgentLoop preserves provider output items exactly once across a tool round', async () => {
  const threadId = testThreadId(1206);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-provider-output-continuity-'),
  );
  const history: HistoryItem[] = [{ kind: 'user', text: 'look it up' }];
  const events: AgentEvent[] = [];
  const observerRecords: unknown[] = [];
  const reasoningItem = {
    id: 'rs_round_1',
    type: 'reasoning',
    summary: [],
    encrypted_content: 'opaque-reasoning-checkpoint',
  };
  const functionCallItem = {
    id: 'fc_round_1',
    type: 'function_call',
    call_id: 'call_round_1',
    name: 'update_plan',
    arguments: '{"query":"continuity"}',
    status: 'completed',
  };
  const finalMessageItem = {
    id: 'msg_round_2',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'done' }],
  };
  const replayScopeId = `sha256:${'7'.repeat(64)}` as ProviderReplayScopeId;
  const providerItem = (data: unknown) => ({
    kind: 'backend_item' as const,
    data,
    providerReplayScopeId: replayScopeId,
  });
  let modelRound = 0;
  const result = await runAgentLoop({
    runId: 'run-loop-provider-output-continuity',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'look it up',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-provider-output-continuity',
    }),
    historyPort: {
      async loadInitialHistory() {
        return history;
      },
    },
    modelRoundPort: {
      async runModelRound() {
        modelRound += 1;
        if (modelRound === 1) {
          return {
            ok: true,
            value: {
              assistantText: '',
              terminalResult: { ok: true, finalProse: '' },
              functionCalls: [
                {
                  id: 'fc_round_1',
                  callId: 'call_round_1',
                  name: 'update_plan',
                  arguments: '{"query":"continuity"}',
                },
              ],
              itemsToAppend: [
                providerItem(reasoningItem),
                providerItem(functionCallItem),
              ],
            },
          };
        }

        assert.deepEqual(history, [
          { kind: 'user', text: 'look it up' },
          providerItem(reasoningItem),
          providerItem(functionCallItem),
          {
            kind: 'function_call_output',
            callId: 'call_round_1',
            output: '{"result":"found"}',
          },
        ]);
        return {
          ok: true,
          value: {
            assistantText: 'done',
            terminalResult: { ok: true, finalProse: 'done' },
            functionCalls: [],
            itemsToAppend: [providerItem(finalMessageItem)],
          },
        };
      },
    },
    toolRuntimePort: {
      async processFunctionCalls(args) {
        assert.deepEqual(args.history, [
          { kind: 'user', text: 'look it up' },
          providerItem(reasoningItem),
          providerItem(functionCallItem),
        ]);
        args.history.push({
          kind: 'function_call_output',
          callId: args.functionCalls[0]?.callId ?? '',
          output: '{"result":"found"}',
        });
        return { ok: true, value: undefined };
      },
    },
    observer: {
      recordSnapshot(snapshot) {
        observerRecords.push(snapshot);
      },
      recordEvent(event) {
        observerRecords.push(event);
      },
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(
    result,
    { ok: true, finalProse: 'done' },
    JSON.stringify(events),
  );
  assert.equal(modelRound, 2);
  assert.deepEqual(history, [
    { kind: 'user', text: 'look it up' },
    providerItem(reasoningItem),
    providerItem(functionCallItem),
    {
      kind: 'function_call_output',
      callId: 'call_round_1',
      output: '{"result":"found"}',
    },
    providerItem(finalMessageItem),
  ]);
  const transcript = await readTranscriptEntries(workspaceRoot, threadId);
  assert.doesNotMatch(
    JSON.stringify({ events, observerRecords, transcript }),
    /opaque-reasoning-checkpoint/u,
  );
  const providerRounds = await readProviderRoundHistory(
    workspaceRoot,
    threadId,
  );
  assert.deepEqual(providerRounds[0]?.functionCalls, [
    {
      id: functionCallItem.id,
      callId: functionCallItem.call_id,
      name: functionCallItem.name,
      arguments: functionCallItem.arguments,
      replaySafe: true,
      recoveryStrategy: 'replay_safe',
    },
  ]);
});

void test('runAgentLoop compacts successful round input before appending the new assistant tail', async () => {
  const threadId = testThreadId(1204);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-native-compaction-'),
  );
  const history: HistoryItem[] = [{ kind: 'user', text: 'old context' }];
  let memoryCalls = 0;
  const events: AgentEvent[] = [];

  const result = await runAgentLoop({
    runId: 'run-loop-native-compaction',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'continue',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-native-compaction',
    }),
    historyPort: {
      async loadInitialHistory() {
        return history;
      },
    },
    modelRoundPort: {
      async runModelRound(args) {
        await args.onProviderRequestPrepared?.(testRequestMeasurement(400));
        return {
          ok: true,
          value: {
            assistantText: 'new tail',
            terminalResult: { ok: true, finalProse: 'new tail' },
            functionCalls: [],
            providerUsageTelemetry: { inputTokens: 90 },
          },
        };
      },
    },
    memoryPort: {
      beginContextBudgetRound(args) {
        return createTestContextBudgetRound(args.onContextUsage);
      },
      async compactAfterModelRound(args) {
        memoryCalls += 1;
        assert.equal(args.inputTokens, 90);
        assert.equal(args.contextBudgetRound.getRequestBytes(), 400);
        assert.deepEqual(args.history, [{ kind: 'user', text: 'old context' }]);
        const contextUsage = {
          state: 'measured' as const,
          quality: 'exact' as const,
          modelId: args.providerRequestOptions.model,
          inputTokens: 90,
          contextWindow: 100,
          thresholdTokens: 90,
          requestBytes: 400,
        };
        args.contextBudgetRound.publish(contextUsage);
        args.history.splice(0, args.history.length, {
          kind: 'provider_native_compaction',
          providerId: 'openai_codex_direct',
          model: args.providerRequestOptions.model,
          output: [
            {
              type: 'compaction',
              encrypted_content: 'opaque-checkpoint',
            },
          ],
        });
        args.contextBudgetRound.publish({
          ...contextUsage,
          state: 'compacted',
        });
        return {
          kind: 'compacted',
          providerRoundAnchorEntryId: 'unused-without-provider-items',
        };
      },
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, { ok: true, finalProse: 'new tail' });
  assert.equal(memoryCalls, 1);
  assert.deepEqual(
    events
      .filter((event) => event.type === 'context_usage_updated')
      .map((event) => event.payload.state),
    ['measured', 'compacted'],
  );
  assert.deepEqual(history, [
    {
      kind: 'provider_native_compaction',
      providerId: 'openai_codex_direct',
      model: daemonContext.provider.requestOptions.model,
      output: [
        {
          type: 'compaction',
          encrypted_content: 'opaque-checkpoint',
        },
      ],
    },
    { kind: 'assistant', phase: 'final_answer', text: 'new tail' },
  ]);
});

void test('runAgentLoop fails closed when a compaction transaction fails', async () => {
  const threadId = testThreadId(1205);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-compaction-failure-'),
  );
  const events: AgentEvent[] = [];

  const result = await runAgentLoop({
    runId: 'run-loop-compaction-failure',
    runContext: makeRunContext({ threadId, stateRoot: workspaceRoot }),
    prompt: 'continue',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-compaction-failure',
    }),
    modelRoundPort: {
      async runModelRound() {
        return {
          ok: true,
          value: {
            assistantText: 'must not commit',
            terminalResult: { ok: true, finalProse: 'must not commit' },
            functionCalls: [],
            providerUsageTelemetry: { inputTokens: 90 },
          },
        };
      },
    },
    memoryPort: {
      beginContextBudgetRound(args) {
        return createTestContextBudgetRound(args.onContextUsage);
      },
      async compactAfterModelRound() {
        return {
          kind: 'failed',
          reason: 'stale_snapshot',
          message: 'context changed while compaction was being committed',
        };
      },
    },
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(result, { ok: false, finalProse: '' });
  const terminal = events.at(-1);
  assert.equal(terminal?.type, 'error');
  if (terminal?.type === 'error') {
    assert.match(terminal.payload.message, /context_compaction_failed/u);
  }
});

void test('runAgentLoop forwards an injected provider websocket session store', async () => {
  const threadId = testThreadId(4);
  const daemonContext = createDaemonContext();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-provider-ws-store-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const providerWebSocketSessions = createResponsesWebSocketSessionStore();
  let seenStore:
    | { acquireWebSocket: typeof providerWebSocketSessions.acquireWebSocket }
    | undefined;

  const callModelImpl = createScriptedProviderCallModel([
    {
      ...providerFinalAnswerRound('store forwarded'),
      inspectInput(input) {
        seenStore = input.providerWebSocketSessions;
      },
    },
  ]);

  const result = await runAgentLoop({
    runId: 'run-loop-provider-ws-store',
    runContext,
    prompt: 'use injected websocket store',
    runtimeServices: {
      ...daemonContext,
      provider: {
        ...daemonContext.provider,
        webSocketSessions: providerWebSocketSessions,
      },
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-provider-ws-store',
    }),
    callModelImpl,
    onEvent: () => {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'store forwarded',
  });
  assert.equal(seenStore, providerWebSocketSessions);
});

void test('runAgentLoop can use the runtime service default websocket session store', async () => {
  const threadId = testThreadId(5);
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-loop-daemon-context-'),
  );
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const daemonContext = createDaemonContext();
  let seenStore:
    | {
        acquireWebSocket: typeof daemonContext.provider.webSocketSessions.acquireWebSocket;
      }
    | undefined;
  const callModelImpl = createScriptedProviderCallModel([
    {
      ...providerFinalAnswerRound('context noted'),
      inspectInput(input) {
        seenStore = input.providerWebSocketSessions;
      },
    },
  ]);

  const result = await runAgentLoop({
    runId: 'run-loop-daemon-context',
    runContext,
    prompt: 'summarize context work',
    runtimeServices: daemonContext,
    approvalContext: makeApprovalContext({
      computerSessionId: 'session-loop-daemon-context',
    }),
    callModelImpl,
    onEvent: () => {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'context noted',
  });
  assert.equal(seenStore, daemonContext.provider.webSocketSessions);
});
