import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AgentWaitBlockedReason,
  InterjectAppliedEventPayload,
  KnownToolResultRaw,
  KnownToolResultRawTool,
  KnownToolResultSuccessEventPayload,
  ToolResultRawMap,
  ToolResultSuccessEventPayload,
  UnknownToolResultRaw,
  UnknownToolResultSuccessEventPayload,
} from './run-events.js';
import {
  AGENT_WAIT_APPROVAL_BLOCKED_REASON,
  AGENT_WAIT_BLOCKED_REASONS,
  isAgentRetryToolRaw,
  isAgentWaitBlockedReason,
  isContextUsageUpdatedEventPayload,
  isRunAckEventPayload,
  isRunEvent,
  isSubagentApprovalRequiredEventPayload,
  isSubagentLaunchRequestState,
  isSubagentSpawnedEventPayload,
  isSubagentTerminalEventPayload,
  isTextDeltaEventPayload,
} from './run-events.js';
import {
  TEST_RUN_EVENT_RUN_ID as RUN_ID,
  TEST_RUN_EVENT_THREAD_ID as THREAD_ID,
} from './test-support/run-events.js';

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

void test('wait reason, text delta, and run ack guards stay strict', () => {
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
