import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AgentWaitBlockedReason,
  ArtifactCommittedEventPayload,
  InterjectAppliedEventPayload,
  KnownToolResultRaw,
  KnownToolResultRawTool,
  KnownToolResultSuccessEventPayload,
  RunEventPayloadMap,
  SharedRunEventPayloadMap,
  ToolResultRawMap,
  ToolResultSuccessEventPayload,
  UnknownToolResultRaw,
  UnknownToolResultSuccessEventPayload,
} from './run-events.js';
import type { RunId, ThreadId } from './ids.js';
import {
  AGENT_WAIT_APPROVAL_BLOCKED_REASON,
  AGENT_WAIT_BLOCKED_REASONS,
  isAgentLaunchToolRaw,
  isAgentRetryToolRaw,
  isAgentSetPriorityToolRaw,
  isAgentStopToolRaw,
  isAgentWaitBlockedReason,
  isAgentWaitToolRaw,
  isArtifactCommittedEventPayload,
  isContextUsageUpdatedEventPayload,
  isDoneEventPayload,
  isErrorEventPayload,
  isInterjectAppliedEventPayload,
  isOffloadedToolResultRaw,
  isProviderRequestDiagnostics,
  isProviderRetryDiagnostics,
  isProviderRuntimeStatusEventPayload,
  isRunAckEventPayload,
  isRunEvent,
  isRunUsageTotals,
  isSubagentApprovalRequiredEventPayload,
  isSubagentLaunchRequestState,
  isSubagentRuntimeDiagnostics,
  isSubagentSpawnedEventPayload,
  isSubagentTerminalEventPayload,
  isTextDeltaEventPayload,
  isThreadStatePersistedEventPayload,
  isThreadStatePersistFailedEventPayload,
  isToolCallDeltaEventPayload,
  isToolCallEventPayload,
  isToolCallSourcePayload,
  isToolOutputDeltaEventPayload,
  isToolResultEventPayload,
  isToolResultRaw,
} from './run-events.js';
import {
  isAgentChildTerminalReason,
  isAgentChildTerminalState,
} from './subagent-terminal.js';
import { isRunId, isThreadId } from './ids.js';
import { assertEveryFieldIsValidated } from './test-support/field-coverage.js';

function assertFixtureRunId(value: string): RunId {
  assert.equal(isRunId(value), true);
  return value as RunId;
}

function assertFixtureThreadId(value: string): ThreadId {
  assert.equal(isThreadId(value), true);
  return value as ThreadId;
}

const THREAD_ID = assertFixtureThreadId('11111111-1111-4111-8111-111111111111');
const RUN_ID = assertFixtureRunId('run-event-1');

void test('Goal updates carry only the aggregate public snapshot', () => {
  const event = {
    type: 'goal_updated',
    runId: RUN_ID,
    threadId: THREAD_ID,
    seq: 1,
    ts: '2026-07-26T00:01:00.000Z',
    payload: {
      goalId: 'goal-1',
      threadId: THREAD_ID,
      objective: 'Ship Goal mode',
      state: 'continuing',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:01:00.000Z',
    },
  };
  assert.equal(isRunEvent(event), true);
  assert.equal(
    isRunEvent({
      ...event,
      payload: {
        ...event.payload,
        votes: [{ verdict: 'not_achieved' }],
      },
    }),
    false,
  );
});

void test('subagent launch request states expose daemon restart interruption without treating arbitrary values as durable state', () => {
  assert.equal(isSubagentLaunchRequestState('interrupted'), true);
  assert.equal(isSubagentLaunchRequestState('running_after_restart'), false);
});

void test('child terminal reasons distinguish graceful daemon shutdown from restart recovery', () => {
  assert.equal(isAgentChildTerminalReason('daemon_shutdown'), true);
  assert.equal(isAgentChildTerminalReason('daemon_restart'), true);
  assert.equal(isAgentChildTerminalReason('daemon_stopped_somehow'), false);
});

void test('agent retry raw preserves fresh-attempt lineage and rejects invented retry dispositions', () => {
  const raw = {
    ok: true,
    previousChildRunId: 'previous-child',
    childRunId: 'fresh-child',
    childThreadId: 'fresh-thread',
    retryDisposition: 'created',
    launchState: 'queued',
    deferReason: 'configured_capacity',
    failureReason: null,
    modelId: 'gpt-5.6',
    reasoningEffort: 'medium',
    selectionSource: 'inherited',
  } as const;

  assert.equal(isAgentRetryToolRaw(raw), true);
  assert.equal(
    isAgentRetryToolRaw({
      ...raw,
      retryDisposition: 'reused_interrupted_attempt',
    }),
    false,
  );
});

void test('RunEvent envelope enforces producer sequence and timestamp contract', () => {
  const event = {
    runId: RUN_ID,
    threadId: THREAD_ID,
    seq: 0,
    type: 'run_ack',
    ts: '2026-07-19T12:00:00.000Z',
    payload: { runId: RUN_ID, threadId: THREAD_ID },
  } as const;

  assert.equal(isRunEvent(event), true);
  assert.equal(isRunEvent({ ...event, seq: Number.MAX_SAFE_INTEGER }), true);

  for (const seq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      isRunEvent({ ...event, seq }),
      false,
      `accepted invalid RunEvent sequence: ${seq}`,
    );
  }

  for (const ts of [
    'banana',
    '2026-07-19T12:00:00Z',
    '2026-07-19T12:00:00.000+00:00',
    '2026-02-30T12:00:00.000Z',
  ]) {
    assert.equal(
      isRunEvent({ ...event, ts }),
      false,
      `accepted invalid RunEvent timestamp: ${ts}`,
    );
  }
});

