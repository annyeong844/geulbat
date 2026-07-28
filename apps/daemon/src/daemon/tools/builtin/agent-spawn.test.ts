import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { agentLoopKernelImplementation } from '@geulbat/agent-loop/kernel';
import type { ToolCapabilityPolicy } from '@geulbat/tool-library/tool-capability-policy';

import { agentSpawnTool, createAgentSpawnTool } from './agent-spawn.js';
import { createSubagentRunLauncher } from '../../agent/subagent-support.js';
import { createAgentLoopImplementationAdmission } from '../../agent/loop-implementation-admission.js';
import { createDaemonContext as createBaseDaemonContext } from '../../context.js';
import { createRunState } from '../../agent/runtime/run-state.js';
import { threadFilePath } from '../../sessions/paths.js';
import { testRunId } from '../../../test-support/run-id.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import { isToolObjectParameters } from '../types.js';
import type {
  DurableSubagentLaunchRequest,
  SubagentLaunchRequestInput,
  SubagentLaunchRequestStore,
} from '../../subagent-runtime-contracts.js';
import { createDaemonRuntimeStateStore } from '../../runtime-state-store.js';

function createDaemonContext(
  options: Parameters<typeof createBaseDaemonContext>[0] = {},
): ReturnType<typeof createBaseDaemonContext> {
  return createBaseDaemonContext({
    ...options,
    subagentLaunchRequests: createTestSubagentLaunchRequestStore(),
  });
}

function createTestSubagentLaunchRequestStore(): SubagentLaunchRequestStore {
  const requests = new Map<string, DurableSubagentLaunchRequest>();
  const launchInputs = new Map<string, SubagentLaunchRequestInput>();
  let enqueueOrder = 0;
  const keyOf = (parentRunId: string, toolCallId: string) =>
    `${parentRunId}\u0000${toolCallId}`;
  const update = (
    childRunId: string,
    launchState: DurableSubagentLaunchRequest['launchState'],
    failureReason: string | null,
  ): void => {
    const current = [...requests.values()].find(
      (request) => request.childRunId === childRunId,
    );
    assert.ok(current, `expected durable launch request ${childRunId}`);
    requests.set(keyOf(current.parentRunId, current.toolCallId), {
      ...current,
      launchState,
      deferReason: null,
      failureReason,
      updatedAt: new Date().toISOString(),
    });
  };

  return {
    enqueueSubagentLaunchBatch(inputs) {
      const batchId = inputs.length > 1 ? randomUUID() : null;
      return inputs.map((input, batchPosition) => {
        const timestamp = new Date().toISOString();
        const request: DurableSubagentLaunchRequest = {
          enqueueOrder: (enqueueOrder += 1),
          childRunId: assertRunId(randomUUID()),
          childThreadId: assertThreadId(randomUUID()),
          previousChildRunId: null,
          parentRunId: input.parentRunId,
          ownerThreadId: input.ownerThreadId,
          toolCallId: input.toolCallId,
          batchId,
          batchPosition,
          launchState: 'queued',
          priorityClass: 'normal',
          deferReason: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          failureReason: null,
          runtime: {
            phase: 'queued',
            observedAt: timestamp,
            partialOutputAvailable: false,
          },
        };
        requests.set(keyOf(input.parentRunId, input.toolCallId), request);
        launchInputs.set(request.childRunId, input);
        return request;
      });
    },
    readSubagentLaunchRequest({ parentRunId, toolCallId }) {
      return requests.get(keyOf(parentRunId, toolCallId));
    },
    readSubagentLaunchRequestByChildRunId(childRunId) {
      return [...requests.values()].find(
        (request) => request.childRunId === childRunId,
      );
    },
    readSubagentLaunchInput(childRunId) {
      const input = launchInputs.get(childRunId);
      assert.ok(input, `expected durable launch input ${childRunId}`);
      return input;
    },
    readQueuedSubagentLaunchRequests() {
      const priorityOrder = { high: 0, normal: 1, low: 2 } as const;
      return [...requests.values()]
        .filter((request) => request.launchState === 'queued')
        .sort(
          (left, right) =>
            priorityOrder[left.priorityClass] -
              priorityOrder[right.priorityClass] ||
            left.enqueueOrder - right.enqueueOrder,
        );
    },
    markSubagentLaunchDeferredBatch({ childRunIds, deferReason }) {
      return childRunIds.map((childRunId) => {
        const current = [...requests.values()].find(
          (request) => request.childRunId === childRunId,
        );
        assert.ok(current);
        assert.equal(current.launchState, 'queued');
        const updated = {
          ...current,
          deferReason,
          updatedAt: new Date().toISOString(),
        };
        requests.set(keyOf(current.parentRunId, current.toolCallId), updated);
        return updated;
      });
    },
    cancelQueuedSubagentLaunchRequest({ childRunId, ownerThreadId }) {
      const current = [...requests.values()].find(
        (request) => request.childRunId === childRunId,
      );
      assert.ok(current);
      assert.equal(current.ownerThreadId, ownerThreadId);
      if (current.launchState === 'queued') {
        update(childRunId, 'cancelled', null);
      }
      const updated = [...requests.values()].find(
        (request) => request.childRunId === childRunId,
      );
      assert.ok(updated);
      return updated;
    },
    updateQueuedSubagentLaunchPriority({
      childRunId,
      ownerThreadId,
      priorityClass,
    }) {
      const current = [...requests.values()].find(
        (request) => request.childRunId === childRunId,
      );
      assert.ok(current);
      assert.equal(current.ownerThreadId, ownerThreadId);
      if (
        current.launchState === 'queued' &&
        current.priorityClass !== priorityClass
      ) {
        requests.set(keyOf(current.parentRunId, current.toolCallId), {
          ...current,
          priorityClass,
          updatedAt: new Date().toISOString(),
        });
      }
      const updated = [...requests.values()].find(
        (request) => request.childRunId === childRunId,
      );
      assert.ok(updated);
      return updated;
    },
    retryInterruptedSubagentLaunch() {
      throw new Error(
        'agent_spawn test store does not retry interrupted launches',
      );
    },
    markSubagentLaunchStarting(childRunId) {
      update(childRunId, 'starting', null);
    },
    markSubagentLaunchStarted(childRunId) {
      update(childRunId, 'started', null);
    },
    markSubagentLaunchFailedToStart({ childRunId, reason }) {
      update(childRunId, 'failed_to_start', reason);
    },
    recordSubagentRuntimeObservation({ childRunId, runtime }) {
      const current = [...requests.values()].find(
        (request) => request.childRunId === childRunId,
      );
      assert.ok(current);
      requests.set(keyOf(current.parentRunId, current.toolCallId), {
        ...current,
        runtime,
        updatedAt: runtime.observedAt,
      });
    },
  };
}

