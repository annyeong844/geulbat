import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  rehydrateToolLibraryProjectionFromObserverSnapshot,
  type AgentLoopObserverDiagnostic,
  type AgentLoopObserverEvent,
  type AgentLoopObserverSnapshot,
} from './observer/agent-loop-observer.js';
import { runAgentLoop } from './run-agent-loop.js';
import { createDaemonContext } from '../context.js';
import type { FunctionCall, ProviderStructuredOutput } from '../llm/index.js';
import { createBuiltinToolRegistryStore } from '../tools/builtin/catalog.js';
import { buildToolLibraryProjection } from '../tools/tool-library-projection.js';
import { resolveToolLibraryProjectionMountedModule } from '../tools/tool-library-projection-mount.js';
import { readVerifiedToolLibraryProjectionMount } from '../tools/tool-library-projection-store.js';
import type { ToolDefinition } from '../tools/types.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import {
  createScriptedProviderCallModel,
  providerFinalAnswerRound,
} from '../../test-support/provider-response-fixtures.js';
import { testRunId } from '../../test-support/run-id.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testThreadId } from '../../test-support/thread-id.js';

void test('runAgentLoop records a daemon-neutral observer snapshot and round trace', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-observer-'),
  );
  const runId = testRunId('agent-loop-observer');
  const threadId = testThreadId(1);
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const snapshots: AgentLoopObserverSnapshot[] = [];
  const observerEvents: AgentLoopObserverEvent[] = [];
  const projectionRoot = join(workspaceRoot, '.geulbat', 'generated-tools');
  const projection = buildToolLibraryProjection({
    registry: createBuiltinToolRegistryStore(),
    allowedRegistryNames: [],
    sdkVersion: 'observer-sdk-v1',
    sourceRegistryVersion: 'observer-registry-v1',
    policyId: 'observer-policy-v1',
    runtimeCompatibilityRange: 'observer-runtime-v1',
    rootPath: projectionRoot,
    catalogPath: join(projectionRoot, 'catalog.js'),
    modelFacingCatalogRef: 'geulbat-sdk://catalog',
    importSpecifier: '@geulbat/generated-tools',
  });

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'do not expose this prompt body',
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: createDaemonContext(),
    toolLibraryProjectionPort: {
      async resolveProjection(resolveArgs) {
        assert.equal(resolveArgs.stateRoot, workspaceRoot);
        assert.equal(resolveArgs.threadId, threadId);
        assert.deepEqual(resolveArgs.allowedRegistryNames, []);
        return {
          ok: true,
          identity: {
            sdkVersion: projection.sdkVersion,
            sdkProjectionHash: projection.sdkProjectionHash,
            policyId: projection.policyId,
          },
        };
      },
    },
    approvalContext: makeApprovalContext({
      sessionId: 'agent-loop-observer-session',
    }),
    callModelImpl: createScriptedProviderCallModel([
      providerFinalAnswerRound('done'),
    ]),
    observer: {
      recordSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
      recordEvent(event) {
        observerEvents.push(event);
      },
    },
    onEvent() {},
  });

  assert.equal(result.ok, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.runId, runId);
  assert.equal(snapshots[0]?.threadId, threadId);
  assert.equal(snapshots[0]?.input.promptPort, 'default_prompt_port');
  assert.equal(snapshots[0]?.promptPorts.prompt, 'AgentLoopPromptPort');
  assert.equal(snapshots[0]?.input.historyPort, 'default_history_port');
  assert.equal(snapshots[0]?.input.lifecyclePort, 'default_lifecycle_port');
  assert.equal(snapshots[0]?.input.memoryPort, 'default_memory_port');
  assert.equal(snapshots[0]?.input.modelRoundPort, 'default_model_round_port');
  assert.equal(
    snapshots[0]?.input.structuredOutputPort,
    'default_structured_output_port',
  );
  assert.equal(
    snapshots[0]?.input.toolDefinitionPort,
    'default_tool_definition_port',
  );
  assert.equal(
    snapshots[0]?.input.toolRuntimePort,
    'default_tool_runtime_port',
  );
  assert.equal(snapshots[0]?.input.toolLibraryProjectionPort, 'injected');
  assert.equal(snapshots[0]?.loopPorts.prompt, 'AgentLoopPromptPort');
  assert.equal(snapshots[0]?.loopPorts.history, 'AgentLoopHistoryPort');
  assert.equal(snapshots[0]?.loopPorts.lifecycle, 'AgentLoopLifecyclePort');
  assert.equal(snapshots[0]?.loopPorts.memory, 'AgentLoopMemoryPort');
  assert.equal(snapshots[0]?.loopPorts.modelRound, 'ModelRoundPort');
  assert.equal(
    snapshots[0]?.loopPorts.structuredOutputs,
    'AgentLoopStructuredOutputPort',
  );
  assert.equal(
    snapshots[0]?.loopPorts.toolDefinitions,
    'AgentLoopToolDefinitionPort',
  );
  assert.equal(snapshots[0]?.loopPorts.toolRuntime, 'AgentLoopToolRuntimePort');
  assert.equal(
    snapshots[0]?.loopPorts.toolLibraryProjection,
    'AgentLoopToolLibraryProjectionPort',
  );
  assert.deepEqual(snapshots[0]?.toolSurface, {
    admission: {
      kind: 'restricted',
      directRegistryNames: [],
      allowedRegistryNames: [],
    },
    definitions: { count: 0, names: [] },
    toolLibraryProjection: {
      sdkVersion: projection.sdkVersion,
      sdkProjectionHash: projection.sdkProjectionHash,
      policyId: projection.policyId,
    },
  });
  assert.deepEqual(
    observerEvents.map((event) => event.kind),
    ['round_started', 'round_completed'],
  );
  assert.deepEqual(observerEvents[1], {
    schemaVersion: 1,
    kind: 'round_completed',
    runId,
    threadId,
    round: 0,
    outcome: 'terminal',
    terminalOk: true,
  });

  const serializedTrace = JSON.stringify({ snapshots, observerEvents });
  assert.equal(
    serializedTrace.includes('do not expose this prompt body'),
    false,
  );
  assert.equal(serializedTrace.includes(workspaceRoot), false);
  assert.equal(serializedTrace.includes(projectionRoot), false);
  assert.equal(serializedTrace.includes('observer-registry-v1'), false);
  assert.equal(serializedTrace.includes('generated-tools'), false);
});

