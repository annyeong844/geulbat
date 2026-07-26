import test from 'node:test';
import assert from 'node:assert/strict';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import {
  createSubagentActivityEffect,
  createSubagentTerminalHistoryEntry,
} from './run-session-subagent-effect.js';

const RUN_ID = brandRunId('run-1');
const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');
const CHILD_RUN_ID = brandRunId('run-child-1');
const PREVIOUS_CHILD_RUN_ID = brandRunId('run-child-0');

void test('createSubagentActivityEffect maps spawned events to spawned transcript entries', () => {
  const effect = createSubagentActivityEffect({
    runId: RUN_ID,
    threadId: THREAD_ID,
    seq: 1,
    ts: '2026-04-18T00:00:00.000Z',
    type: 'subagent_spawned',
    payload: {
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      capabilities: ['ptc'],
      toolSurface: 'explorer_ptc',
    },
  });

  assert.deepEqual(effect, {
    kind: 'subagent_activity_added',
    threadId: THREAD_ID,
    entry: {
      kind: 'subagent_activity',
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      capabilities: ['ptc'],
      toolSurface: 'explorer_ptc',
      state: 'spawned',
    },
  });
});

void test('createSubagentActivityEffect maps approval_required events to approval_required transcript entries', () => {
  const effect = createSubagentActivityEffect({
    runId: RUN_ID,
    threadId: THREAD_ID,
    seq: 2,
    ts: '2026-04-18T00:00:01.000Z',
    type: 'subagent_approval_required',
    payload: {
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      subagentType: 'explorer',
      approval: makeApprovalRequiredFixture({
        runId: RUN_ID,
        threadId: THREAD_ID,
      }),
    },
  });

  assert.deepEqual(effect, {
    kind: 'subagent_activity_added',
    threadId: THREAD_ID,
    entry: {
      kind: 'subagent_activity',
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      subagentType: 'explorer',
      state: 'approval_required',
    },
  });
});

void test('createSubagentActivityEffect maps semantic runtime status without waiting for terminal output', () => {
  const effect = createSubagentActivityEffect({
    runId: RUN_ID,
    threadId: THREAD_ID,
    seq: 2,
    ts: '2026-04-18T00:00:01.000Z',
    type: 'subagent_status',
    payload: {
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'worker',
      capabilities: ['ptc'],
      toolSurface: 'worker',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      runtime: {
        phase: 'tool_running',
        observedAt: '2026-04-18T00:00:00.900Z',
        lastTool: {
          name: 'read_file',
          callId: 'call-read-1',
          state: 'running',
        },
        partialOutputAvailable: true,
        previousChildRunId: PREVIOUS_CHILD_RUN_ID,
      },
    },
  });

  assert.deepEqual(effect, {
    kind: 'subagent_activity_added',
    threadId: THREAD_ID,
    entry: {
      kind: 'subagent_activity',
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'worker',
      capabilities: ['ptc'],
      toolSurface: 'worker',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
      runtime: {
        phase: 'tool_running',
        observedAt: '2026-04-18T00:00:00.900Z',
        lastTool: {
          name: 'read_file',
          callId: 'call-read-1',
          state: 'running',
        },
        partialOutputAvailable: true,
        previousChildRunId: PREVIOUS_CHILD_RUN_ID,
      },
      state: 'spawned',
    },
  });
});

void test('createSubagentActivityEffect preserves terminal deliveryId, reason, result, and result ref', () => {
  const effect = createSubagentActivityEffect({
    runId: RUN_ID,
    threadId: THREAD_ID,
    seq: 3,
    ts: '2026-04-18T00:00:02.000Z',
    type: 'subagent_terminal',
    payload: {
      deliveryId: 'delivery-1',
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      subagentType: 'worker',
      terminalState: 'failed',
      ok: false,
      reason: 'timeout',
      result: 'timed out',
      resultRef: 'subagent-result:delivery-1',
    },
  });

  assert.deepEqual(effect, {
    kind: 'subagent_activity_added',
    threadId: THREAD_ID,
    entry: {
      kind: 'subagent_activity',
      deliveryId: 'delivery-1',
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      subagentType: 'worker',
      state: 'failed',
      reason: 'timeout',
      result: 'timed out',
      resultRef: 'subagent-result:delivery-1',
    },
  });
});

void test('createSubagentActivityEffect preserves terminal elapsedMs and usage telemetry', () => {
  const effect = createSubagentActivityEffect({
    runId: RUN_ID,
    threadId: THREAD_ID,
    seq: 4,
    ts: '2026-04-18T00:00:03.000Z',
    type: 'subagent_terminal',
    payload: {
      deliveryId: 'delivery-2',
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      capabilities: ['ptc'],
      toolSurface: 'explorer_ptc',
      terminalState: 'completed',
      ok: true,
      result: 'done',
      elapsedMs: 475_000,
      usage: {
        inputTokens: 15_900,
        outputTokens: 1_200,
        cachedInputTokens: 9_000,
      },
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    },
  });

  assert.deepEqual(effect, {
    kind: 'subagent_activity_added',
    threadId: THREAD_ID,
    entry: {
      kind: 'subagent_activity',
      deliveryId: 'delivery-2',
      parentRunId: RUN_ID,
      childRunId: CHILD_RUN_ID,
      childThreadId: THREAD_ID,
      subagentType: 'explorer',
      capabilities: ['ptc'],
      toolSurface: 'explorer_ptc',
      state: 'completed',
      result: 'done',
      elapsedMs: 475_000,
      usage: {
        inputTokens: 15_900,
        outputTokens: 1_200,
        cachedInputTokens: 9_000,
      },
      modelId: 'gpt-5.6-luna',
      reasoningEffort: 'high',
    },
  });
});

void test('createSubagentTerminalHistoryEntry restores persisted reason, runtime, partial result, and retry lineage', () => {
  const entry = createSubagentTerminalHistoryEntry({
    deliveryId: 'delivery-history',
    resultRef: 'subagent-result:delivery-history',
    parentRunId: RUN_ID,
    childRunId: CHILD_RUN_ID,
    childThreadId: THREAD_ID,
    subagentType: 'worker',
    capabilities: [],
    toolSurface: 'worker',
    runtime: {
      phase: 'tool_running',
      observedAt: '2026-04-18T00:00:02.000Z',
      lastTool: {
        name: 'apply_patch',
        callId: 'call-patch',
        state: 'failed',
      },
      partialOutputAvailable: true,
      previousChildRunId: PREVIOUS_CHILD_RUN_ID,
    },
    terminalState: 'failed',
    reason: 'daemon_restart',
    result: '재시작 전에 남긴 부분 결과',
    completedAt: '2026-04-18T00:00:03.000Z',
  });

  assert.deepEqual(entry, {
    kind: 'subagent_activity',
    deliveryId: 'delivery-history',
    parentRunId: RUN_ID,
    childRunId: CHILD_RUN_ID,
    childThreadId: THREAD_ID,
    subagentType: 'worker',
    capabilities: [],
    toolSurface: 'worker',
    runtime: {
      phase: 'tool_running',
      observedAt: '2026-04-18T00:00:02.000Z',
      lastTool: {
        name: 'apply_patch',
        callId: 'call-patch',
        state: 'failed',
      },
      partialOutputAvailable: true,
      previousChildRunId: PREVIOUS_CHILD_RUN_ID,
    },
    state: 'failed',
    reason: 'daemon_restart',
    result: '재시작 전에 남긴 부분 결과',
    resultRef: 'subagent-result:delivery-history',
  });
});