void test('agent_spawn outward parameters omit compatibility-only mode', () => {
  const parameters = agentSpawnTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(Object.keys(parameters.properties), [
    'task',
    'subagent_type',
    'capabilities',
    'model_id',
    'reasoning_effort',
  ]);
  assert.deepEqual(parameters.required, ['task', 'subagent_type']);
  assert.equal(agentSpawnTool.recoveryStrategy, 'reconcile_then_replay');
});

void test('agent_spawn restart recovery returns the original interrupted child handle without launching a duplicate', async (t) => {
  const fixtureRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-recovery-'),
  );
  const homeStateRoot = join(fixtureRoot, 'home-state');
  const stateRoot = join(fixtureRoot, 'workspace-state');
  const parentRunId = testRunId('agent-spawn-recovery-parent');
  const ownerThreadId = testThreadId(190);
  const toolCallId = 'call-agent-spawn-recovery';
  const originalStore = await createDaemonRuntimeStateStore({ homeStateRoot });
  const [accepted] = originalStore.enqueueSubagentLaunchBatch([
    {
      toolCallId,
      task: 'recover the original child handle',
      subagentType: 'explorer',
      capabilities: [],
      parentRunId,
      ownerThreadId,
      stateRoot,
      workingDirectory: fixtureRoot,
      permissionMode: 'basic',
      ultraReasoning: false,
      modelPin: TEST_INHERITED_SOL_MODEL_PIN,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    },
  ]);
  assert.ok(accepted);
  originalStore.markSubagentLaunchStarting(accepted.childRunId);
  originalStore.markSubagentLaunchStarted(accepted.childRunId);
  originalStore.close();

  const replacementStore = await createDaemonRuntimeStateStore({
    homeStateRoot,
  });
  const daemonContext = createBaseDaemonContext({
    homeStateRoot,
    subagentLaunchRequests: replacementStore,
  });
  t.after(async () => {
    await daemonContext.subagent.launchPromotions?.close();
    replacementStore.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  assert.equal(
    replacementStore.readSubagentLaunchRequestByChildRunId(accepted.childRunId)
      ?.launchState,
    'interrupted',
  );

  let launchCount = 0;
  const recoveringTool = createAgentSpawnTool({
    async startBackgroundRun() {
      launchCount += 1;
      throw new Error('interrupted child recovery must not launch a duplicate');
    },
  });
  const parentRunState = createRunState({
    runId: parentRunId,
    runContext: makeRunContext({
      threadId: ownerThreadId,
      stateRoot,
    }),
  });
  const result = await recoveringTool.execute(
    {
      task: 'recover the original child handle',
      subagent_type: 'explorer',
      model_id: 'retired-model-id',
    },
    {
      kind: 'agent',
      runOwnerKind: 'root_main',
      callId: toolCallId,
      stateRoot,
      workingDirectory: fixtureRoot,
      threadId: ownerThreadId,
      runId: parentRunId,
      runState: parentRunState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: false,
      runtimeServices: daemonContext,
      memoryIndex: undefined,
      emitAgentEvent: () => {},
      permissionMode: 'basic',
      ultraReasoning: false,
      computerSessionId: 'replacement-session',
    },
  );

  assert.equal(launchCount, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output), {
    ok: true,
    childRunId: accepted.childRunId,
    childThreadId: accepted.childThreadId,
    subagentType: 'explorer',
    launchState: 'started',
    modelId: TEST_INHERITED_SOL_MODEL_PIN.modelId,
    reasoningEffort:
      TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection.reasoningEffort,
    selectionSource: TEST_INHERITED_SOL_MODEL_PIN.selectionSource,
  });
});

void test('agent_spawn requires run context', async () => {
  const result = await agentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-1',
      stateRoot: '/tmp/home-state',
      signal: new AbortController().signal,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /run context is required/);
});

void test('agent_spawn rejects unexpected keys before execution', async () => {
  const result = await agentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
      extra: true,
    },
    {
      callId: 'call-extra',
      stateRoot: '/tmp/home-state',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /unexpected keys: extra\./);
});

void test('agent_spawn rejects invalid subagent_type at the parser boundary', async () => {
  const result = await agentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'janitor',
    },
    {
      callId: 'call-invalid-subagent',
      stateRoot: '/tmp/home-state',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /subagent_type must be one of/);
});

void test('agent_spawn rejects invalid mode at the parser boundary', async () => {
  const result = await agentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
      mode: 'queued',
    },
    {
      callId: 'call-invalid-mode',
      stateRoot: '/tmp/home-state',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /mode must be one of/);
});