void test('context usage payloads distinguish exact, estimated, and unknown measurements', () => {
  const payload = {
    state: 'measured' as const,
    quality: 'exact' as const,
    modelId: 'gpt-5.6-sol',
    inputTokens: 122_400,
    contextWindow: 272_000,
    thresholdTokens: 244_800,
    requestBytes: 510_000,
  };

  assert.equal(isContextUsageUpdatedEventPayload(payload), true);
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 1,
      type: 'context_usage_updated',
      ts: '2026-07-17T00:00:00.000Z',
      payload,
    }),
    true,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      ...payload,
      state: 'compacted',
      compactionEntryId: 'compaction-entry-1',
      historyBytesBefore: 65_522,
      historyBytesAfter: 4_003,
    }),
    true,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      ...payload,
      state: 'compacted',
    }),
    true,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      ...payload,
      state: 'compacted',
      compactionEntryId: 'compaction-entry-1',
      historyBytesBefore: 65_522,
    }),
    false,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      ...payload,
      compactionEntryId: 'compaction-entry-1',
      historyBytesBefore: 65_522,
      historyBytesAfter: 4_003,
    }),
    false,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      ...payload,
      state: 'compacted',
      compactionEntryId: ' ',
      historyBytesBefore: 65_522,
      historyBytesAfter: 4_003,
    }),
    false,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      ...payload,
      state: 'compacted',
      compactionEntryId: 'compaction-entry-1',
      historyBytesBefore: 65_522,
      historyBytesAfter: 65_522,
    }),
    false,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({ ...payload, modelId: ' ' }),
    false,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({ ...payload, inputTokens: 1.5 }),
    false,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      ...payload,
      thresholdTokens: payload.contextWindow + 1,
    }),
    false,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      ...payload,
      quality: 'estimated',
    }),
    true,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      ...payload,
      quality: 'estimated',
      requestBytes: undefined,
    }),
    false,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      state: 'measured',
      quality: 'unknown',
      modelId: payload.modelId,
      requestBytes: payload.requestBytes,
    }),
    true,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      state: 'measured',
      quality: 'unknown',
      modelId: payload.modelId,
      requestBytes: payload.requestBytes,
      contextWindow: payload.contextWindow,
      thresholdTokens: payload.thresholdTokens,
    }),
    true,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      state: 'measured',
      quality: 'unknown',
      modelId: payload.modelId,
      requestBytes: payload.requestBytes,
      inputTokens: 0,
    }),
    false,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      ...payload,
      state: 'compacted',
      quality: 'estimated',
    }),
    false,
  );
  assert.equal(
    isContextUsageUpdatedEventPayload({
      ...payload,
      quality: undefined,
      requestBytes: undefined,
    }),
    true,
  );
});

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type _KnownToolResultRawToolMatchesRawMap = Expect<
  Equal<KnownToolResultRawTool, keyof ToolResultRawMap>
>;
type _KnownToolResultRawKeepsAgentSpawnShape = Expect<
  Equal<KnownToolResultRaw<'agent_spawn'>, ToolResultRawMap['agent_spawn']>
>;
type _KnownToolResultSuccessKeepsAgentSpawnRaw = Expect<
  Equal<
    KnownToolResultSuccessEventPayload<'agent_spawn'>['raw'],
    ToolResultRawMap['agent_spawn']
  >
>;
type _UnknownToolResultSuccessKeepsOpaqueRaw = Expect<
  Equal<UnknownToolResultSuccessEventPayload<'read_file'>['raw'], unknown>
>;
type _GenericToolResultSuccessIsExplicitKnownOrUnknown = Expect<
  Equal<
    ToolResultSuccessEventPayload,
    KnownToolResultSuccessEventPayload | UnknownToolResultSuccessEventPayload
  >
>;
type _ToolResultSuccessForUnownedToolUsesUnknownRaw = Expect<
  Equal<ToolResultSuccessEventPayload<'read_file'>['raw'], UnknownToolResultRaw>
>;
type _AgentWaitBlockedReasonKeepsApprovalPendingVocabulary = Expect<
  Equal<AgentWaitBlockedReason, 'approval_pending'>
>;
type _InterjectAppliedReceivedSeqsStayNumeric = Expect<
  Equal<InterjectAppliedEventPayload['receivedSeqs'], number[]>
>;

void test('child state, wait reason, text delta, and run ack guards stay strict', () => {
  assert.equal(isAgentChildTerminalState('completed'), true);
  assert.equal(isAgentChildTerminalState('failed'), true);
  assert.equal(isAgentChildTerminalState('cancelled'), true);
  assert.equal(isAgentChildTerminalState('blocked'), false);
  assert.deepEqual(AGENT_WAIT_BLOCKED_REASONS, ['approval_pending']);
  assert.equal(AGENT_WAIT_APPROVAL_BLOCKED_REASON, 'approval_pending');
  assert.equal(isAgentWaitBlockedReason('approval_pending'), true);
  assert.equal(isAgentWaitBlockedReason('awaiting_approval'), false);

  assert.equal(isTextDeltaEventPayload({ text: 'hello' }), true);
  assert.equal(isTextDeltaEventPayload({ text: 1 }), false);

  assert.equal(
    isRunAckEventPayload({ runId: RUN_ID, threadId: THREAD_ID }),
    true,
  );
  assert.equal(
    isRunAckEventPayload({ runId: 'bad id', threadId: THREAD_ID }),
    false,
  );
});

