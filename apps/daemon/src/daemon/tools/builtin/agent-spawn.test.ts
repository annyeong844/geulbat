import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { agentSpawnTool, createAgentSpawnTool } from './agent-spawn.js';
import { createSubagentRunLauncher } from '../../agent/subagent-support.js';
import { createDaemonContext } from '../../context.js';
import { createRunState } from '../../agent/runtime/run-state.js';
import { threadFilePath } from '../../sessions/paths.js';
import { testRunId } from '../../../test-support/run-id.js';
import { makeRunContext } from '../../../test-support/run-context.js';
import { TEST_INHERITED_SOL_MODEL_PIN } from '../../../test-support/subagent-model-routing.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { assertRunId } from '@geulbat/protocol/ids';
import { isToolObjectParameters } from '../types.js';

void test('agent_spawn outward parameters omit compatibility-only mode', () => {
  const parameters = agentSpawnTool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(Object.keys(parameters.properties), [
    'task',
    'subagent_type',
    'model_id',
    'reasoning_effort',
  ]);
  assert.deepEqual(parameters.required, ['task', 'subagent_type']);
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
      agentSpawnRuntime: daemonContext,
      approvalSessionId: 'fixed-routing-session',
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
      agentSpawnRuntime: daemonContext,
      approvalSessionId: 'automatic-routing-session',
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

void test('agent_spawn allows child runs to launch nested helper agents', async () => {
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
    },
    {
      callId: 'call-2',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      threadId: childThreadId,
      runId: 'child-run',
      runState: childRunState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      agentSpawnRuntime: daemonContext,
      approvalSessionId: 'nested-helper-session',
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
    'list_files',
    'read_file',
    'read_tool_output',
    'search_files',
    'exec',
    'wait',
    'agent_spawn',
    'agent_wait',
    'agent_stop',
  ]);
  assert.deepEqual(capturedAllowedRegistryNames, [
    'list_files',
    'read_file',
    'read_tool_output',
    'search_files',
    'exec',
    'wait',
    'agent_spawn',
    'agent_wait',
    'agent_stop',
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

void test('agent_spawn fails closed when the connection approval session is unavailable', async () => {
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
      agentSpawnRuntime: daemonContext,
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
  assert.match(payload.error, /approval session is unavailable/u);
  assert.equal(childLoopCalled, false);
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
      agentSpawnRuntime: daemonContext,
      approvalSessionId: 'background-launch-session',
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
        agentSpawnRuntime: daemonContext,
        approvalSessionId: 'throw-log-session',
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
      agentSpawnRuntime: daemonContext,
      approvalSessionId: 'child-error-event-session',
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
        agentSpawnRuntime: daemonContext,
        approvalSessionId: 'transcript-failure-session',
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
        agentSpawnRuntime: daemonContext,
        approvalSessionId: 'publish-failure-session',
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
        agentSpawnRuntime: daemonContext,
        approvalSessionId: 'registry-publish-failure-session',
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

void test('agent_spawn lets child worker inherit parent permission mode while reusing the parent approval session', async () => {
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
        sessionId: string;
        permissionMode: 'basic' | 'full_access';
        ownerRunId?: string;
        ownerThreadId?: string;
      }
    | undefined;
  let capturedDirectRegistryNames: readonly string[] | undefined;
  let capturedAllowedRegistryNames: readonly string[] | undefined;
  let releaseChild!: () => void;
  const childStarted = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const testAgentSpawnTool = createAgentSpawnTool({
    startBackgroundRun: createSubagentRunLauncher({
      runAgentLoop: async (input) => {
        capturedApprovalContext = input.approvalContext;
        capturedDirectRegistryNames = input.toolSurface?.directRegistryNames;
        capturedAllowedRegistryNames = input.toolSurface?.allowedRegistryNames;
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
      agentSpawnRuntime: daemonContext,
      memoryIndex: undefined,
      emitAgentEvent: () => {},
      permissionMode: 'full_access',
      approvalSessionId: 'parent-approval-session',
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
    sessionId: 'parent-approval-session',
    permissionMode: 'full_access',
    ownerRunId: 'top-run-worker',
    ownerThreadId: threadId,
  });
  const expectedWorkerToolNames = [
    'list_files',
    'read_file',
    'read_tool_output',
    'search_files',
    'write_file',
    'apply_patch',
    'manage_files',
    'agent_spawn',
    'agent_wait',
    'agent_stop',
  ];
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

void test('agent_spawn allows four concurrent worker children under the default policy', async () => {
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
          agentSpawnRuntime: daemonContext,
          memoryIndex: undefined,
          emitAgentEvent: () => {},
          permissionMode: 'basic',
          approvalSessionId: 'parent-four-workers-session',
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
    payloads.every((payload) => payload.launchState === 'started'),
    true,
  );
  assert.equal(getBackgroundChildCount(), 4);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (startedChildren === 4) {
      break;
    }
    await delay(10);
  }
  assert.equal(startedChildren, 4);

  releaseChildren();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getBackgroundChildCount() === 0) {
      break;
    }
    await delay(10);
  }
  assert.equal(getBackgroundChildCount(), 0);
});

void test('agent_spawn default policy admits launch with existing active children', async () => {
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
      callId: 'call-cap',
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      stateRoot: '/tmp/home-state',
      threadId,
      runId: 'top-run-cap',
      runState: parentState,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      agentSpawnRuntime: daemonContext,
      approvalSessionId: 'default-policy-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    launchState: string;
    childRunId?: string;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.launchState, 'started');
  assert.equal(typeof payload.childRunId, 'string');
  assert.equal(launched, true);
});

void test('agent_spawn applies daemon-owned subagent concurrency policy', async () => {
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
      agentSpawnRuntime: daemonContext,
      approvalSessionId: 'policy-cap-session',
    },
  );

  assert.equal(result.ok, true);
  const payload = JSON.parse(result.output) as {
    ok: boolean;
    launchState: string;
    errorCode: string;
    effectiveMax: number;
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.launchState, 'rejected');
  assert.equal(payload.errorCode, 'too_many_child_runs');
  assert.equal(payload.effectiveMax, 1);
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
      agentSpawnRuntime: daemonContext,
      approvalSessionId: 'timeout-session',
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