void test('agent_spawn rejects whitespace-only task at the parser boundary', async () => {
  const result = await agentSpawnTool.execute(
    {
      task: '   ',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-empty-task',
      stateRoot: '/tmp/home-state',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /task.*required/);
});

void test('agent_spawn rejects reasoning_effort without model_id', async () => {
  const result = await agentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
      reasoning_effort: 'high',
    },
    {
      callId: 'call-effort-without-model',
      stateRoot: '/tmp/home-state',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /reasoning_effort requires model_id/);
});

void test('agent_spawn rejects recursive launch from a non-Ultra child', async () => {
  const threadId = testThreadId(79);
  const daemonContext = createDaemonContext();
  const childRunState = createRunState({
    runId: 'standard-child',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
    parentRunId: 'root-run',
  });

  const result = await agentSpawnTool.execute(
    {
      task: 'delegate again',
      subagent_type: 'explorer',
    },
    {
      kind: 'agent',
      ultraReasoning: false,
      runOwnerKind: 'child',
      callId: 'call-standard-recursive',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      workingDirectory: '/tmp/home-state',
      threadId,
      runId: 'standard-child',
      runState: childRunState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: false,
      permissionMode: 'basic',
      memoryIndex: undefined,
      emitAgentEvent: () => {},
      runtimeServices: daemonContext,
      computerSessionId: 'standard-child-session',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /only with Ultra reasoning/);
});

void test('agent_spawn fixed routing rejects a conflicting model request', async () => {
  const threadId = testThreadId(80);
  const parentRunId = testRunId('fixed-model-conflict-parent');
  const daemonContext = createDaemonContext();
  let startCalled = false;
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: async () => {
      startCalled = true;
      throw new Error('conflicting fixed routing must not start a child');
    },
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
      model_id: 'grok-4.5',
    },
    {
      callId: 'call-fixed-model-conflict',
      stateRoot: '/tmp/home-state',
      threadId,
      runId: parentRunId,
      runState: createRunState({
        runId: parentRunId,
        runContext: makeRunContext({
          threadId,
          stateRoot: '/tmp/home-state',
        }),
      }),
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      runtimeServices: daemonContext,
      computerSessionId: 'fixed-routing-session',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      subagentModelRouting: {
        mode: 'fixed',
        choice: { modelId: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /fixes all descendants to 'gpt-5\.6-luna'/);
  assert.equal(startCalled, false);
});

void test('agent_spawn automatic routing selects Grok with its default effort', async () => {
  const threadId = testThreadId(81);
  const parentRunId = testRunId('auto-grok-parent');
  const daemonContext = createDaemonContext();
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async (input) => {
        assert.deepEqual(input.providerModel, {
          providerId: 'grok_oauth',
          model: 'grok-4.5',
        });
        assert.equal(input.reasoningEffort, 'high');
        assert.deepEqual(input.subagentModelRouting, { mode: 'auto' });
        return { ok: true, finalProse: 'grok child done' };
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
      model_id: 'grok-4.5',
    },
    {
      callId: 'call-auto-grok-child',
      stateRoot: '/tmp/home-state',
      threadId,
      runId: parentRunId,
      runState: createRunState({
        runId: parentRunId,
        runContext: makeRunContext({
          threadId,
          stateRoot: '/tmp/home-state',
        }),
      }),
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      runtimeServices: daemonContext,
      computerSessionId: 'automatic-routing-session',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      subagentModelRouting: { mode: 'auto' },
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    childRunId: string;
    modelId: string;
    reasoningEffort: string;
    selectionSource: string;
  };
  assert.equal(payload.modelId, 'grok-4.5');
  assert.equal(payload.reasoningEffort, 'high');
  assert.equal(payload.selectionSource, 'model_selected');

  const childRunId = assertRunId(payload.childRunId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      daemonContext.childRuns.getChildRun(childRunId)?.status === 'completed'
    ) {
      break;
    }
    await delay(10);
  }
  assert.equal(
    daemonContext.childRuns.getChildRun(childRunId)?.status,
    'completed',
  );
  assert.deepEqual(daemonContext.childRuns.getChildRun(childRunId)?.modelPin, {
    modelId: 'grok-4.5',
    providerRunSelection: {
      providerModel: { providerId: 'grok_oauth', model: 'grok-4.5' },
      reasoningEffort: 'high',
    },
    selectionSource: 'model_selected',
  });
});

void test('agent_spawn allows an explicitly PTC-enabled explorer to launch nested helper agents', async () => {
  const childThreadId = testThreadId(1);
  const daemonContext = createDaemonContext();
  const childRunState = createRunState({
    runId: 'child-run',
    runContext: makeRunContext({
      threadId: childThreadId,
      stateRoot: '/tmp/home-state',
    }),
    parentRunId: 'top-run',
  });
  let capturedDirectRegistryNames: readonly string[] | undefined;
  let capturedAllowedRegistryNames: readonly string[] | undefined;
  let capturedPromptProfile: string | undefined;
  let capturedPrompt = '';
  let markNestedStarted!: () => void;
  const nestedStarted = new Promise<void>((resolve) => {
    markNestedStarted = resolve;
  });
  let releaseNested!: () => void;
  const nestedFinished = new Promise<void>((resolve) => {
    releaseNested = resolve;
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async (input) => {
        capturedDirectRegistryNames = input.toolSurface?.directRegistryNames;
        capturedAllowedRegistryNames = input.toolSurface?.allowedRegistryNames;
        capturedPromptProfile = input.promptProfile;
        capturedPrompt = input.prompt;
        markNestedStarted();
        await nestedFinished;
        return {
          ok: true,
          finalProse: 'nested ok',
        };
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
      capabilities: ['ptc'],
    },
    {
      kind: 'agent',
      ultraReasoning: true,
      runOwnerKind: 'child',
      callId: 'call-2',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      workingDirectory: '/tmp/home-state',
      threadId: childThreadId,
      runId: 'child-run',
      runState: childRunState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: false,
      permissionMode: 'basic',
      memoryIndex: undefined,
      emitAgentEvent: () => {},
      runtimeServices: daemonContext,
      computerSessionId: 'nested-helper-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    childRunId: string;
    launchState: string;
  };
  const nestedChildRunId = assertRunId(payload.childRunId);
  assert.equal(payload.ok, true);
  assert.equal(payload.launchState, 'started');
  assert.equal(childRunState.backgroundChildRunIds.has(nestedChildRunId), true);

  await nestedStarted;
  assert.deepEqual(capturedDirectRegistryNames, [
    'inspect_git',
    'list_files',
    'read_file',
    'read_tool_output',
    'search_files',
    'exec',
    'wait',
    'agent_spawn',
    'agent_wait',
    'agent_stop',
    'agent_set_priority',
    'agent_retry',
    'submit_result_report',
  ]);
  assert.deepEqual(capturedAllowedRegistryNames, [
    'inspect_git',
    'list_files',
    'read_file',
    'read_tool_output',
    'search_files',
    'exec',
    'wait',
    'agent_spawn',
    'agent_wait',
    'agent_stop',
    'agent_set_priority',
    'agent_retry',
    'submit_result_report',
  ]);
  assert.equal(capturedPromptProfile, 'explorer');
  assert.ok(capturedAllowedRegistryNames?.includes('agent_spawn'));
  assert.ok(capturedAllowedRegistryNames?.includes('agent_wait'));
  assert.equal(
    capturedPrompt,
    [
      '<file-context>',
      'Current file: none',
      'Selection: none',
      '</file-context>',
      '',
      'read files',
    ].join('\n'),
  );

  releaseNested();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!childRunState.backgroundChildRunIds.has(nestedChildRunId)) {
      break;
    }
    await delay(10);
  }

  assert.equal(
    childRunState.backgroundChildRunIds.has(nestedChildRunId),
    false,
  );
  assert.equal(
    daemonContext.childRuns.getChildRun(nestedChildRunId)?.status,
    'completed',
  );
  assert.deepEqual(
    daemonContext.childRuns.getChildRun(nestedChildRunId)?.capabilities,
    ['ptc'],
  );
});

void test('agent_spawn keeps ordinary explorers on the typed read and orchestration surface', async () => {
  const threadId = testThreadId(101);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-typed-explorer',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  let capturedDirectRegistryNames: readonly string[] | undefined;
  let capturedAllowedRegistryNames: readonly string[] | undefined;
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async (input) => {
        capturedDirectRegistryNames = input.toolSurface?.directRegistryNames;
        capturedAllowedRegistryNames = input.toolSurface?.allowedRegistryNames;
        return { ok: true, finalProse: 'typed explorer complete' };
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    { task: 'inspect files', subagent_type: 'explorer' },
    {
      callId: 'call-typed-explorer',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      threadId,
      runId: 'top-run-typed-explorer',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      runtimeServices: daemonContext,
      computerSessionId: 'typed-explorer-session',
    },
  );

  assert.equal(result.ok, true);
  for (
    let attempt = 0;
    attempt < 50 && !capturedDirectRegistryNames;
    attempt += 1
  ) {
    await delay(10);
  }
  const expectedToolNames = [
    'inspect_git',
    'list_files',
    'read_file',
    'read_tool_output',
    'search_files',
    'agent_wait',
    'agent_stop',
    'agent_set_priority',
    'agent_retry',
    'submit_result_report',
  ];
  assert.deepEqual(capturedDirectRegistryNames, expectedToolNames);
  assert.deepEqual(capturedAllowedRegistryNames, expectedToolNames);
});

void test('agent_spawn rejects PTC capability on worker children', async () => {
  const result = await agentSpawnTool.execute(
    {
      task: 'rewrite file',
      subagent_type: 'worker',
      capabilities: ['ptc'],
    },
    {
      callId: 'call-worker-ptc-rejected',
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.match(result.error ?? '', /only to explorer/u);
});

void test('agent_spawn rejects worker spawn when approval routing is unavailable', async () => {
  const threadId = testThreadId(4);
  const parentState = createRunState({
    runId: 'top-run-2',
    runContext: makeRunContext({
      threadId,
    }),
  });

  const result = await agentSpawnTool.execute(
    {
      task: 'rewrite file',
      subagent_type: 'worker',
    },
    {
      callId: 'call-4',
      stateRoot: '/tmp/home-state',
      threadId,
      runId: 'top-run-2',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /approval event routing/);
});

void test('agent_spawn fails closed when the computer session is unavailable', async () => {
  const threadId = testThreadId(40);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-no-approval-session',
    runContext: makeRunContext({ threadId, stateRoot: '/tmp/home-state' }),
  });
  let childLoopCalled = false;
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => {
        childLoopCalled = true;
        return { ok: true, finalProse: 'must not run' };
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    { task: 'inspect files', subagent_type: 'explorer' },
    {
      callId: 'call-no-approval-session',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      threadId,
      runId: 'top-run-no-approval-session',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      runtimeServices: daemonContext,
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    launchState: string;
    errorCode: string;
    error: string;
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.launchState, 'rejected');
  assert.equal(payload.errorCode, 'execution_failed');
  assert.match(payload.error, /computer session is unavailable/u);
  assert.equal(childLoopCalled, false);
});

void test('agent_spawn rejects incompatible loop contracts before child run admission', async () => {
  const threadId = testThreadId(41);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-incompatible-child-loop',
    runContext: makeRunContext({ threadId, stateRoot: '/tmp/home-state' }),
  });
  const incompatible = {
    ...agentLoopKernelImplementation,
    implementationId: 'test.incompatible-child-loop',
    contractVersion: '2',
  };
  let childLoopCalled = false;
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      loopImplementationAdmission: createAgentLoopImplementationAdmission({
        additionalImplementations: [incompatible],
        selectImplementationId: () => incompatible.implementationId,
      }),
      runAgentLoop: async () => {
        childLoopCalled = true;
        return { ok: true, finalProse: 'must not run' };
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    { task: 'inspect files', subagent_type: 'explorer' },
    {
      callId: 'call-incompatible-child-loop',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      threadId,
      runId: 'top-run-incompatible-child-loop',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      runtimeServices: daemonContext,
      computerSessionId: 'incompatible-child-loop-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    launchState: string;
    errorCode: string;
    error: string;
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.launchState, 'rejected');
  assert.equal(payload.errorCode, 'execution_failed');
  assert.match(payload.error, /contract is incompatible/u);
  assert.equal(childLoopCalled, false);
  assert.deepEqual([...parentState.backgroundChildRunIds], []);
});

void test('agent_spawn returns launch-only ack and tracks child state in the registry', async () => {
  const threadId = testThreadId(5);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-background',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  let childStarted = false;
  let releaseChild!: () => void;
  const childFinished = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => {
        childStarted = true;
        await childFinished;
        return {
          ok: true,
          finalProse: 'child ok',
        };
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-background',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      threadId,
      runId: 'top-run-background',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      runtimeServices: daemonContext,
      computerSessionId: 'background-launch-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    childRunId: string;
    childThreadId: string;
    launchState: string;
  };
  const childRunId = assertRunId(payload.childRunId);
  assert.equal(payload.ok, true);
  assert.equal(payload.launchState, 'started');
  assert.equal(parentState.backgroundChildRunIds.has(childRunId), true);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (childStarted) {
      break;
    }
    await delay(10);
  }
  assert.equal(childStarted, true);
  assert.equal(
    daemonContext.childRuns.getChildRun(childRunId)?.status,
    'running',
  );

  releaseChild();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!parentState.backgroundChildRunIds.has(childRunId)) {
      break;
    }
    await delay(10);
  }

  assert.equal(parentState.backgroundChildRunIds.has(childRunId), false);
  assert.equal(
    daemonContext.childRuns.getChildRun(childRunId)?.status,
    'completed',
  );
});

