import test from 'node:test';
import assert from 'node:assert/strict';

import { adaptRunSessionMessage } from './run-session-message-effects.js';
import {
  CHILD_RUN_ID,
  RUN_ID,
  THREAD_ID,
} from '../test-support/run-session-fixtures.js';

void test('adaptRunSessionMessage keeps transport failure structured before shell formatting', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.error',
      code: 'internal',
      message: 'socket broke',
      status: 500,
    }),
    {
      kind: 'run_transport_error',
      code: 'internal',
      message: 'socket broke',
    },
  );
});

void test('adaptRunSessionMessage maps cursor-free tool output into a live stream effect', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.tool.output.delta',
      runId: RUN_ID,
      threadId: THREAD_ID,
      payload: {
        callId: 'call-exec',
        tool: 'exec_command',
        stream: 'stdout',
        text: 'working',
      },
    }),
    {
      kind: 'tool_output_streamed',
      threadId: THREAD_ID,
      callId: 'call-exec',
      tool: 'exec_command',
      stream: 'stdout',
      text: 'working',
    },
  );
});

void test('adaptRunSessionMessage preserves a failed done event as terminal run evidence', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: new Date().toISOString(),
        type: 'done',
        payload: {
          answer: 'partial answer',
          ok: false,
        },
      },
    }),
    {
      kind: 'run_terminal',
      runId: RUN_ID,
      threadId: THREAD_ID,
      ok: false,
    },
  );
});

void test('adaptRunSessionMessage maps usage_updated events to usage effects', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 3,
        ts: new Date().toISOString(),
        type: 'usage_updated',
        payload: {
          inputTokens: 9800,
          outputTokens: 252,
          cachedInputTokens: 4000,
        },
      },
    }),
    {
      kind: 'usage_updated',
      runId: RUN_ID,
      threadId: THREAD_ID,
      usage: { inputTokens: 9800, outputTokens: 252, cachedInputTokens: 4000 },
    },
  );
});

void test('adaptRunSessionMessage preserves provider auth wait for replayed UI projection', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: '2026-07-23T11:00:00.000Z',
        type: 'provider_status',
        payload: {
          phase: 'auth_waiting',
          observedAt: '2026-07-23T11:00:00.000Z',
        },
      },
    }),
    {
      kind: 'provider_runtime_updated',
      runId: RUN_ID,
      threadId: THREAD_ID,
      providerRuntime: {
        phase: 'auth_waiting',
        observedAt: '2026-07-23T11:00:00.000Z',
      },
    },
  );
});

void test('adaptRunSessionMessage maps context usage snapshots without estimating them', () => {
  const contextUsage = {
    state: 'measured' as const,
    modelId: 'gpt-5.6-sol',
    inputTokens: 122_400,
    contextWindow: 272_000,
    thresholdTokens: 244_800,
  };

  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 4,
        ts: '2026-07-17T00:00:00.000Z',
        type: 'context_usage_updated',
        payload: contextUsage,
      },
    }),
    {
      kind: 'context_usage_updated',
      threadId: THREAD_ID,
      contextUsage,
    },
  );
});

void test('adaptRunSessionMessage promotes applied interjects to steer_applied effects', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 2,
        ts: new Date().toISOString(),
        type: 'interject_applied',
        payload: {
          runId: RUN_ID,
          count: 1,
          receivedSeqs: [1],
        },
      },
    }),
    {
      kind: 'steer_applied',
      runId: RUN_ID,
      threadId: THREAD_ID,
      receivedSeqs: [1],
    },
  );
});

void test('adaptRunSessionMessage maps semantic subagent lifecycle events to transcript entries', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: CHILD_RUN_ID,
        threadId: THREAD_ID,
        seq: 7,
        ts: new Date().toISOString(),
        type: 'subagent_terminal',
        payload: {
          deliveryId: 'delivery-1',
          parentRunId: RUN_ID,
          childRunId: CHILD_RUN_ID,
          subagentType: 'worker',
          terminalState: 'failed',
          ok: false,
          reason: 'child_error',
          result: 'sub-agent failed',
        },
      },
    }),
    {
      kind: 'subagent_activity_added',
      threadId: THREAD_ID,
      entry: {
        kind: 'subagent_activity',
        deliveryId: 'delivery-1',
        parentRunId: RUN_ID,
        childRunId: CHILD_RUN_ID,
        subagentType: 'worker',
        state: 'failed',
        reason: 'child_error',
        result: 'sub-agent failed',
      },
    },
  );
});

void test('adaptRunSessionMessage keeps queued and rejected PTC admission distinct in live tool rows', () => {
  assert.deepEqual(
    adaptRunSessionMessage({
      type: 'run.event',
      event: {
        runId: RUN_ID,
        threadId: THREAD_ID,
        seq: 8,
        ts: new Date().toISOString(),
        type: 'tool_result',
        payload: {
          callId: 'call-ptc-queued',
          step: 1,
          tool: 'exec',
          ok: true,
          computerFilesMayHaveChanged: false,
          displayText: JSON.stringify({
            kind: 'ptc_execute_code_cell_queued',
            status: 'queued',
            cellId: 'ptc_cell_queued',
          }),
          raw: {
            kind: 'ptc_execute_code_cell_queued',
            status: 'queued',
            cellId: 'ptc_cell_queued',
          },
        },
      },
    }),
    {
      kind: 'transcript_activity_added',
      threadId: THREAD_ID,
      entry: {
        kind: 'tool_activity',
        tool: 'exec',
        state: 'completed',
        callId: 'call-ptc-queued',
        ptcStatus: 'queued',
      },
      computerFilesMayHaveChanged: false,
    },
  );

  const rejected = adaptRunSessionMessage({
    type: 'run.event',
    event: {
      runId: RUN_ID,
      threadId: THREAD_ID,
      seq: 9,
      ts: new Date().toISOString(),
      type: 'tool_result',
      payload: {
        callId: 'call-ptc-rejected',
        step: 1,
        tool: 'exec',
        ok: false,
        errorCode: 'execution_failed',
        error: 'resource budget is insufficient',
        computerFilesMayHaveChanged: false,
        displayText: 'resource budget is insufficient',
        raw: {
          kind: 'ptc_execute_code_error',
          reasonCode: 'resource_budget_insufficient',
          message: 'resource budget is insufficient',
        },
      },
    },
  });
  assert.equal(rejected?.kind, 'transcript_activity_added');
  if (rejected?.kind === 'transcript_activity_added') {
    assert.deepEqual(rejected.entry, {
      kind: 'tool_activity',
      tool: 'exec',
      state: 'failed',
      callId: 'call-ptc-rejected',
      ptcStatus: 'resource_budget_insufficient',
    });
  }
});