void test('runAgentLoop can build model prompts through an injected prompt port', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-prompt-port-'),
  );
  const runId = testRunId('agent-loop-prompt-port');
  const threadId = testThreadId(8);
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const snapshots: AgentLoopObserverSnapshot[] = [];
  const calls: Array<{
    threadId: string;
    currentFile?: string;
  }> = [];
  const modelRoundPrompts: Array<{ systemPrompt: string }> = [];

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'prompt port user text',
    currentFile: 'src/prompt-port.ts',
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext({
      sessionId: 'agent-loop-prompt-port-session',
    }),
    promptPort: {
      buildPromptBundle(args) {
        calls.push({
          threadId: args.threadId,
          ...(args.currentFile === undefined
            ? {}
            : { currentFile: args.currentFile }),
        });
        return {
          systemPrompt: 'injected system prompt',
          promptContext: 'injected prompt context',
        };
      },
    },
    modelRoundPort: {
      async runModelRound(args) {
        modelRoundPrompts.push({
          systemPrompt: args.systemPrompt,
        });
        return {
          ok: true,
          value: {
            assistantText: 'prompt port answer',
            terminalResult: {
              ok: true,
              finalProse: 'prompt port answer',
            },
            functionCalls: [],
          },
        };
      },
    },
    observer: {
      recordSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
      recordEvent() {},
    },
    onEvent() {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      threadId,
      currentFile: 'src/prompt-port.ts',
    },
  ]);
  assert.deepEqual(modelRoundPrompts, [
    {
      systemPrompt: 'injected system prompt',
    },
  ]);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.input.promptPort, 'injected');
  assert.equal(snapshots[0]?.promptPorts.prompt, 'AgentLoopPromptPort');
  assert.equal(snapshots[0]?.loopPorts.prompt, 'AgentLoopPromptPort');
  const serializedTrace = JSON.stringify(snapshots);
  assert.equal(serializedTrace.includes('injected system prompt'), false);
  assert.equal(serializedTrace.includes('injected prompt context'), false);
  assert.equal(serializedTrace.includes('prompt port user text'), false);
});

