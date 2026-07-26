import test from 'node:test';
import assert from 'node:assert/strict';

import type { RunId } from '@geulbat/protocol/ids';
import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import type { SubagentRuntimeDiagnostics } from '@geulbat/protocol/run-events';

import { testRunId } from '../../test-support/run-id.js';
import { TEST_CHILD_MODEL_REGISTRATION } from '../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../test-support/thread-id.js';
import type { AgentEvent } from '../runtime-contracts.js';
import type { ChildRunRegistry } from './runtime/child-run-registry.js';
import { routeChildAgentEvent } from './subagent-event-routing.js';

function createChildRunsRecorder(): {
  pending: RunId[];
  running: RunId[];
  runtimeObservations: SubagentRuntimeDiagnostics[];
  childRuns: Pick<
    ChildRunRegistry,
    | 'getChildRun'
    | 'markChildApprovalPending'
    | 'markChildRunning'
    | 'updateChildRuntime'
  >;
} {
  const pending: RunId[] = [];
  const running: RunId[] = [];
  const runtimeObservations: SubagentRuntimeDiagnostics[] = [];
  let runtime: SubagentRuntimeDiagnostics = {
    phase: 'provider_waiting',
    observedAt: '2026-07-23T09:52:00.000Z',
    partialOutputAvailable: false,
  };
  return {
    pending,
    running,
    runtimeObservations,
    childRuns: {
      getChildRun(childRunId) {
        return {
          ...TEST_CHILD_MODEL_REGISTRATION,
          childRunId,
          childThreadId: testThreadId(91),
          parentRunId: testRunId('route-recorder-parent'),
          ownerThreadId: testThreadId(92),
          subagentType: 'explorer',
          status: 'running',
          result: null,
          completedAt: null,
          reason: null,
          runtime,
          updatedAt: runtime.observedAt,
        };
      },
      markChildApprovalPending(childRunId) {
        pending.push(childRunId);
      },
      markChildRunning(childRunId) {
        running.push(childRunId);
      },
      updateChildRuntime(args) {
        runtime = args.runtime;
        runtimeObservations.push(args.runtime);
        return this.getChildRun(args.childRunId);
      },
    },
  };
}

void test('routeChildAgentEvent publishes parent approval bridge before the original child approval event', () => {
  const parentRunId = testRunId('route-approval-parent');
  const childRunId = testRunId('route-approval-child');
  const approval: ApprovalRequired = {
    callId: 'call-approval-1',
    runId: childRunId,
    threadId: testThreadId(91),
    toolName: 'write_file',
    approvalClass: 'write_file',
    permissionMode: 'basic',
    argumentsPreview: { path: 'notes.md' },
    sideEffectLevel: 'write',
  };
  const approvalEvent: AgentEvent = {
    type: 'approval_required',
    payload: approval,
  };
  const emittedEvents: AgentEvent[] = [];
  const recorder = createChildRunsRecorder();

  const terminalMessage = routeChildAgentEvent({
    event: approvalEvent,
    parentRunId,
    childRunId,
    childThreadId: testThreadId(91),
    subagentType: 'worker',
    capabilities: [],
    childRuns: recorder.childRuns,
    emitAgentEvent(event) {
      emittedEvents.push(event);
    },
    now: () => new Date('2026-07-23T09:52:01.000Z'),
  });

  assert.equal(terminalMessage, undefined);
  assert.deepEqual(recorder.pending, [childRunId]);
  assert.deepEqual(recorder.running, []);
  assert.deepEqual(emittedEvents, [
    {
      type: 'subagent_approval_required',
      payload: {
        parentRunId,
        childRunId,
        subagentType: 'worker',
        capabilities: [],
        toolSurface: 'worker',
        runtime: {
          phase: 'approval_pending',
          observedAt: '2026-07-23T09:52:01.000Z',
          lastTool: {
            name: 'write_file',
            callId: 'call-approval-1',
            state: 'running',
          },
          partialOutputAvailable: false,
        },
        approval,
      },
    },
    approvalEvent,
  ]);
});

void test('routeChildAgentEvent returns child runs to running for non-approval events without forwarding them', () => {
  const childRunId = testRunId('route-running-child');
  const recorder = createChildRunsRecorder();
  const emittedEvents: AgentEvent[] = [];

  const terminalMessage = routeChildAgentEvent({
    event: {
      type: 'commentary_delta',
      payload: { text: 'working' },
    },
    parentRunId: testRunId('route-running-parent'),
    childRunId,
    childThreadId: testThreadId(93),
    subagentType: 'explorer',
    capabilities: ['ptc'],
    childRuns: recorder.childRuns,
    emitAgentEvent(event) {
      emittedEvents.push(event);
    },
    now: () => new Date('2026-07-23T09:52:02.000Z'),
  });

  assert.equal(terminalMessage, undefined);
  const repeatedDeltaResult = routeChildAgentEvent({
    event: {
      type: 'commentary_delta',
      payload: { text: 'still working' },
    },
    parentRunId: testRunId('route-running-parent'),
    childRunId,
    childThreadId: testThreadId(93),
    subagentType: 'explorer',
    capabilities: ['ptc'],
    childRuns: recorder.childRuns,
    emitAgentEvent(event) {
      emittedEvents.push(event);
    },
    now: () => new Date('2026-07-23T09:52:02.500Z'),
  });
  assert.equal(repeatedDeltaResult, undefined);
  assert.deepEqual(recorder.pending, []);
  assert.deepEqual(recorder.running, [childRunId, childRunId]);
  assert.deepEqual(recorder.runtimeObservations, [
    {
      phase: 'provider_streaming',
      observedAt: '2026-07-23T09:52:02.000Z',
      partialOutputAvailable: true,
    },
  ]);
  assert.deepEqual(emittedEvents, []);
});