void test('agent_spawn logs child loop throws before publishing terminal failure', async () => {
  const threadId = testThreadId(20);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-child-throw',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => {
        throw new Error('child loop exploded');
      },
    }).startBackgroundRun,
  });
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const result = await testAgentSpawnTool.execute(
      {
        task: 'read files',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-child-loop-throw',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot: '/tmp/home-state',
        threadId,
        runId: 'top-run-child-throw',
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: daemonContext,
        computerSessionId: 'throw-log-session',
      },
    );

    assert.equal(result.ok, true);
    const payload = JSON.parse(result.output) as {
      childRunId: string;
    };
    const childRunId = assertRunId(payload.childRunId);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        daemonContext.childRuns.getChildRun(childRunId)?.status === 'failed'
      ) {
        break;
      }
      await delay(20);
    }

    const childRun = daemonContext.childRuns.getChildRun(childRunId);
    assert.equal(childRun?.status, 'failed');
    assert.equal(childRun?.reason, 'child_error');

    const diagnostic = errors.find(([line]) =>
      String(line).includes('subagent runAgentLoop failed'),
    );
    assert.ok(diagnostic);
    assert.match(
      String(diagnostic[0]),
      /error \[agent\/subagent-support\] subagent runAgentLoop failed:/,
    );
    assert.equal(
      (diagnostic[1] as { childRunId?: unknown })?.childRunId,
      payload.childRunId,
    );
    assert.equal(
      (diagnostic[1] as { cause?: unknown })?.cause,
      'child loop exploded',
    );
  } finally {
    console.error = originalError;
  }
});