void test('tool call sources and basic tool result envelopes reject malformed shapes', () => {
  assert.equal(
    isToolCallEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      args: { path: 'docs/a.md' },
    }),
    true,
  );
  assert.equal(
    isToolCallEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      args: [],
    }),
    false,
  );
  assert.equal(isToolCallSourcePayload({ kind: 'agent_loop' }), true);
  assert.equal(
    isToolCallSourcePayload({
      kind: 'ptc_callback',
      parentCallId: 'call-parent',
      runtimeToolCallId: 'runtime-call-1',
      cellId: 'ptc_cell_runtime_1',
    }),
    true,
  );
  assert.equal(
    isToolCallSourcePayload({
      kind: 'ptc_callback',
      parentCallId: 'call-parent',
      runtimeToolCallId: 'runtime-call-1',
      cellId: 123,
    }),
    false,
  );
  assert.equal(
    isToolCallSourcePayload({
      kind: 'ptc_callback',
      parentCallId: 'call-parent',
    }),
    false,
  );
  assert.equal(
    isToolCallEventPayload({
      callId: 'call-parent::nested-1',
      step: 1,
      tool: 'read_file',
      args: { path: 'docs/a.md' },
      source: {
        kind: 'ptc_callback',
        parentCallId: 'call-parent',
        runtimeToolCallId: 'runtime-call-1',
        cellId: 'ptc_cell_runtime_1',
      },
    }),
    true,
  );
  assert.equal(
    isToolCallEventPayload({
      callId: 'call-parent::nested-1',
      step: 1,
      tool: 'read_file',
      args: { path: 'docs/a.md' },
      source: { kind: 'ptc_callback', parentCallId: 'call-parent' },
    }),
    false,
  );

  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'docs/a.md' },
    }),
    true,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      computerFilesMayHaveChanged: false,
      workspaceFilesMayHaveChanged: false,
      displayText: 'legacy mutation signal must be rejected',
      raw: { path: 'docs/a.md' },
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-parent::nested-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'docs/a.md' },
      source: {
        kind: 'ptc_callback',
        parentCallId: 'call-parent',
        runtimeToolCallId: 'runtime-call-1',
        cellId: 'ptc_cell_runtime_1',
      },
    }),
    true,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-parent::nested-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'docs/a.md' },
      source: { kind: 'ptc_callback', parentCallId: 'call-parent' },
    }),
    false,
  );
});

void test('agent_wait tool result accepts offloaded slim raw the emit path produces', () => {
  // 오프로드된 agent_wait raw — 2026-07-21 저널 오염 사고의 실제 형태.
  // emit이 기록한 이벤트를 저널 재독이 거부하면 run.auth 복구가 영구히
  // 죽으므로, 읽기 계약은 쓰기 경로가 만드는 형태를 그대로 수용해야 한다.
  const offloadedRaw = {
    ok: true,
    offloaded: true,
    tool: 'agent_wait',
    callId: 'call-wait-1',
    outputRef: 'tool-output:thread-1/run-1/call-wait-1',
    summary: 'agent_wait returned 4 completed, 0 pending, and 0 blocked runs.',
    fullOutputBytes: 48067,
    fullOutputChars: 21556,
    recoveryTool: 'read_tool_output',
  };
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-wait-1',
      step: 4,
      tool: 'agent_wait',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'offloaded agent_wait result',
      raw: offloadedRaw,
    }),
    true,
  );
  // 다른 raw-owner 툴 이름이 박힌 슬림 참조는 여전히 거부한다
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-wait-1',
      step: 4,
      tool: 'agent_wait',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'mismatched offloaded tool',
      raw: { ...offloadedRaw, tool: 'exec' },
    }),
    false,
  );
  // 재진입 수단이 빠진 슬림 참조도 거부한다 — 복구 불가능한 참조는 계약 밖
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-wait-1',
      step: 4,
      tool: 'agent_wait',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'missing recovery tool',
      raw: { ...offloadedRaw, recoveryTool: undefined },
    }),
    false,
  );
});

void test('subagent lifecycle payload guards preserve terminal metadata contracts', () => {
  const runtime = {
    phase: 'provider_streaming',
    observedAt: '2026-07-23T09:50:00.000Z',
    lastTool: {
      name: 'read_file',
      callId: 'call-read-1',
      state: 'succeeded',
    },
    partialOutputAvailable: true,
    previousChildRunId: RUN_ID,
  } as const;
  assert.equal(
    isSubagentSpawnedEventPayload({
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      capabilities: ['ptc'],
      toolSurface: 'explorer_ptc',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh',
      selectionSource: 'model_selected',
      runtime,
    }),
    true,
  );
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 4,
      type: 'subagent_status',
      ts: '2026-07-23T09:50:00.000Z',
      payload: {
        parentRunId: RUN_ID,
        childRunId: RUN_ID,
        childThreadId: THREAD_ID,
        subagentType: 'explorer',
        capabilities: [],
        toolSurface: 'explorer',
        runtime,
      },
    }),
    true,
  );
  assert.equal(
    isSubagentSpawnedEventPayload({
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      runtime: {
        ...runtime,
        observedAt: 'not-an-event-timestamp',
      },
    }),
    false,
  );
  assert.equal(
    isSubagentSpawnedEventPayload({
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      runtime: {
        ...runtime,
        lastTool: { ...runtime.lastTool, state: 'unknown' },
      },
    }),
    false,
  );
  assert.equal(
    isSubagentSpawnedEventPayload({
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      capabilities: ['shell'],
      toolSurface: 'explorer_ptc',
    }),
    false,
  );
  assert.equal(
    isSubagentSpawnedEventPayload({
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      capabilities: ['ptc'],
      toolSurface: 'explorer_shell',
    }),
    false,
  );
  assert.equal(
    isSubagentTerminalEventPayload({
      deliveryId: 'delivery-timeout',
      resultDeliveryState: 'pending',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      terminalState: 'cancelled',
      ok: false,
      reason: 'daemon_restart',
      result: 'cancelled',
      resultRef: 'subagent-result:delivery-timeout',
      resultDigest: `sha256:${'a'.repeat(64)}`,
      resultReport: {
        summary: '작업이 재시작으로 취소되었습니다.',
        sourceResultRef: 'subagent-result:delivery-timeout',
        sourceResultDigest: `sha256:${'a'.repeat(64)}`,
      },
      completedAt: '2026-07-26T12:00:00.000Z',
      runtime,
    }),
    true,
  );
  assert.equal(
    isSubagentTerminalEventPayload({
      deliveryId: 'delivery-invalid-state',
      resultDeliveryState: 'still_running',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      terminalState: 'completed',
      ok: true,
      result: 'done',
    }),
    false,
  );
  assert.equal(
    isSubagentTerminalEventPayload({
      deliveryId: 'delivery-mismatched-report',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      terminalState: 'completed',
      ok: true,
      result: 'done',
      resultRef: 'subagent-result:delivery-mismatched-report',
      resultDigest: `sha256:${'a'.repeat(64)}`,
      resultReport: {
        summary: '다른 결과를 가리키는 보고',
        sourceResultRef: 'subagent-result:other-delivery',
        sourceResultDigest: `sha256:${'a'.repeat(64)}`,
      },
    }),
    false,
  );
  assert.equal(
    isSubagentTerminalEventPayload({
      deliveryId: 'delivery-bad-digest',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      terminalState: 'failed',
      ok: false,
      result: 'failed',
      resultDigest: 'sha256:not-a-digest',
    }),
    false,
  );
  assert.equal(
    isSubagentTerminalEventPayload({
      deliveryId: 'delivery-empty-result-ref',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      terminalState: 'failed',
      ok: false,
      result: 'failed',
      resultRef: ' ',
    }),
    false,
  );
  assert.equal(
    isSubagentTerminalEventPayload({
      deliveryId: 'delivery-usage',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      terminalState: 'completed',
      ok: true,
      result: 'done',
      elapsedMs: 1234,
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3 },
    }),
    true,
  );
  assert.equal(
    isSubagentTerminalEventPayload({
      deliveryId: 'delivery-model-meta',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'worker',
      terminalState: 'completed',
      ok: true,
      result: 'done',
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    }),
    true,
  );
  assert.equal(
    isSubagentTerminalEventPayload({
      deliveryId: 'delivery-bad-effort',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      terminalState: 'completed',
      ok: true,
      result: 'done',
      reasoningEffort: 'ultra',
    }),
    false,
  );
  assert.equal(
    isSubagentTerminalEventPayload({
      deliveryId: 'delivery-bad-child-thread',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: 'not-a-thread-id',
      subagentType: 'explorer',
      terminalState: 'completed',
      ok: true,
      result: 'done',
    }),
    false,
  );
  assert.equal(
    isSubagentTerminalEventPayload({
      deliveryId: 'delivery-bad-usage',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'explorer',
      terminalState: 'completed',
      ok: true,
      result: 'done',
      usage: { inputTokens: 10 },
    }),
    false,
  );
  assert.equal(
    isSubagentApprovalRequiredEventPayload({
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      approval: {
        callId: 'call-1',
        runId: RUN_ID,
        threadId: THREAD_ID,
        toolName: 'write_file',
        approvalClass: 'write_file',
        permissionMode: 'basic',
        argumentsPreview: { path: 'docs/a.md' },
        sideEffectLevel: 'write',
      },
    }),
    true,
  );
});