void test('runAgentLoop can load initial history through an injected history port', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-history-port-'),
  );
  const runId = testRunId('agent-loop-history-port');
  const threadId = testThreadId(6);
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const snapshots: AgentLoopObserverSnapshot[] = [];
  const calls: Array<{
    workspaceRoot: string;
    threadId: string;
    prompt: string;
  }> = [];

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'history port prompt',
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext({
      sessionId: 'agent-loop-history-port-session',
    }),
    historyPort: {
      async loadInitialHistory(args) {
        calls.push(args);
        return [{ kind: 'user', text: args.prompt }];
      },
    },
    callModelImpl: createScriptedProviderCallModel([
      providerFinalAnswerRound('done'),
    ]),
    observer: {
      recordSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
      recordEvent() {},
    },
    onEvent() {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    { workspaceRoot, threadId, prompt: 'history port prompt' },
  ]);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.input.historyPort, 'injected');
  assert.equal(snapshots[0]?.history.initialItemCount, 1);
  assert.equal(snapshots[0]?.loopPorts.history, 'AgentLoopHistoryPort');
});

void test('runAgentLoop can execute model rounds through an injected model-round port', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-model-port-'),
  );
  const runId = testRunId('agent-loop-model-port');
  const threadId = testThreadId(7);
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const snapshots: AgentLoopObserverSnapshot[] = [];
  const calls: Array<{
    round: number;
    historyItemCount: number;
    toolDefinitionCount: number;
  }> = [];

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'model port prompt',
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext({
      sessionId: 'agent-loop-model-port-session',
    }),
    memoryPort: {
      async compactAfterModelRound() {
        return { kind: 'not_needed', reason: 'under_threshold' };
      },
    },
    modelRoundPort: {
      async runModelRound(args) {
        calls.push({
          round: args.round,
          historyItemCount: args.history.length,
          toolDefinitionCount: args.toolDefs.length,
        });
        return {
          ok: true,
          value: {
            assistantText: 'model port answer',
            terminalResult: {
              ok: true,
              finalProse: 'model port answer',
            },
            functionCalls: [],
          },
        };
      },
    },
    observer: {
      recordSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
      recordEvent() {},
    },
    onEvent() {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'model port answer',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.round, 0);
  assert.equal(calls[0]?.historyItemCount, 1);
  assert.ok((calls[0]?.toolDefinitionCount ?? 0) > 0);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.input.memoryPort, 'injected');
  assert.equal(snapshots[0]?.loopPorts.memory, 'AgentLoopMemoryPort');
  assert.equal(snapshots[0]?.input.modelRoundPort, 'injected');
  assert.equal(snapshots[0]?.loopPorts.modelRound, 'ModelRoundPort');
});