void test('agent_spawn uses child error event messages as terminal child results', async () => {
  const threadId = testThreadId(51);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-child-error-event',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async (input) => {
        input.onEvent({
          type: 'error',
          payload: {
            code: 'internal',
            message: 'child event failed',
          },
        });
        assert.equal(
          daemonContext.childRuns.getChildRun(assertRunId(input.runId))?.status,
          'running',
        );
        return {
          ok: false,
          finalProse: '',
        };
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-child-error-event',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      threadId,
      runId: 'top-run-child-error-event',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      runtimeServices: daemonContext,
      computerSessionId: 'child-error-event-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    childRunId: string;
  };
  const childRunId = assertRunId(payload.childRunId);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (daemonContext.childRuns.getChildRun(childRunId)?.status === 'failed') {
      break;
    }
    await delay(20);
  }

  const childRun = daemonContext.childRuns.getChildRun(childRunId);
  assert.equal(childRun?.status, 'failed');
  assert.equal(childRun?.reason, 'child_error');
  assert.equal(childRun?.result, 'child event failed');
});

void test('agent_spawn preserves child success when assistant transcript persistence fails', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-spawn-transcript-'),
  );
  const threadId = testThreadId(52);
  const childResultText = 'child completed despite transcript failure';
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-transcript-failure',
    runContext: makeRunContext({
      threadId,
      stateRoot,
    }),
  });
  const diagnostics: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    diagnostics.push(args);
  };

  try {
    const testAgentSpawnTool = createAgentSpawnTool({
      startBackgroundRun: createSubagentRunLauncher({
        runAgentLoop: async (input) => {
          const transcriptPath = threadFilePath(
            input.runContext.stateRoot,
            input.runContext.threadId,
          );
          await rm(transcriptPath, { recursive: true, force: true });
          await mkdir(transcriptPath, { recursive: true });
          return { ok: true, finalProse: childResultText };
        },
      }).startBackgroundRun,
    });

    const result = await testAgentSpawnTool.execute(
      {
        task: 'write result',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-transcript-persistence-failure',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot,
        threadId,
        runId: 'top-run-transcript-failure',
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: daemonContext,
        computerSessionId: 'transcript-failure-session',
      },
    );

    assert.equal(result.ok, true);
    const payload = JSON.parse(result.output) as { childRunId: string };
    const childRunId = assertRunId(payload.childRunId);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        daemonContext.childRuns.getChildRun(childRunId)?.status !== 'running'
      ) {
        break;
      }
      await delay(10);
    }

    const childRun = daemonContext.childRuns.getChildRun(childRunId);
    assert.equal(childRun?.status, 'completed');
    assert.equal(childRun?.result, childResultText);

    const backgroundResults =
      daemonContext.backgroundNotifications.consumeThreadBackgroundResults(
        threadId,
      );
    assert.equal(backgroundResults.length, 1);
    assert.equal(backgroundResults[0]?.terminalState, 'completed');
    assert.equal(backgroundResults[0]?.result, childResultText);
    const diagnostic = diagnostics.find((entry) =>
      String(entry[0]).includes(
        'child assistant transcript persistence failed',
      ),
    );
    assert.ok(diagnostic);
    assert.equal(
      (diagnostic[1] as { parentRunId?: unknown })?.parentRunId,
      'top-run-transcript-failure',
    );
    assert.equal(
      (diagnostic[1] as { childRunId?: unknown })?.childRunId,
      childRunId,
    );
    assert.equal(
      (diagnostic[1] as { subagentType?: unknown })?.subagentType,
      'explorer',
    );
  } finally {
    console.error = originalError;
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_spawn catches async publish failures without leaking unhandled rejections', async () => {
  const threadId = testThreadId(6);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-notify',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => ({
        ok: false,
        finalProse: '',
      }),
    }).startBackgroundRun,
  });
  const originalEnqueue =
    daemonContext.backgroundNotifications.enqueueThreadBackgroundResult;
  daemonContext.backgroundNotifications.enqueueThreadBackgroundResult = (() => {
    throw new Error('queue unavailable');
  }) as typeof daemonContext.backgroundNotifications.enqueueThreadBackgroundResult;

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const result = await testAgentSpawnTool.execute(
      {
        task: 'read files',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-notify',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot: '/tmp/home-state',
        threadId,
        runId: 'top-run-notify',
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: daemonContext,
        computerSessionId: 'publish-failure-session',
      },
    );

    assert.equal(result.ok, true);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        parentState.backgroundChildRunIds.size === 0 &&
        parentState.childRunIds.size === 0
      ) {
        break;
      }
      await delay(20);
    }

    assert.equal(parentState.backgroundChildRunIds.size, 0);
    assert.equal(parentState.childRunIds.size, 0);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    daemonContext.backgroundNotifications.enqueueThreadBackgroundResult =
      originalEnqueue;
  }
});