void test('interject and tool result envelope guards preserve correlation invariants', () => {
  assert.equal(
    isInterjectAppliedEventPayload({
      runId: RUN_ID,
      count: 2,
      receivedSeqs: [1, 2],
    }),
    true,
  );
  assert.equal(
    isInterjectAppliedEventPayload({
      runId: RUN_ID,
      count: 2,
      receivedSeqs: [1],
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'exec_command',
      ok: false,
      computerFilesMayHaveChanged: false,
      displayText: 'blocked by plan approval',
      raw: null,
      errorCode: 'approval_required',
      error: 'PLAN_APPROVAL_REQUIRED',
      diagnostics: {
        phase: 'admission',
        reasonCode: 'plan_approval_required',
        gate: {
          kind: 'plan_approval',
          effectivePermissionMode: 'full_access',
        },
      },
    }),
    true,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'exec_command',
      ok: false,
      computerFilesMayHaveChanged: false,
      displayText: 'failed',
      raw: null,
      errorCode: 'execution_failed',
      error: 'failed',
      diagnostics: {
        phase: 'unknown_phase',
        reasonCode: 'opaque_failure',
      },
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: false,
      computerFilesMayHaveChanged: false,
      displayText: 'failed',
      raw: null,
      errorCode: 'totally_new_error',
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'ok',
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: false,
      computerFilesMayHaveChanged: false,
      displayText: 'failed',
      raw: null,
      errorCode: 'invalid_args',
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-1',
      step: 1,
      tool: 'agent_spawn',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'child started',
      raw: {
        ok: true,
        childRunId: 'child-1',
        childThreadId: THREAD_ID,
        subagentType: 'explorer',
        launchState: 'started',
      },
      error: 'should not be present',
    }),
    false,
  );
});