void test('runAgentLoop settles through an injected lifecycle port', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-lifecycle-port-'),
  );
  const runId = testRunId('agent-loop-lifecycle-port');
  const threadId = testThreadId(71);
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const snapshots: AgentLoopObserverSnapshot[] = [];
  const settledResults: Array<{ ok: boolean; finalProse: string }> = [];

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'lifecycle port prompt',
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext({
      sessionId: 'agent-loop-lifecycle-port-session',
    }),
    lifecyclePort: {
      settleAfterResult(args) {
        settledResults.push(args.result);
      },
      createTerminalFailure() {
        throw new Error('unexpected terminal failure');
      },
    },
    callModelImpl: createScriptedProviderCallModel([
      providerFinalAnswerRound('lifecycle port answer'),
    ]),
    observer: {
      recordSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
      recordEvent() {},
    },
    onEvent() {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'lifecycle port answer',
  });
  assert.deepEqual(settledResults, [result]);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.input.lifecyclePort, 'injected');
  assert.equal(snapshots[0]?.loopPorts.lifecycle, 'AgentLoopLifecyclePort');
});

void test('runAgentLoop can build model tool definitions through an injected tool-definition port', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-tool-definition-port-'),
  );
  const runId = testRunId('agent-loop-tool-definition-port');
  const threadId = testThreadId(8);
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const snapshots: AgentLoopObserverSnapshot[] = [];
  const calls: Array<{
    directRegistryNames: readonly string[] | undefined;
  }> = [];
  const projectedDefinition: ToolDefinition = {
    type: 'function',
    name: 'projected_tool',
    description: 'Projected tool definition from a host port.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  };
  const modelToolNames: string[][] = [];

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'tool definition port prompt',
    toolSurface: {
      directRegistryNames: ['fetch_url'],
      allowedRegistryNames: ['fetch_url'],
    },
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext({
      sessionId: 'agent-loop-tool-definition-port-session',
    }),
    toolDefinitionPort: {
      buildToolDefinitions(args) {
        calls.push({ directRegistryNames: args.directRegistryNames });
        return [projectedDefinition];
      },
    },
    modelRoundPort: {
      async runModelRound(args) {
        modelToolNames.push(args.toolDefs.map((toolDef) => toolDef.name));
        return {
          ok: true,
          value: {
            assistantText: 'tool definition port answer',
            terminalResult: {
              ok: true,
              finalProse: 'tool definition port answer',
            },
            functionCalls: [],
          },
        };
      },
    },
    observer: {
      recordSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
      recordEvent() {},
    },
    onEvent() {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'tool definition port answer',
  });
  assert.deepEqual(calls, [{ directRegistryNames: ['fetch_url'] }]);
  assert.deepEqual(modelToolNames, [['projected_tool']]);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.input.toolDefinitionPort, 'injected');
  assert.deepEqual(snapshots[0]?.toolSurface.definitions, {
    count: 1,
    names: ['projected_tool'],
  });
});

void test('runAgentLoop can process function calls through an injected tool-runtime port', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-tool-runtime-port-'),
  );
  const runId = testRunId('agent-loop-tool-runtime-port');
  const threadId = testThreadId(9);
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const snapshots: AgentLoopObserverSnapshot[] = [];
  const projectedDefinition: ToolDefinition = {
    type: 'function',
    name: 'projected_tool',
    description: 'Projected tool definition from a host runtime port.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
  };
  const projectedCall: FunctionCall = {
    id: 'fc_projected_tool',
    callId: 'call_projected_tool',
    name: 'projected_tool',
    arguments: '{}',
  };
  const toolRuntimeCalls: Array<{
    round: number;
    names: string[];
    runId: string;
    threadId: string;
  }> = [];
  let modelRoundCount = 0;

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'tool runtime port prompt',
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext({
      sessionId: 'agent-loop-tool-runtime-port-session',
    }),
    toolDefinitionPort: {
      buildToolDefinitions() {
        return [projectedDefinition];
      },
    },
    toolRuntimePort: {
      async processFunctionCalls(args) {
        toolRuntimeCalls.push({
          round: args.round,
          names: args.functionCalls.map((call) => call.name),
          runId: args.runId,
          threadId: args.runContext.threadId,
        });
        return { ok: true, value: undefined };
      },
    },
    modelRoundPort: {
      async runModelRound() {
        modelRoundCount += 1;
        if (modelRoundCount === 1) {
          return {
            ok: true,
            value: {
              assistantText: 'calling projected tool',
              terminalResult: {
                ok: true,
                finalProse: 'unused first round result',
              },
              functionCalls: [projectedCall],
            },
          };
        }
        return {
          ok: true,
          value: {
            assistantText: 'tool runtime port answer',
            terminalResult: {
              ok: true,
              finalProse: 'tool runtime port answer',
            },
            functionCalls: [],
          },
        };
      },
    },
    observer: {
      recordSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
      recordEvent() {},
    },
    onEvent() {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'tool runtime port answer',
  });
  assert.equal(modelRoundCount, 2);
  assert.deepEqual(toolRuntimeCalls, [
    {
      round: 0,
      names: ['projected_tool'],
      runId,
      threadId,
    },
  ]);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.input.toolRuntimePort, 'injected');
  assert.equal(snapshots[0]?.loopPorts.toolRuntime, 'AgentLoopToolRuntimePort');
});