void test('agent_spawn settles the child checkpoint after a transient terminal-store publish failure', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-child-terminal-retry-'),
  );
  const threadId = testThreadId(21);
  const store = await createDaemonRuntimeStateStore({
    homeStateRoot: stateRoot,
  });
  const originalRecord = store.recordSubagentTerminalDelivery;
  let recordAttempts = 0;
  store.recordSubagentTerminalDelivery = (args) => {
    recordAttempts += 1;
    if (recordAttempts === 1) {
      throw new Error('transient terminal store failure');
    }
    return originalRecord(args);
  };
  const daemonContext = createDaemonContext({
    homeStateRoot: stateRoot,
    subagentTerminalDeliveries: store,
  });
  const parentRunId = testRunId('top-run-terminal-retry');
  const parentState = createRunState({
    runId: parentRunId,
    runContext: makeRunContext({
      threadId,
      stateRoot,
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => ({
        ok: true,
        finalProse: 'terminal retry completed',
      }),
    }).startBackgroundRun,
  });

  try {
    const result = await testAgentSpawnTool.execute(
      {
        task: 'finish despite one rejected terminal write',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-terminal-retry',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot,
        workingDirectory: stateRoot,
        threadId,
        runId: parentRunId,
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: daemonContext,
        computerSessionId: 'terminal-retry-session',
      },
    );
    assert.equal(result.ok, true);
    const payload = JSON.parse(result.output) as {
      childRunId: string;
      childThreadId: string;
    };
    const childRunId = assertRunId(payload.childRunId);
    const childThreadId = assertThreadId(payload.childThreadId);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        (await daemonContext.runCheckpoints.readThread(childThreadId))
          ?.status === 'terminal'
      ) {
        break;
      }
      await delay(10);
    }

    assert.equal(recordAttempts, 2);
    const checkpoint =
      await daemonContext.runCheckpoints.readThread(childThreadId);
    assert.equal(checkpoint?.status, 'terminal');
    assert.equal(checkpoint?.terminal?.acknowledged, true);
    assert.equal(
      store.readSubagentTerminalOutcomeByChildRunId(childRunId)?.result.result,
      'terminal retry completed',
    );
    assert.equal(daemonContext.childRuns.getChildRun(childRunId), undefined);
    const [pending] =
      daemonContext.backgroundNotifications.readThreadBackgroundResults(
        threadId,
      );
    assert.equal(pending?.childRunId, childRunId);
    assert.equal(pending?.result, 'terminal retry completed');
  } finally {
    store.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('agent_spawn keeps terminal notification independent from registry publish failure', async () => {
  const threadId = testThreadId(19);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-terminal-sink',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => ({
        ok: false,
        finalProse: '',
      }),
    }).startBackgroundRun,
  });
  const originalMarkChildTerminal = daemonContext.childRuns.markChildTerminal;
  daemonContext.childRuns.markChildTerminal = (() => {
    throw new Error('registry unavailable');
  }) as typeof daemonContext.childRuns.markChildTerminal;

  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const result = await testAgentSpawnTool.execute(
      {
        task: 'read files',
        subagent_type: 'explorer',
      },
      {
        callId: 'call-terminal-sink',
        providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
        stateRoot: '/tmp/home-state',
        threadId,
        runId: 'top-run-terminal-sink',
        runState: parentState,
        signal: new AbortController().signal,
        runSignal: new AbortController().signal,
        runtimeServices: daemonContext,
        computerSessionId: 'registry-publish-failure-session',
      },
    );

    assert.equal(result.ok, true);

    let backgroundResults =
      daemonContext.backgroundNotifications.consumeThreadBackgroundResults(
        threadId,
      );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        parentState.backgroundChildRunIds.size === 0 &&
        backgroundResults.length > 0
      ) {
        break;
      }
      await delay(20);
      backgroundResults =
        daemonContext.backgroundNotifications.consumeThreadBackgroundResults(
          threadId,
        );
    }

    assert.equal(parentState.backgroundChildRunIds.size, 0);
    assert.equal(parentState.childRunIds.size, 0);
    assert.deepEqual(unhandledRejections, []);
    assert.equal(backgroundResults.length, 1);
    assert.equal(backgroundResults[0]?.terminalState, 'failed');
    assert.equal(backgroundResults[0]?.reason, 'child_error');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    daemonContext.childRuns.markChildTerminal = originalMarkChildTerminal;
  }
});