void test('subagent tool result guards accept owned success and rejection shapes', () => {
  const queuedSpawnRaw = {
    ok: true,
    childRunId: 'child-queued',
    childThreadId: THREAD_ID,
    subagentType: 'worker',
    launchState: 'queued',
    deferReason: 'configured_capacity',
  } satisfies ToolResultRawMap['agent_spawn'];
  assert.equal(isAgentLaunchToolRaw(queuedSpawnRaw), true);
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-2',
      step: 1,
      tool: 'agent_wait',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'child wait complete',
      raw: {
        ok: true,
        completed: [
          {
            childRunId: 'child-1',
            terminalState: 'completed',
            ok: true,
            result: 'done',
            resultRef: 'subagent-result:delivery-1',
            resultDigest:
              'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            resultReport: {
              summary: 'compact handoff',
              sourceResultRef: 'subagent-result:delivery-1',
              sourceResultDigest:
                'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            },
          },
        ],
        pending: [],
        blocked: [],
        launches: [
          {
            childRunId: 'child-1',
            childThreadId: THREAD_ID,
            launchState: 'started',
            priorityClass: 'high',
            enqueueOrder: 1,
            createdAt: '2026-07-23T00:00:00.000Z',
            updatedAt: '2026-07-23T00:00:01.000Z',
            deferReason: 'configured_capacity',
          },
        ],
      },
    }),
    true,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [
        {
          childRunId: 'child-1',
          terminalState: 'completed',
          ok: true,
          result: 'done',
          resultReport: {
            summary: 'compact handoff',
            sourceResultRef: 'subagent-result:delivery-1',
            sourceResultDigest: 'not-a-digest',
          },
        },
      ],
      pending: [],
      blocked: [],
    }),
    false,
  );
  const rejectedSpawnRaw = {
    ok: false,
    launchState: 'rejected',
    subagentType: 'worker',
    errorCode: 'invalid_args',
    error: 'invalid child launch request',
  } satisfies ToolResultRawMap['agent_spawn'];
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-3',
      step: 1,
      tool: 'agent_spawn',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'child launch rejected',
      raw: rejectedSpawnRaw,
    }),
    true,
  );
  const cappedSendInputRaw = {
    ok: false,
    launchState: 'rejected',
    subagentType: 'explorer',
    errorCode: 'too_many_child_runs',
    error: 'maximum 8 concurrent child agents allowed',
    effectiveMax: 8,
  } satisfies ToolResultRawMap['agent_send_input'];
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-4',
      step: 1,
      tool: 'agent_send_input',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'child continuation rejected',
      raw: cappedSendInputRaw,
    }),
    true,
  );
  const stopRaw = {
    ok: true,
    childRunId: 'child-1',
    stopState: 'already_terminal',
  } satisfies ToolResultRawMap['agent_stop'];
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-5',
      step: 1,
      tool: 'agent_stop',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'child already terminal',
      raw: stopRaw,
    }),
    true,
  );
  const cancelledBeforeStartRaw = {
    ok: true,
    childRunId: 'child-2',
    stopState: 'cancelled_before_start',
  } satisfies ToolResultRawMap['agent_stop'];
  assert.equal(isAgentStopToolRaw(cancelledBeforeStartRaw), true);

  const priorityRaw = {
    ok: true,
    childRunId: 'child-2',
    launchState: 'queued',
    priorityClass: 'high',
    updateState: 'updated',
  } satisfies ToolResultRawMap['agent_set_priority'];
  assert.equal(isAgentSetPriorityToolRaw(priorityRaw), true);
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-6',
      step: 1,
      tool: 'agent_set_priority',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'queued child priority updated',
      raw: priorityRaw,
    }),
    true,
  );
});

void test('subagent tool result guards reject malformed owned shapes and preserve unknown raw', () => {
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-6',
      step: 1,
      tool: 'agent_spawn',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'malformed child launch',
      raw: {
        ok: false,
        launchState: 'rejected',
        subagentType: 'worker',
        errorCode: 'unsupported_mode',
        error: 'legacy mode is not a launch rejection code',
      },
    }),
    false,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [],
      pending: [],
      blocked: [],
      launches: [
        {
          childRunId: 'child-1',
          childThreadId: THREAD_ID,
          launchState: 'waiting',
          priorityClass: 'high',
          enqueueOrder: 0,
          createdAt: 'not-a-timestamp',
          updatedAt: '2026-07-23T00:00:00.000Z',
        },
      ],
    }),
    false,
  );
  assert.equal(
    isAgentSetPriorityToolRaw({
      ok: true,
      childRunId: 'child-1',
      launchState: 'queued',
      priorityClass: 'urgent',
      updateState: 'updated',
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-7',
      step: 1,
      tool: 'agent_wait',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'malformed child wait',
      raw: {
        ok: true,
        completed: [
          {
            childRunId: 'child-1',
            terminalState: 'blocked',
            ok: false,
            result: 'not terminal',
          },
        ],
        pending: [],
        blocked: [],
      },
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-8',
      step: 1,
      tool: 'agent_stop',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'malformed child stop',
      raw: {
        ok: true,
        childRunId: 'child-1',
        stopState: 'stopped',
      },
    }),
    false,
  );
  assert.equal(
    isToolResultEventPayload({
      callId: 'call-9',
      step: 1,
      tool: 'custom_tool',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'unknown raw stays opaque',
      raw: {
        any: 'shape',
      },
    }),
    true,
  );
});

void test('done and thread persistence payload guards reject malformed diagnostics', () => {
  assert.equal(isDoneEventPayload({ answer: 'done', ok: true }), true);
  assert.equal(isDoneEventPayload({ answer: 'done', ok: 'yes' }), false);

  assert.equal(
    isThreadStatePersistedEventPayload({
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-10T00:00:00.000Z',
      messages: [],
      artifacts: [],
    }),
    true,
  );
  assert.equal(
    isThreadStatePersistFailedEventPayload({
      message: 'sync failed',
      diagnostics: [
        {
          phase: 'persist assistant transcript',
          message: 'disk full',
        },
      ],
    }),
    true,
  );
  assert.equal(
    isThreadStatePersistFailedEventPayload({
      message: 'sync failed',
      diagnostics: [
        {
          phase: 'persist assistant transcript',
          message: 1,
        },
      ],
    }),
    false,
  );
  assert.equal(
    isThreadStatePersistFailedEventPayload({
      message: 'sync failed',
      diagnostics: {},
    }),
    false,
  );
  assert.equal(
    isThreadStatePersistFailedEventPayload({
      message: 1,
    }),
    false,
  );
});

void test('error payload guards enforce error-code-specific fields', () => {
  assert.equal(
    isErrorEventPayload({ code: 'internal', message: 'boom' }),
    true,
  );
  assert.equal(
    isErrorEventPayload({ code: 'not_found', message: 'missing' }),
    true,
  );
  assert.equal(
    isErrorEventPayload({
      code: 'not_found',
      message: 'missing',
      path: 'draft/ch1.md',
    }),
    true,
  );
  assert.equal(
    isErrorEventPayload({
      code: 'not_found',
      message: 'missing',
      path: 123,
    }),
    false,
  );
  assert.equal(
    isErrorEventPayload({
      code: 'conflict_stale_write',
      message: 'stale write',
      path: 'draft/ch1.md',
      currentVersionToken: 'v2',
    }),
    true,
  );
  assert.equal(
    isErrorEventPayload({
      code: 'conflict_active_run',
      message: 'thread has an active run',
      threadId: THREAD_ID,
      activeRunId: RUN_ID,
    }),
    true,
  );
  assert.equal(
    isErrorEventPayload({
      code: 'conflict_stale_write',
      message: 'stale write',
    }),
    false,
  );
  assert.equal(
    isErrorEventPayload({
      code: 'conflict_active_run',
      message: 'thread has an active run',
    }),
    false,
  );
  assert.equal(
    isErrorEventPayload({ code: 'totally_new_error', message: 'boom' }),
    false,
  );
  assert.equal(isErrorEventPayload({ code: 500, message: 'boom' }), false);
});