void test('routeChildAgentEvent persists provider rate-limit admission separately from response wait', () => {
  const childRunId = testRunId('route-rate-limit-child');
  const recorder = createChildRunsRecorder();

  routeChildAgentEvent({
    event: {
      type: 'provider_status',
      payload: {
        phase: 'rate_limit_waiting',
        observedAt: '2026-07-23T09:52:02.250Z',
        request: {
          startedAt: '2026-07-23T09:52:00.000Z',
          lastEventAt: '2026-07-23T09:52:01.500Z',
          attemptCount: 1,
          retry: {
            available: true,
            performed: true,
            outcome: 'scheduled',
          },
        },
      },
    },
    parentRunId: testRunId('route-rate-limit-parent'),
    childRunId,
    childThreadId: testThreadId(93),
    subagentType: 'explorer',
    capabilities: [],
    childRuns: recorder.childRuns,
    now: () => new Date('2026-07-23T09:52:09.000Z'),
  });

  assert.deepEqual(recorder.runtimeObservations, [
    {
      phase: 'rate_limit_waiting',
      observedAt: '2026-07-23T09:52:02.250Z',
      partialOutputAvailable: false,
      providerRequest: {
        startedAt: '2026-07-23T09:52:00.000Z',
        lastEventAt: '2026-07-23T09:52:01.500Z',
        attemptCount: 1,
        retry: {
          available: true,
          performed: true,
          outcome: 'scheduled',
        },
      },
    },
  ]);
});

void test('routeChildAgentEvent persists provider auth refresh wait for reconnect diagnostics', () => {
  const childRunId = testRunId('route-auth-wait-child');
  const recorder = createChildRunsRecorder();

  routeChildAgentEvent({
    event: {
      type: 'provider_status',
      payload: {
        phase: 'auth_waiting',
        observedAt: '2026-07-23T09:52:02.125Z',
      },
    },
    parentRunId: testRunId('route-auth-wait-parent'),
    childRunId,
    childThreadId: testThreadId(94),
    subagentType: 'worker',
    capabilities: [],
    childRuns: recorder.childRuns,
    now: () => new Date('2026-07-23T09:52:09.000Z'),
  });

  assert.deepEqual(recorder.runtimeObservations, [
    {
      phase: 'auth_waiting',
      observedAt: '2026-07-23T09:52:02.125Z',
      partialOutputAvailable: false,
    },
  ]);
});

void test('routeChildAgentEvent extracts terminal fallback text from child error events', () => {
  const childRunId = testRunId('route-error-child');
  const recorder = createChildRunsRecorder();

  const terminalMessage = routeChildAgentEvent({
    event: {
      type: 'error',
      payload: {
        code: 'execution_failed',
        message: 'child loop stopped after tool failure',
      },
    },
    parentRunId: testRunId('route-error-parent'),
    childRunId,
    childThreadId: testThreadId(94),
    subagentType: 'worker',
    capabilities: [],
    childRuns: recorder.childRuns,
    now: () => new Date('2026-07-23T09:52:03.000Z'),
  });

  assert.deepEqual(terminalMessage, {
    message: 'child loop stopped after tool failure',
    reason: 'child_error',
  });
  assert.deepEqual(recorder.pending, []);
  assert.deepEqual(recorder.running, [childRunId]);
});

void test('routeChildAgentEvent classifies provider, persistence, and failed-tool terminal reasons', () => {
  const parentRunId = testRunId('route-specific-errors-parent');
  const childThreadId = testThreadId(95);

  const providerFailure = routeChildAgentEvent({
    event: {
      type: 'error',
      payload: {
        code: 'llm_auth_failed',
        message: 'provider rejected the child request',
      },
    },
    parentRunId,
    childRunId: testRunId('route-provider-error-child'),
    childThreadId,
    subagentType: 'worker',
    capabilities: [],
    childRuns: createChildRunsRecorder().childRuns,
  });
  assert.equal(providerFailure?.reason, 'provider_error');

  const persistenceFailure = routeChildAgentEvent({
    event: {
      type: 'error',
      payload: {
        code: 'persistence_unavailable',
        message: 'runtime state store unavailable',
      },
    },
    parentRunId,
    childRunId: testRunId('route-persistence-error-child'),
    childThreadId,
    subagentType: 'worker',
    capabilities: [],
    childRuns: createChildRunsRecorder().childRuns,
  });
  assert.equal(persistenceFailure?.reason, 'persistence_error');

  const toolChildRunId = testRunId('route-tool-error-child');
  const toolRecorder = createChildRunsRecorder();
  routeChildAgentEvent({
    event: {
      type: 'tool_result',
      payload: {
        callId: 'call-shell-1',
        step: 1,
        tool: 'shell_command',
        ok: false,
        computerFilesMayHaveChanged: false,
        displayText: 'command failed',
        raw: null,
        errorCode: 'execution_failed',
        error: 'command failed',
      },
    },
    parentRunId,
    childRunId: toolChildRunId,
    childThreadId,
    subagentType: 'worker',
    capabilities: [],
    childRuns: toolRecorder.childRuns,
  });
  assert.deepEqual(toolRecorder.runtimeObservations.at(-1)?.lastTool, {
    name: 'shell_command',
    callId: 'call-shell-1',
    state: 'failed',
  });

  const toolFailure = routeChildAgentEvent({
    event: {
      type: 'error',
      payload: {
        code: 'execution_failed',
        message: 'child stopped after tool failure',
      },
    },
    parentRunId,
    childRunId: toolChildRunId,
    childThreadId,
    subagentType: 'worker',
    capabilities: [],
    childRuns: toolRecorder.childRuns,
  });
  assert.equal(toolFailure?.reason, 'tool_error');
});