void test('runAgentLoop can process structured outputs through an injected structured-output port', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-structured-output-port-'),
  );
  const runId = testRunId('agent-loop-structured-output-port');
  const threadId = testThreadId(10);
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const snapshots: AgentLoopObserverSnapshot[] = [];
  const structuredOutput: ProviderStructuredOutput = {
    schemaVersion: 1,
    kind: 'test_structured_output',
    payload: { value: 'from model' },
  };
  const structuredOutputCalls: Array<{
    kinds: string[];
    runId: string;
    threadId: string;
  }> = [];

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'structured output port prompt',
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext({
      sessionId: 'agent-loop-structured-output-port-session',
    }),
    structuredOutputPort: {
      async processStructuredOutputs(args) {
        structuredOutputCalls.push({
          kinds: args.structuredOutputs.map((output) => output.kind),
          runId,
          threadId: args.runContext.threadId,
        });
        if (args.structuredOutputs.length === 0) {
          return { ok: true, handled: false };
        }
        return {
          ok: true,
          handled: true,
          result: {
            ok: true,
            finalProse: 'structured output port answer',
          },
        };
      },
    },
    modelRoundPort: {
      async runModelRound() {
        return {
          ok: true,
          value: {
            assistantText: 'unused structured assistant text',
            terminalResult: {
              ok: true,
              finalProse: 'unused structured terminal result',
            },
            functionCalls: [],
            structuredOutputs: [structuredOutput],
          },
        };
      },
    },
    observer: {
      recordSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
      recordEvent() {},
    },
    onEvent() {},
  });

  assert.deepEqual(result, {
    ok: true,
    finalProse: 'structured output port answer',
  });
  assert.deepEqual(structuredOutputCalls, [
    {
      kinds: ['test_structured_output'],
      runId,
      threadId,
    },
  ]);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.input.structuredOutputPort, 'injected');
  assert.equal(
    snapshots[0]?.loopPorts.structuredOutputs,
    'AgentLoopStructuredOutputPort',
  );
});