void test('artifact committed payload guard accepts the canonical source shape', () => {
  assert.equal(
    isArtifactCommittedEventPayload({
      artifactId: 'art_1',
      version: 1,
      parentVersion: null,
      baseVersion: null,
      renderer: 'markdown',
      payload: '# title',
      digest: 'digest',
      contentHash: 'hash',
      createdAt: '2026-04-10T00:00:00.000Z',
      createdByRunId: RUN_ID,
      previewValidation: { ok: true },
      title: null,
      persistenceEpoch: 0,
      sourceRef: {
        kind: 'thread-file',
        workingDirectory: 'workspace',
        threadId: THREAD_ID,
        runId: RUN_ID,
        filePath: 'episodes/ch01.md',
        messageTimestamp: '2026-04-10T00:00:00.000Z',
      },
    }),
    true,
  );
});

void test('RunEventPayloadMap remains aligned with shared semantic payloads', () => {
  const shared: SharedRunEventPayloadMap = {
    run_ack: { runId: RUN_ID, threadId: THREAD_ID },
    provider_status: {
      phase: 'rate_limit_waiting',
      observedAt: '2026-07-23T11:00:00.000Z',
    },
    commentary_delta: { text: 'commentary' },
    tool_call: {
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      args: { path: 'docs/a.md' },
    },
    tool_call_delta: {
      callId: 'call-1',
      step: 1,
      tool: 'visualize',
      argsDelta: '{"code":"<div',
    },
    tool_result: {
      callId: 'call-1',
      step: 1,
      tool: 'read_file',
      ok: true,
      computerFilesMayHaveChanged: false,
      displayText: 'ok',
      raw: { path: 'docs/a.md' },
    },
    subagent_spawned: {
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      capabilities: ['ptc'],
      toolSurface: 'explorer_ptc',
    },
    subagent_status: {
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      capabilities: ['ptc'],
      toolSurface: 'explorer_ptc',
      runtime: {
        phase: 'provider_waiting',
        observedAt: '2026-07-23T09:50:00.000Z',
        partialOutputAvailable: false,
      },
    },
    subagent_terminal: {
      deliveryId: 'delivery-terminal',
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      capabilities: [],
      toolSurface: 'worker',
      terminalState: 'failed',
      ok: false,
      reason: 'child_error',
      result: 'failed',
    },
    subagent_approval_required: {
      parentRunId: RUN_ID,
      childRunId: RUN_ID,
      subagentType: 'worker',
      capabilities: [],
      toolSurface: 'worker',
      approval: {
        callId: 'call-1',
        runId: RUN_ID,
        threadId: THREAD_ID,
        toolName: 'write_file',
        approvalClass: 'write_file',
        permissionMode: 'basic',
        argumentsPreview: { path: 'docs/a.md' },
        sideEffectLevel: 'write',
      },
    },
    interject_applied: {
      runId: RUN_ID,
      count: 2,
      receivedSeqs: [1, 2],
    },
    approval_required: {
      callId: 'call-1',
      runId: RUN_ID,
      threadId: THREAD_ID,
      toolName: 'write_file',
      approvalClass: 'write_file',
      permissionMode: 'basic',
      argumentsPreview: { path: 'docs/a.md' },
      sideEffectLevel: 'write',
    },
    usage_updated: {
      inputTokens: 100,
      outputTokens: 25,
      cachedInputTokens: 40,
    },
    context_usage_updated: {
      state: 'measured',
      modelId: 'gpt-5.6-sol',
      inputTokens: 122_400,
      contextWindow: 272_000,
      thresholdTokens: 244_800,
    },
    planning_workflow_updated: {
      state: 'collecting',
      workflowId: 'workflow-event',
      threadId: THREAD_ID,
      intensity: 'visual',
      depth: 'standard',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    },
    goal_updated: {
      goalId: 'goal-event',
      threadId: THREAD_ID,
      objective: 'Ship Goal mode',
      state: 'working',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    },
    final_answer_delta: { text: 'final' },
    artifact_stream_delta: { text: 'artifact' },
    artifact_committed: {
      artifactId: 'art_1',
      version: 1,
      parentVersion: null,
      baseVersion: null,
      renderer: 'markdown',
      payload: '# title',
      digest: 'digest',
      contentHash: 'hash',
      createdAt: '2026-04-10T00:00:00.000Z',
      createdByRunId: RUN_ID,
      previewValidation: { ok: true },
      title: null,
      persistenceEpoch: 0,
      sourceRef: {
        kind: 'thread-file',
        workingDirectory: 'workspace',
        threadId: THREAD_ID,
        runId: RUN_ID,
        filePath: 'episodes/ch01.md',
        messageTimestamp: '2026-04-10T00:00:00.000Z',
      },
    },
    thread_state_persisted: {
      threadId: THREAD_ID,
      snapshotVersion: '2026-04-10T00:00:00.000Z',
      messages: [],
      artifacts: [],
    },
    thread_state_persist_failed: {
      message: 'sync failed',
    },
    done: { answer: 'done', ok: true },
    error: { code: 'internal', message: 'boom' },
  };
  const payloads: RunEventPayloadMap = shared;

  const artifactCommitted: ArtifactCommittedEventPayload =
    shared.artifact_committed;
  assert.equal(payloads.subagent_spawned.childThreadId, THREAD_ID);
  assert.deepEqual(payloads.subagent_spawned.capabilities, ['ptc']);
  assert.equal(payloads.subagent_spawned.toolSurface, 'explorer_ptc');
  assert.equal(payloads.subagent_terminal.terminalState, 'failed');
  assert.equal(payloads.interject_applied.count, 2);
  assert.equal(artifactCommitted.artifactId, 'art_1');
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 2,
      type: 'subagent_terminal',
      ts: new Date().toISOString(),
      payload: payloads.subagent_terminal,
    }),
    true,
  );
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 4,
      type: 'interject_applied',
      ts: new Date().toISOString(),
      payload: payloads.interject_applied,
    }),
    true,
  );
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 5,
      type: 'artifact_committed',
      ts: new Date().toISOString(),
      payload: artifactCommitted,
    }),
    true,
  );
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 6,
      type: 'thread_state_persisted',
      ts: new Date().toISOString(),
      payload: payloads.thread_state_persisted,
    }),
    true,
  );
  assert.equal(
    isRunEvent({
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 7,
      type: 'thread_state_persist_failed',
      ts: new Date().toISOString(),
      payload: payloads.thread_state_persist_failed,
    }),
    true,
  );
});

