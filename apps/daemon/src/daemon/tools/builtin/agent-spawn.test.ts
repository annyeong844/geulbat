import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { agentLoopKernelImplementation } from '@geulbat/agent-loop/kernel';
import { assertRunId } from '@geulbat/protocol/ids';

import { createAgentLoopImplementationAdmission } from '../../agent/loop-implementation-admission.js';
import { createRunState } from '../../agent/runtime/run-state.js';
import { createSubagentRunLauncher } from '../../agent/subagent-support.js';
import { createAgentSpawnDaemonContext as createDaemonContext } from '../../../test-support/agent-spawn.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { testRunId } from '../../../test-support/run-id.js';
import { TEST_INHERITED_SOL_MODEL_PIN } from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { agentSpawnTool, createAgentSpawnTool } from './agent-spawn.js';
import { isToolObjectParameters } from '../types.js';

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