void test('agent_spawn carries one admitted child tool policy without the legacy surface', async () => {
  const threadId = testThreadId(7);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-worker',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  let capturedApprovalContext:
    | {
        computerSessionId: string;
        permissionMode: 'basic' | 'full_access';
        ownerRunId?: string;
        ownerThreadId?: string;
      }
    | undefined;
  let capturedDirectRegistryNames: readonly string[] | undefined;
  let capturedAllowedRegistryNames: readonly string[] | undefined;
  let admittedToolCapabilityPolicy: ToolCapabilityPolicy | undefined;
  let capturedToolCapabilityPolicy: ToolCapabilityPolicy | undefined;
  let capturedLegacyToolSurface = false;
  let releaseChild!: () => void;
  const childStarted = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const baseAdmission = createAgentLoopImplementationAdmission();
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      loopImplementationAdmission: {
        async admitRun(input) {
          const selected = await baseAdmission.admitRun(input);
          if (!selected.ok) {
            return selected;
          }
          assert.ok(input.toolCapabilityPolicy);
          admittedToolCapabilityPolicy = input.toolCapabilityPolicy;
          return {
            ...selected,
            toolCapabilityPolicy: input.toolCapabilityPolicy,
          };
        },
      },
      runAgentLoop: async (input) => {
        capturedApprovalContext = input.approvalContext;
        capturedToolCapabilityPolicy = input.toolCapabilityPolicy;
        capturedLegacyToolSurface = input.toolSurface !== undefined;
        capturedDirectRegistryNames =
          input.toolCapabilityPolicy?.directRegistryNames;
        capturedAllowedRegistryNames =
          input.toolCapabilityPolicy?.allowedRegistryNames;
        await childStarted;
        return {
          ok: true,
          finalProse: 'child ok',
        };
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'rewrite file',
      subagent_type: 'worker',
    },
    {
      kind: 'agent',
      runOwnerKind: 'root_main',
      callId: 'call-worker-clamp',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',

      workingDirectory: 'workspace',
      threadId,
      runId: 'top-run-worker',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: false,
      runtimeServices: daemonContext,
      memoryIndex: undefined,
      emitAgentEvent: () => {},
      permissionMode: 'full_access',
      computerSessionId: 'parent-approval-session',
    },
  );

  assert.equal(result.ok, true);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (capturedApprovalContext) {
      break;
    }
    await delay(10);
  }
  assert.deepEqual(capturedApprovalContext, {
    computerSessionId: 'parent-approval-session',
    permissionMode: 'full_access',
    ownerRunId: 'top-run-worker',
    ownerThreadId: threadId,
  });
  assert.equal(capturedToolCapabilityPolicy, admittedToolCapabilityPolicy);
  assert.equal(capturedLegacyToolSurface, false);
  const expectedWorkerToolNames = [
    'inspect_git',
    'list_files',
    'read_file',
    'read_tool_output',
    'search_files',
    'write_file',
    'apply_patch',
    'manage_files',
    'agent_wait',
    'agent_stop',
    'agent_set_priority',
    'agent_retry',
    'submit_result_report',
  ].sort();
  assert.deepEqual(capturedDirectRegistryNames, expectedWorkerToolNames);
  assert.deepEqual(capturedAllowedRegistryNames, expectedWorkerToolNames);
  assert.equal(capturedDirectRegistryNames?.includes('exec_command'), false);
  releaseChild();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (parentState.backgroundChildRunIds.size === 0) {
      break;
    }
    await delay(10);
  }
});