void test('subagent tool raw guards accept owned shapes and reject malformed raw payloads', () => {
  assert.equal(
    isAgentLaunchToolRaw({
      ok: true,
      childRunId: 'child-queued',
      childThreadId: THREAD_ID,
      subagentType: 'worker',
      launchState: 'queued',
      deferReason: 'batch_group_wait',
    }),
    true,
  );
  assert.equal(
    isAgentLaunchToolRaw({
      ok: true,
      childRunId: 'child-queued',
      childThreadId: THREAD_ID,
      subagentType: 'worker',
      launchState: 'queued',
      deferReason: 'busy_for_now',
    }),
    false,
  );
  assert.equal(
    isAgentLaunchToolRaw({
      ok: true,
      childRunId: 'child-1',
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      launchState: 'started',
      modelId: 'grok-4.5',
      reasoningEffort: 'high',
      selectionSource: 'model_selected',
    }),
    true,
  );
  assert.equal(
    isAgentLaunchToolRaw({
      ok: true,
      childRunId: 'child-1',
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      launchState: 'started',
      modelId: 'grok-4.5',
      reasoningEffort: 'xhigh',
      selectionSource: 'silent_fallback',
    }),
    false,
  );
  assert.equal(
    isToolResultRaw('agent_spawn', {
      ok: false,
      launchState: 'rejected',
      subagentType: 'worker',
      errorCode: 'too_many_child_runs',
      error: 'maximum 8 concurrent child agents allowed',
      effectiveMax: 8,
    }),
    true,
  );
  assert.equal(
    isAgentLaunchToolRaw({
      ok: false,
      launchState: 'rejected',
      subagentType: 'worker',
      errorCode: 'too_many_child_runs',
      error: 'missing effective max',
    }),
    false,
  );
  assert.equal(
    isAgentLaunchToolRaw({
      ok: false,
      launchState: 'rejected',
      subagentType: 'writer',
      errorCode: 'invalid_args',
      error: 'bad role',
    }),
    false,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [
        {
          childRunId: 'child-1',
          terminalState: 'cancelled',
          ok: false,
          reason: 'explicit_stop',
          result: 'stopped',
        },
      ],
      pending: ['child-2'],
      blocked: [
        {
          childRunId: 'child-3',
          blockedReason: 'approval_pending',
        },
      ],
    }),
    true,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [
        {
          deliveryId: 'delivery-ref-only',
          childRunId: 'child-ref-only',
          terminalState: 'failed',
          ok: false,
          reason: 'provider_error',
          resultRef: 'subagent-result:delivery-ref-only',
          resultDigest: `sha256:${'a'.repeat(64)}`,
          parentRunId: RUN_ID,
          childThreadId: THREAD_ID,
          subagentType: 'worker',
          capabilities: [],
          toolSurface: 'worker',
          completedAt: '2026-07-26T11:00:00.000Z',
          elapsedMs: 1_250,
          usage: {
            inputTokens: 100,
            outputTokens: 25,
            cachedInputTokens: 10,
          },
          modelId: 'gpt-5.6-sol',
          reasoningEffort: 'high',
        },
      ],
      pending: [],
      blocked: [],
    }),
    true,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [
        {
          deliveryId: ' ',
          childRunId: 'child-bad-delivery',
          terminalState: 'failed',
          ok: false,
          result: 'failed',
        },
      ],
      pending: [],
      blocked: [],
    }),
    false,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [
        {
          childRunId: 'child-ref-bad-digest',
          terminalState: 'failed',
          ok: false,
          resultRef: 'subagent-result:delivery-bad-digest',
          resultDigest: 'sha256:not-a-digest',
        },
      ],
      pending: [],
      blocked: [],
    }),
    false,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [
        {
          childRunId: 'child-without-result',
          terminalState: 'failed',
          ok: false,
        },
      ],
      pending: [],
      blocked: [],
    }),
    false,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [],
      pending: [1],
      blocked: [],
    }),
    false,
  );
  assert.equal(
    isAgentWaitToolRaw({
      ok: true,
      completed: [],
      pending: [],
      blocked: [
        {
          childRunId: 'child-1',
          blockedReason: 'waiting',
        },
      ],
    }),
    false,
  );
  assert.equal(
    isAgentStopToolRaw({
      ok: true,
      childRunId: 'child-1',
      stopState: 'stopping',
    }),
    true,
  );
  assert.equal(
    isAgentStopToolRaw({
      ok: true,
      childRunId: 'child-1',
      stopState: 'cancelled',
    }),
    false,
  );
});