void test('runAgentLoop materializes an importable default tool library projection for the run', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-tool-library-'),
  );
  try {
    const runId = testRunId('agent-loop-tool-library');
    const threadId = testThreadId(4);
    const runContext = makeRunContext({
      threadId,
      stateRoot: workspaceRoot,
    });
    const snapshots: AgentLoopObserverSnapshot[] = [];
    const runtimeServices = createDaemonContext();

    const result = await runAgentLoop({
      runId,
      runContext,
      prompt: 'materialize generated tools',
      toolSurface: {
        directRegistryNames: ['read_file'],
        allowedRegistryNames: ['read_file'],
      },
      runtimeServices,
      approvalContext: makeApprovalContext({
        sessionId: 'agent-loop-tool-library-session',
      }),
      callModelImpl: createScriptedProviderCallModel([
        providerFinalAnswerRound('done'),
      ]),
      observer: {
        recordSnapshot(snapshot) {
          snapshots.push(snapshot);
        },
        recordEvent() {},
      },
      onEvent() {},
    });

    assert.equal(result.ok, true);
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0]?.toolSurface.admission, {
      kind: 'restricted',
      directRegistryNames: ['read_file'],
      allowedRegistryNames: ['read_file'],
    });
    assert.equal(
      snapshots[0]?.input.toolLibraryProjectionPort,
      'default_tool_library_projection_port',
    );
    assert.equal(
      snapshots[0]?.loopPorts.toolLibraryProjection,
      'AgentLoopToolLibraryProjectionPort',
    );

    const projectionPortRoot = join(
      workspaceRoot,
      '.geulbat',
      'tool-library',
      'projections',
    );
    const threadEntries = await readdir(projectionPortRoot, {
      withFileTypes: true,
    });
    const threadDirectoryNames = threadEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.equal(threadDirectoryNames.length, 1);

    const threadDirectoryName =
      threadDirectoryNames[0] ?? assert.fail('expected one projection thread');
    const threadProjectionRootPath = join(
      projectionPortRoot,
      threadDirectoryName,
    );
    const observedIdentity = snapshots[0]?.toolSurface.toolLibraryProjection;
    assert.notEqual(observedIdentity, undefined);
    if (observedIdentity === undefined) {
      assert.fail('expected observer snapshot to include projection identity');
    }

    const mountResult = await readVerifiedToolLibraryProjectionMount({
      threadProjectionRootPath,
      expectedIdentity: observedIdentity,
      importSpecifier: 'geulbat-sdk',
    });
    assert.equal(mountResult.ok, true);
    if (!mountResult.ok) {
      assert.fail('expected run-created projection mount to verify');
    }
    assert.equal(
      snapshots[0]?.toolSurface.toolLibraryProjection?.sdkProjectionHash,
      mountResult.mount.sdkProjectionHash,
    );
    if (observedIdentity === undefined) {
      assert.fail('expected observer projection identity');
    }
    const observedSnapshot =
      snapshots[0] ?? assert.fail('expected observer snapshot');
    const rehydratedMount =
      await rehydrateToolLibraryProjectionFromObserverSnapshot({
        snapshot: observedSnapshot,
        stateRoot: workspaceRoot,
        projectionPort: runtimeServices.toolLibraryProjection,
      });
    assert.equal(rehydratedMount.ok, true);
    if (!rehydratedMount.ok) {
      assert.fail(
        'expected observer identity to rehydrate through projection port',
      );
    }
    assert.equal(
      rehydratedMount.mount.sdkProjectionHash,
      mountResult.mount.sdkProjectionHash,
    );

    const sdkModule = asRecord(
      await import(pathToFileURL(mountResult.mount.indexModulePath).href),
    );
    assert.notEqual(sdkModule, null);
    if (sdkModule === null) {
      assert.fail('expected generated SDK module object');
    }

    const searchTools = sdkModule['searchTools'];
    assert.equal(typeof searchTools, 'function');
    const searchResults = (
      searchTools as (
        query: string,
      ) => readonly Readonly<Record<string, unknown>>[]
    )('read file');
    assert.equal(searchResults[0]?.['publicName'], 'read_file');

    const readFile = sdkModule['readFile'];
    assert.equal(typeof readFile, 'function');
    const calls: Array<{ name: string; args: unknown }> = [];
    const readFileModule = resolveToolLibraryProjectionMountedModule({
      mount: mountResult.mount,
      specifier: 'geulbat-sdk/files/readFile',
    });
    assert.equal(readFileModule.ok, true);
    if (!readFileModule.ok) {
      assert.fail('expected generated read_file wrapper module');
    }
    const readFileNamespace = asRecord(
      await import(pathToFileURL(readFileModule.module.filePath).href),
    );
    const bindRuntime = readFileNamespace?.['bindGeulbatRuntime'];
    assert.equal(typeof bindRuntime, 'function');
    (
      bindRuntime as (geulbat: {
        callTool(name: string, args: unknown): Promise<unknown>;
      }) => void
    )({
      async callTool(name, args) {
        calls.push({ name, args });
        return 'contents';
      },
    });
    await (readFile as (args: unknown) => Promise<unknown>)({
      path: 'README.md',
    });
    assert.deepEqual(calls, [
      { name: 'read_file', args: { path: 'README.md' } },
    ]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('observer snapshot projection rehydration fails closed without projection identity', async () => {
  const projectionPort = createDaemonContext().toolLibraryProjection;
  const result = await rehydrateToolLibraryProjectionFromObserverSnapshot({
    snapshot: {
      threadId: testThreadId(5),
      toolSurface: {
        admission: { kind: 'registry_default' },
        definitions: { count: 0, names: [] },
      },
    },
    stateRoot: '/tmp/geulbat-observer-no-projection',
    projectionPort,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'projection_identity_missing',
    message:
      'Agent loop observer snapshot has no tool library projection identity',
  });
});

void test('runAgentLoop isolates throwing observer callbacks from run behavior', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-observer-failure-'),
  );
  const runId = testRunId('agent-loop-observer-failure');
  const threadId = testThreadId(2);
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const diagnostics: AgentLoopObserverDiagnostic[] = [];

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'do not expose this prompt body',
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: createDaemonContext(),
    approvalContext: makeApprovalContext({
      sessionId: 'agent-loop-observer-failure-session',
    }),
    callModelImpl: createScriptedProviderCallModel([
      providerFinalAnswerRound('done'),
    ]),
    observer: {
      recordSnapshot() {
        throw new Error(`private observer failure: ${workspaceRoot}`);
      },
      recordEvent() {
        throw new Error('private observer event failure');
      },
      recordDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    },
    onEvent() {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.operation),
    ['record_snapshot', 'record_event', 'record_event'],
  );
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.eventKind),
    [undefined, 'round_started', 'round_completed'],
  );
  const serializedDiagnostics = JSON.stringify(diagnostics);
  assert.equal(serializedDiagnostics.includes(workspaceRoot), false);
  assert.equal(serializedDiagnostics.includes('private observer'), false);
});