void test('agent_spawn starts three Ultra worker children and queues the fourth', async () => {
  const threadId = testThreadId(88);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-four-workers',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  let releaseChildren!: () => void;
  const childrenFinished = new Promise<void>((resolve) => {
    releaseChildren = resolve;
  });
  let startedChildren = 0;
  const readStartedChildren = (): number => startedChildren;
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async () => {
        startedChildren += 1;
        await childrenFinished;
        return {
          ok: true,
          finalProse: 'child ok',
        };
      },
    }).startBackgroundRun,
  });

  const results = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      testAgentSpawnTool.execute(
        {
          task: `rewrite file ${index + 1}`,
          subagent_type: 'worker',
        },
        {
          kind: 'agent',
          runOwnerKind: 'root_main',
          callId: `call-four-workers-${index + 1}`,
          providerRunSelection:
            TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
          stateRoot: '/tmp/home-state',

          workingDirectory: 'workspace',
          threadId,
          runId: 'top-run-four-workers',
          runState: parentState,
          signal: new AbortController().signal,
          runSignal: new AbortController().signal,
          currentFile: undefined,
          selection: undefined,
          approvalGranted: false,
          runtimeServices: daemonContext,
          memoryIndex: undefined,
          emitAgentEvent: () => {},
          permissionMode: 'basic',
          ultraReasoning: true,
          computerSessionId: 'parent-four-workers-session',
        },
      ),
    ),
  );
  const getBackgroundChildCount = (): number =>
    parentState.backgroundChildRunIds.size;

  assert.equal(
    results.every((result) => result.ok),
    true,
  );
  const payloads = results.map(
    (result) =>
      JSON.parse(result.output) as {
        ok: boolean;
        childRunId: string;
        launchState: string;
      },
  );
  assert.equal(
    payloads.every((payload) => payload.ok),
    true,
  );
  assert.equal(
    payloads.filter((payload) => payload.launchState === 'started').length,
    3,
  );
  assert.equal(
    payloads.filter((payload) => payload.launchState === 'queued').length,
    1,
  );
  assert.equal(getBackgroundChildCount(), 3);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (readStartedChildren() === 3) {
      break;
    }
    await delay(10);
  }
  assert.equal(readStartedChildren(), 3);

  releaseChildren();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      Number(readStartedChildren()) === 4 &&
      getBackgroundChildCount() === 0
    ) {
      break;
    }
    await delay(10);
  }
  assert.equal(readStartedChildren(), 4);
  assert.equal(getBackgroundChildCount(), 0);
});

void test('agent_spawn Ultra policy queues launch when existing active children exceed capacity', async () => {
  const threadId = testThreadId(8);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-cap',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  for (let index = 0; index < 12; index += 1) {
    parentState.backgroundChildRunIds.add(testRunId(`child-${index}`));
  }
  let launched = false;
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: async () => {
      launched = true;
      return {
        ok: true,
        output: JSON.stringify({
          ok: true,
          childRunId: 'started-child',
          childThreadId: 'started-thread',
          subagentType: 'explorer',
          launchState: 'started',
        }),
      };
    },
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'inspect files',
      subagent_type: 'explorer',
    },
    {
      kind: 'agent',
      runOwnerKind: 'root_main',
      callId: 'call-cap',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      workingDirectory: 'workspace',
      threadId,
      runId: 'top-run-cap',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      currentFile: undefined,
      selection: undefined,
      approvalGranted: false,
      runtimeServices: daemonContext,
      memoryIndex: undefined,
      emitAgentEvent: () => {},
      permissionMode: 'basic',
      ultraReasoning: true,
      computerSessionId: 'default-policy-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    launchState: string;
    childRunId?: string;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.launchState, 'queued');
  assert.equal(typeof payload.childRunId, 'string');
  assert.equal(launched, false);
});

void test('agent_spawn durably queues a launch blocked by daemon-owned capacity', async () => {
  const threadId = testThreadId(18);
  const daemonContext = createDaemonContext({
    subagentConcurrencyPolicy: {
      maxConcurrentChildren: 1,
    },
  });
  const parentState = createRunState({
    runId: 'top-run-policy-cap',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });
  parentState.backgroundChildRunIds.add(testRunId('already-running-child'));

  const result = await agentSpawnTool.execute(
    {
      task: 'inspect files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-policy-cap',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      threadId,
      runId: 'top-run-policy-cap',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      runtimeServices: daemonContext,
      computerSessionId: 'policy-cap-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    launchState: string;
    childRunId?: string;
    childThreadId?: string;
    deferReason?: string;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.launchState, 'queued');
  assert.equal(payload.deferReason, 'configured_capacity');
  assert.equal(typeof payload.childRunId, 'string');
  assert.equal(typeof payload.childThreadId, 'string');
});

void test('agent_spawn reports timeout separately from user_interrupt', async () => {
  const threadId = testThreadId(9);
  const daemonContext = createDaemonContext();
  const parentState = createRunState({
    runId: 'top-run-timeout',
    runContext: makeRunContext({
      threadId,
      stateRoot: '/tmp/home-state',
    }),
  });

  const testAgentSpawnTool = createAgentSpawnTool({
    timeoutMs: 5,
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async ({ signal }) => {
        if (!signal) {
          throw new Error('expected child run signal');
        }
        return new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('child aborted')),
            { once: true },
          );
        });
      },
    }).startBackgroundRun,
  });

  const result = await testAgentSpawnTool.execute(
    {
      task: 'read files',
      subagent_type: 'explorer',
    },
    {
      callId: 'call-timeout',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      threadId,
      runId: 'top-run-timeout',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      runtimeServices: daemonContext,
      computerSessionId: 'timeout-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    childRunId: string;
  };
  const childRunId = assertRunId(payload.childRunId);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = daemonContext.childRuns.getChildRun(childRunId);
    if (snapshot?.status === 'cancelled') {
      assert.equal(snapshot.reason, 'timeout');
      return;
    }
    await delay(10);
  }

  assert.fail('expected child run to settle as timeout');
});