void test('every declared run-event payload field is actually validated', () => {
  assertEveryFieldIsValidated(
    'TextDeltaEventPayload',
    isTextDeltaEventPayload,
    { text: 'delta' },
    { text: 42 },
  );

  assertEveryFieldIsValidated(
    'ToolCallEventPayload',
    isToolCallEventPayload,
    { callId: 'call-1', step: 1, tool: 'read_file', args: { path: 'a.md' } },
    { callId: 42, step: '1', tool: 42, args: 'not-a-record', source: 'x' },
  );

  assertEveryFieldIsValidated(
    'ToolCallDeltaEventPayload',
    isToolCallDeltaEventPayload,
    { callId: 'call-1', step: 1, tool: 'visualize', argsDelta: '{"code":"<' },
    { callId: 42, step: '1', tool: 42, argsDelta: 42 },
  );

  assertEveryFieldIsValidated(
    'ToolOutputDeltaEventPayload',
    isToolOutputDeltaEventPayload,
    { callId: 'call-1', tool: 'exec', stream: 'stdout', text: 'out' },
    { callId: 42, tool: 42, stream: 'stdin', text: 42 },
  );

  assertEveryFieldIsValidated(
    'ProviderRuntimeStatusEventPayload',
    isProviderRuntimeStatusEventPayload,
    { phase: 'rate_limit_waiting', observedAt: '2026-07-23T11:00:00.000Z' },
    { phase: 'invented_phase', observedAt: 'not-a-timestamp', request: 'x' },
  );

  assertEveryFieldIsValidated(
    'ProviderRetryDiagnostics',
    isProviderRetryDiagnostics,
    { available: true, performed: true, outcome: 'scheduled' },
    { available: 'yes', performed: 'no', outcome: 'invented_outcome' },
  );

  // endedAt과 durationMs는 "함께 있거나 함께 없다"는 교차 규칙이 있어, 필드
  // 단위 오염을 격리하려면 선택 필드까지 모두 채운 정상값에서 출발해야 한다.
  assertEveryFieldIsValidated(
    'ProviderRequestDiagnostics',
    isProviderRequestDiagnostics,
    {
      startedAt: '2026-07-23T11:00:00.000Z',
      lastEventAt: '2026-07-23T11:00:01.000Z',
      endedAt: '2026-07-23T11:00:02.000Z',
      durationMs: 2000,
      attemptCount: 2,
      retry: { available: true, performed: true, outcome: 'scheduled' },
    },
    {
      startedAt: 'not-a-timestamp',
      lastEventAt: 'not-a-timestamp',
      endedAt: 'not-a-timestamp',
      durationMs: 'x',
      attemptCount: 0,
      retry: 'x',
    },
  );

  assertEveryFieldIsValidated(
    'SubagentRuntimeDiagnostics',
    isSubagentRuntimeDiagnostics,
    {
      phase: 'provider_waiting',
      observedAt: '2026-07-23T09:50:00.000Z',
      partialOutputAvailable: false,
    },
    {
      phase: 'invented_phase',
      observedAt: 'not-a-timestamp',
      partialOutputAvailable: 'no',
      lastTool: 'x',
      previousChildRunId: 42,
      providerRequest: 'x',
    },
  );

  assertEveryFieldIsValidated(
    'RunUsageTotals',
    isRunUsageTotals,
    { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3 },
    { inputTokens: 'x', outputTokens: 'x', cachedInputTokens: 'x' },
  );

  assertEveryFieldIsValidated(
    'InterjectAppliedEventPayload',
    isInterjectAppliedEventPayload,
    { runId: RUN_ID, count: 2, receivedSeqs: [1, 2] },
    { runId: 42, count: 'x', receivedSeqs: 'x' },
  );

  assertEveryFieldIsValidated(
    'DoneEventPayload',
    isDoneEventPayload,
    { answer: 'done', ok: true },
    { answer: 42, ok: 'yes' },
  );

  assertEveryFieldIsValidated(
    'ThreadStatePersistFailedEventPayload',
    isThreadStatePersistFailedEventPayload,
    { message: 'sync failed' },
    { message: 42, diagnostics: 'x' },
  );

  assertEveryFieldIsValidated(
    'OffloadedToolResultRaw',
    isOffloadedToolResultRaw,
    {
      ok: true,
      offloaded: true,
      tool: 'agent_wait',
      callId: 'call-wait-1',
      outputRef: 'tool-output:thread-1/run-1/call-wait-1',
      summary: 'agent_wait returned 4 completed runs.',
      fullOutputBytes: 48_067,
      fullOutputChars: 21_556,
      recoveryTool: 'read_tool_output',
    },
    {
      ok: false,
      offloaded: false,
      tool: 42,
      callId: 42,
      outputRef: 42,
      summary: 42,
      fullOutputBytes: 'x',
      fullOutputChars: 'x',
      recoveryTool: 'exec',
    },
  );

  assertEveryFieldIsValidated(
    'AgentWaitToolRaw',
    isAgentWaitToolRaw,
    { ok: true, completed: [], pending: [], blocked: [] },
    { ok: false, completed: 'x', pending: 'x', blocked: 'x', launches: 'x' },
  );

  assertEveryFieldIsValidated(
    'AgentSetPriorityToolRaw',
    isAgentSetPriorityToolRaw,
    {
      ok: true,
      childRunId: 'child-1',
      launchState: 'queued',
      priorityClass: 'normal',
      updateState: 'updated',
    },
    {
      ok: false,
      childRunId: 42,
      launchState: 'invented_state',
      priorityClass: 'urgent',
      updateState: 'invented_update',
    },
  );

  assertEveryFieldIsValidated(
    'AgentRetryToolRaw',
    isAgentRetryToolRaw,
    {
      ok: true,
      previousChildRunId: 'previous-child',
      childRunId: 'fresh-child',
      childThreadId: 'fresh-thread',
      retryDisposition: 'created',
      launchState: 'queued',
      deferReason: 'configured_capacity',
      failureReason: null,
      modelId: 'gpt-5.6',
      reasoningEffort: 'medium',
      selectionSource: 'inherited',
    },
    {
      ok: false,
      previousChildRunId: 42,
      childRunId: 42,
      childThreadId: 42,
      retryDisposition: 'invented_disposition',
      launchState: 'invented_state',
      deferReason: 'invented_reason',
      failureReason: 42,
      modelId: 42,
      reasoningEffort: 'invented_effort',
      selectionSource: 'invented_source',
    },
  );
});