void test('runAgentLoop stops before model calls when tool library projection fails', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-agent-loop-observer-projection-failure-'),
  );
  const runId = testRunId('agent-loop-observer-projection-failure');
  const threadId = testThreadId(3);
  const runContext = makeRunContext({
    threadId,
    stateRoot: workspaceRoot,
  });
  const events: Array<{ type: string; payload: unknown }> = [];
  let modelCallCount = 0;

  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'do not call the model',
    toolSurface: {
      directRegistryNames: ['read_file'],
      allowedRegistryNames: ['read_file'],
    },
    runtimeServices: createDaemonContext(),
    toolLibraryProjectionPort: {
      async resolveProjection(resolveArgs) {
        assert.equal(resolveArgs.stateRoot, workspaceRoot);
        assert.equal(resolveArgs.threadId, threadId);
        assert.deepEqual(resolveArgs.allowedRegistryNames, ['read_file']);
        return {
          ok: false,
          message: 'Tool library projection failed',
          diagnostics: { errorCode: 'EACCES', errorName: 'Error' },
        };
      },
    },
    approvalContext: makeApprovalContext({
      sessionId: 'agent-loop-observer-projection-failure-session',
    }),
    async *callModelImpl() {
      modelCallCount += 1;
      throw new Error('model should not be called');
    },
    onEvent(event) {
      events.push(event);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.finalProse, '');
  assert.equal(modelCallCount, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    ['run_ack', 'error'],
  );
  assert.deepEqual(events[1], {
    type: 'error',
    payload: {
      code: 'execution_failed',
      message: 'Tool library projection failed (Error EACCES)',
    },
  });
});

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
