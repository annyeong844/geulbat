import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';

import { createDaemonContext } from '../context.js';
import { createRunCheckpointStore } from '../sessions/run-checkpoint-store.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testRunId } from '../../test-support/run-id.js';
import { testThreadId } from '../../test-support/thread-id.js';
import type { AgentEvent } from './events.js';
import type { AgentInput } from './loop-types.js';
import { createRunState } from './runtime/run-state.js';
import { runAgentLoop } from './run-agent-loop.js';

const TOOL_PROJECTION_IDENTITY = {
  sdkVersion: 'sdk-active-boundary-v1',
  sdkProjectionHash: `sha256:${'a'.repeat(64)}`,
  policyId: 'active-boundary-policy-v1',
} as const;
const PROVIDER_REQUEST_IDENTITY = 'b'.repeat(64);

function modelSettlementIdentity(
  runId: string,
  round: number,
): `sha256:${string}` {
  return `sha256:${sha256StableJson({
    schema: 'geulbat-model-settlement-v1',
    runId,
    round,
  })}`;
}

void test('runAgentLoop reclaims the same terminal-observed model boundary before history settlement', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-active-model-boundary-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = testRunId('active-model-boundary');
  const threadId = testThreadId(901);
  const firstStore = createRunCheckpointStore({ stateRoot });
  await firstStore.startRun({
    runId,
    threadId,
    request: { permissionMode: 'basic' },
  });

  const firstResult = await runAgentLoop({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
    prompt: 'continue the exact active model boundary',
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: {
      ...createDaemonContext(),
      runCheckpoints: firstStore,
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'active-boundary-first',
    }),
    toolLibraryProjectionPort: fixedToolProjection(),
    callModelImpl: createTerminalReplayCall(false),
    onEvent: () => undefined,
  });
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.finalProse, 'durable terminal');
  assert.equal(
    firstResult.modelSettlementIdentity,
    modelSettlementIdentity(runId, 0),
  );

  const interrupted = await firstStore.readThread(threadId);
  const firstActive = interrupted?.modelRoundState?.active;
  assert.equal(firstActive?.phase, 'terminal_observed');
  assert.equal(firstActive?.round, 0);
  assert.equal(firstActive?.providerRequestIdentity, PROVIDER_REQUEST_IDENTITY);
  const checkpointBytes = await readFile(
    join(stateRoot, '.geulbat', 'run-checkpoints', `${threadId}.json`),
    'utf8',
  );
  assert.equal(
    checkpointBytes.includes('continue the exact active model boundary'),
    false,
  );

  const replacementStore = createRunCheckpointStore({ stateRoot });
  const replacementClaimId = 'replacement-active-boundary-claim';
  const claimed = await replacementStore.claimActiveModelRound?.({
    threadId,
    runId,
    claimId: replacementClaimId,
  });
  assert.equal(claimed?.ok, true);
  if (
    claimed === undefined ||
    !claimed.ok ||
    claimed.checkpoint.modelRoundState === null
  ) {
    throw new Error('replacement model round claim was unavailable');
  }

  const replacementResult = await runAgentLoop({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
    prompt: 'continue the exact active model boundary',
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: {
      ...createDaemonContext(),
      runCheckpoints: replacementStore,
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'active-boundary-replacement',
    }),
    toolLibraryProjectionPort: fixedToolProjection(),
    modelRoundRecovery: {
      claimId: replacementClaimId,
      state: claimed.checkpoint.modelRoundState,
    },
    callModelImpl: createTerminalReplayCall(true),
    onEvent: () => undefined,
  });
  assert.deepEqual(replacementResult, firstResult);

  const recovered = await replacementStore.readThread(threadId);
  assert.deepEqual(recovered?.modelRoundState?.active, {
    ...firstActive,
    claimId: replacementClaimId,
    claimRevision: 2,
  });
});

void test('runAgentLoop refuses to repeat a structured effect that crossed an uncertain restart', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-model-settlement-effect-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = testRunId('model-settlement-effect');
  const threadId = testThreadId(903);
  const firstStore = createRunCheckpointStore({ stateRoot });
  const runContext = makeRunContext({ threadId, stateRoot });
  await firstStore.startRun({
    runId,
    threadId,
    request: { permissionMode: 'basic' },
  });
  let structuredEffectCount = 0;
  const firstRunState = createRunState({ runId, runContext });
  const structuredOutputPort = {
    async processStructuredOutputs() {
      structuredEffectCount += 1;
      throw new Error('simulated daemon death after effect start');
    },
  };

  await assert.rejects(
    runAgentLoop({
      runId,
      runContext,
      prompt: 'apply one structured effect',
      toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
      runtimeServices: {
        ...createDaemonContext(),
        runCheckpoints: firstStore,
      },
      approvalContext: makeApprovalContext({
        computerSessionId: 'model-settlement-effect-first',
      }),
      toolLibraryProjectionPort: fixedToolProjection(),
      memoryPort: noCompactionMemoryPort(),
      modelRoundPort: structuredEffectModelRoundPort(),
      structuredOutputPort,
      runState: firstRunState,
      onEvent: () => undefined,
    }),
    /simulated daemon death after effect start/u,
  );
  const interrupted = await firstStore.readThread(threadId);
  assert.equal(
    interrupted?.modelRoundState?.active?.settlement?.phase,
    'effects_started',
  );
  assert.deepEqual(firstRunState.usageTotals, {
    inputTokens: 13,
    outputTokens: 3,
    cachedInputTokens: 2,
  });

  const replacementStore = createRunCheckpointStore({ stateRoot });
  const replacementClaimId = 'model-settlement-effect-replacement';
  const claimed = await replacementStore.claimActiveModelRound?.({
    threadId,
    runId,
    claimId: replacementClaimId,
  });
  if (
    claimed === undefined ||
    !claimed.ok ||
    claimed.checkpoint.modelRoundState === null
  ) {
    throw new Error('replacement model settlement claim was unavailable');
  }
  const events: AgentEvent[] = [];
  const replacementRunState = createRunState({ runId, runContext });
  const result = await runAgentLoop({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
    prompt: 'apply one structured effect',
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: {
      ...createDaemonContext(),
      runCheckpoints: replacementStore,
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'model-settlement-effect-replacement',
    }),
    toolLibraryProjectionPort: fixedToolProjection(),
    memoryPort: noCompactionMemoryPort(),
    modelRoundRecovery: {
      claimId: replacementClaimId,
      state: claimed.checkpoint.modelRoundState,
    },
    modelRoundPort: structuredEffectModelRoundPort(),
    structuredOutputPort,
    runState: replacementRunState,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.modelSettlementIdentity,
    modelSettlementIdentity(runId, 0),
  );
  assert.equal(structuredEffectCount, 1);
  assert.deepEqual(replacementRunState.usageTotals, {
    inputTokens: 13,
    outputTokens: 3,
    cachedInputTokens: 2,
  });
  assert.equal(
    events.filter((event) => event.type === 'usage_updated').length,
    0,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === 'error' &&
        event.payload.code === 'llm_provider_request_outcome_unknown',
    ),
    true,
  );
});

void test('runAgentLoop does not reopen a committed tool window after restart', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-model-settlement-tool-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = testRunId('model-settlement-tool');
  const threadId = testThreadId(904);
  const firstStore = createRunCheckpointStore({ stateRoot });
  const runContext = makeRunContext({ threadId, stateRoot });
  const firstRunState = createRunState({ runId, runContext });
  await firstStore.startRun({
    runId,
    threadId,
    request: { permissionMode: 'basic' },
  });
  let toolEffectCount = 0;
  const toolRuntimePort: NonNullable<AgentInput['toolRuntimePort']> = {
    async processFunctionCalls() {
      toolEffectCount += 1;
      return { ok: true, value: undefined };
    },
  };
  const interruptedCheckpoints = {
    ...firstStore,
    async completeModelRound() {
      throw new Error('simulated daemon death before round clear');
    },
  };

  await assert.rejects(
    runAgentLoop({
      runId,
      runContext,
      prompt: 'run one durable tool window',
      toolSurface: {
        directRegistryNames: ['read_file'],
        allowedRegistryNames: ['read_file'],
      },
      runtimeServices: {
        ...createDaemonContext(),
        runCheckpoints: interruptedCheckpoints,
      },
      approvalContext: makeApprovalContext({
        computerSessionId: 'model-settlement-tool-first',
      }),
      toolLibraryProjectionPort: fixedToolProjection(),
      memoryPort: noCompactionMemoryPort(),
      modelRoundPort: toolSettlementModelRoundPort(),
      toolRuntimePort,
      runState: firstRunState,
      onEvent: () => undefined,
    }),
    /simulated daemon death before round clear/u,
  );
  const interrupted = await firstStore.readThread(threadId);
  assert.equal(
    interrupted?.modelRoundState?.active?.settlement?.phase,
    'committed',
  );
  assert.equal(
    interrupted?.modelRoundState?.active?.settlement?.disposition,
    'continue',
  );
  assert.deepEqual(firstRunState.usageTotals, {
    inputTokens: 17,
    outputTokens: 4,
    cachedInputTokens: 9,
  });

  const replacementStore = createRunCheckpointStore({ stateRoot });
  const replacementClaimId = 'model-settlement-tool-replacement';
  const claimed = await replacementStore.claimActiveModelRound?.({
    threadId,
    runId,
    claimId: replacementClaimId,
  });
  if (
    claimed === undefined ||
    !claimed.ok ||
    claimed.checkpoint.modelRoundState === null
  ) {
    throw new Error('replacement tool settlement claim was unavailable');
  }
  const replacementRunState = createRunState({ runId, runContext });
  const result = await runAgentLoop({
    runId,
    runContext,
    prompt: 'run one durable tool window',
    toolSurface: {
      directRegistryNames: ['read_file'],
      allowedRegistryNames: ['read_file'],
    },
    runtimeServices: {
      ...createDaemonContext(),
      runCheckpoints: replacementStore,
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'model-settlement-tool-replacement',
    }),
    toolLibraryProjectionPort: fixedToolProjection(),
    memoryPort: noCompactionMemoryPort(),
    modelRoundRecovery: {
      claimId: replacementClaimId,
      state: claimed.checkpoint.modelRoundState,
    },
    modelRoundPort: toolSettlementModelRoundPort(),
    toolRuntimePort,
    runState: replacementRunState,
    onEvent: () => undefined,
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalProse, 'tool window settled');
  assert.equal(toolEffectCount, 1);
  assert.deepEqual(replacementRunState.usageTotals, {
    inputTokens: 17,
    outputTokens: 4,
    cachedInputTokens: 9,
  });
  assert.equal(
    (await replacementStore.readThread(threadId))?.modelRoundState?.active
      ?.round,
    1,
  );
});

void test('runAgentLoop restores a committed continuation before the next model round', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-model-settlement-continuation-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = testRunId('model-settlement-continuation');
  const threadId = testThreadId(905);
  const store = createRunCheckpointStore({ stateRoot });
  const originalClaimId = 'model-settlement-continuation-original';
  const logicalRequestIdentity = modelSettlementIdentity(runId, 0);
  const providerRequestIdentity = '7'.repeat(64);
  const continuationHistoryText =
    'The host requires another model round after restart.';
  await store.startRun({
    runId,
    threadId,
    request: { permissionMode: 'basic' },
  });
  await store.recordModelRoundPrepared?.({
    threadId,
    runId,
    active: {
      round: 0,
      claimId: originalClaimId,
      modelRoundAttempt: 0,
      providerRequestAttempt: 0,
      providerId: 'openai_codex_direct',
      model: 'gpt-5.6-sol',
      transportKind: 'websocket',
      providerRequestIdentity,
      contextDigest: `sha256:${'8'.repeat(64)}`,
      toolLibraryProjectionIdentity: TOOL_PROJECTION_IDENTITY,
      responseFormat: null,
      providerReplayScopeId: null,
      logicalRequestIdentity,
    },
  });
  await store.markModelRoundPhase?.({
    threadId,
    runId,
    claimId: originalClaimId,
    providerRequestIdentity,
    phase: 'terminal_observed',
  });
  await store.recordModelRoundSettlementCandidate?.({
    threadId,
    runId,
    claimId: originalClaimId,
    logicalRequestIdentity,
    providerRequestIdentity,
    candidateDigest: `sha256:${'9'.repeat(64)}`,
    usage: {
      inputTokens: 5,
      outputTokens: 2,
      cachedInputTokens: 1,
    },
  });
  await store.commitModelRoundSettlement?.({
    threadId,
    runId,
    claimId: originalClaimId,
    logicalRequestIdentity,
    candidateDigest: `sha256:${'9'.repeat(64)}`,
    resultDigest: `sha256:${'a'.repeat(64)}`,
    result: {
      ok: true,
      finalProse: '',
      modelSettlementIdentity: logicalRequestIdentity,
    },
    disposition: 'continue',
    source: 'natural',
    continuationHistoryText,
  });
  await store.completeModelRound?.({
    threadId,
    runId,
    claimId: originalClaimId,
    logicalRequestIdentity,
    providerRequestIdentity,
  });
  const recovered = await store.readThread(threadId);
  const recoveredState = recovered?.modelRoundState;
  if (recoveredState === null || recoveredState === undefined) {
    throw new Error('committed continuation was not retained');
  }

  let observedContinuationCount = 0;
  const result = await runAgentLoop({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
    prompt: 'resume after the host continuation',
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: {
      ...createDaemonContext(),
      runCheckpoints: store,
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'model-settlement-continuation-replacement',
    }),
    toolLibraryProjectionPort: fixedToolProjection(),
    memoryPort: noCompactionMemoryPort(),
    modelRoundRecovery: {
      claimId: 'model-settlement-continuation-replacement',
      state: recoveredState,
    },
    modelRoundPort: {
      async runModelRound(args) {
        assert.equal(args.round, 1);
        observedContinuationCount = args.history.filter(
          (item) =>
            item.kind === 'assistant' &&
            item.phase === 'final_answer' &&
            item.text === continuationHistoryText,
        ).length;
        const nextProviderRequestIdentity = '6'.repeat(64);
        await args.onDurableProviderRequestPrepared?.({
          requestIdentity: nextProviderRequestIdentity,
          providerRequestAttempt: 0,
          modelRoundAttempt: 0,
          transportKind: 'websocket',
          contextDigest: `sha256:${'5'.repeat(64)}`,
          resumed: false,
        });
        await args.onDurableProviderPhase?.({
          providerRequestIdentity: nextProviderRequestIdentity,
          phase: 'terminal_observed',
        });
        return {
          ok: true,
          value: {
            assistantText: 'continued exactly once',
            terminalResult: {
              ok: true,
              finalProse: 'continued exactly once',
            },
            functionCalls: [],
          },
        };
      },
    },
    onEvent: () => undefined,
  });

  assert.equal(observedContinuationCount, 1);
  assert.equal(result.ok, true);
  assert.equal(result.finalProse, 'continued exactly once');
});

void test('runAgentLoop fails closed when the rebuilt context digest conflicts with the active boundary', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-active-model-boundary-conflict-'),
  );
  t.after(async () => rm(stateRoot, { recursive: true, force: true }));
  const runId = testRunId('active-model-boundary-conflict');
  const threadId = testThreadId(902);
  const store = createRunCheckpointStore({ stateRoot });
  const firstClaimId = 'active-boundary-original-claim';
  await store.startRun({
    runId,
    threadId,
    request: { permissionMode: 'basic' },
  });
  const prepared = await store.recordModelRoundPrepared?.({
    threadId,
    runId,
    active: {
      round: 0,
      claimId: firstClaimId,
      modelRoundAttempt: 0,
      providerRequestAttempt: 0,
      providerId: 'openai_codex_direct',
      model: 'gpt-5.6-sol',
      transportKind: 'websocket',
      providerRequestIdentity: PROVIDER_REQUEST_IDENTITY,
      contextDigest: `sha256:${'c'.repeat(64)}`,
      toolLibraryProjectionIdentity: TOOL_PROJECTION_IDENTITY,
      responseFormat: null,
      providerReplayScopeId: null,
      logicalRequestIdentity: modelSettlementIdentity(runId, 0),
    },
  });
  assert.equal(prepared?.ok, true);

  const replacementClaimId = 'active-boundary-conflict-replacement';
  const claimed = await store.claimActiveModelRound?.({
    threadId,
    runId,
    claimId: replacementClaimId,
  });
  if (
    claimed === undefined ||
    !claimed.ok ||
    claimed.checkpoint.modelRoundState === null
  ) {
    throw new Error('replacement model round claim was unavailable');
  }

  let semanticYieldCount = 0;
  const events: AgentEvent[] = [];
  const result = await runAgentLoop({
    runId,
    runContext: makeRunContext({ threadId, stateRoot }),
    prompt: 'this rebuilt context does not match the durable digest',
    toolSurface: { directRegistryNames: [], allowedRegistryNames: [] },
    runtimeServices: {
      ...createDaemonContext(),
      runCheckpoints: store,
    },
    approvalContext: makeApprovalContext({
      computerSessionId: 'active-boundary-conflict',
    }),
    toolLibraryProjectionPort: fixedToolProjection(),
    modelRoundRecovery: {
      claimId: replacementClaimId,
      state: claimed.checkpoint.modelRoundState,
    },
    callModelImpl: async function* (input) {
      const onPrepared = input.onDurableProviderRequestPrepared;
      if (onPrepared === undefined) {
        throw new Error('durable provider preparation callback is unavailable');
      }
      await onPrepared({
        requestIdentity: PROVIDER_REQUEST_IDENTITY,
        providerRequestAttempt: 0,
        transportKind: 'websocket',
        resumed: true,
      });
      semanticYieldCount += 1;
      yield {
        type: 'done',
        assistantText: 'must not settle',
        finalText: 'must not settle',
      };
    },
    onEvent(event) {
      events.push(event);
    },
  });

  assert.deepEqual(result, { ok: false, finalProse: '' });
  assert.equal(semanticYieldCount, 0);
  assert.deepEqual(
    events.find((event) => event.type === 'error'),
    {
      type: 'error',
      payload: {
        code: 'llm_provider_request_outcome_unknown',
        message:
          'provider request outcome is unknown; explicit recovery is required before retrying',
      },
    },
  );
});

function noCompactionMemoryPort(): NonNullable<AgentInput['memoryPort']> {
  return {
    beginContextBudgetRound() {
      return {
        onProviderRequestPrepared() {},
        async prepareBeforeModelRound() {
          return {
            kind: 'failed',
            message: 'context preparation was not requested by this test',
          };
        },
        getRequestBytes() {
          return undefined;
        },
        getToolResultContextBudget() {
          return {
            kind: 'unknown',
            modelKey: 'test\0model-settlement',
            reason: 'usage_unavailable',
          };
        },
        publish() {},
      };
    },
    async compactAfterModelRound() {
      return { kind: 'not_needed', reason: 'under_threshold' };
    },
  };
}

function toolSettlementModelRoundPort(): NonNullable<
  AgentInput['modelRoundPort']
> {
  return {
    async runModelRound(args) {
      const firstRound = args.round === 0;
      const providerRequestIdentity = firstRound
        ? 'e'.repeat(64)
        : 'f'.repeat(64);
      await args.onDurableProviderRequestPrepared?.({
        requestIdentity: providerRequestIdentity,
        providerRequestAttempt: 0,
        modelRoundAttempt: 0,
        transportKind: 'websocket',
        contextDigest: `sha256:${firstRound ? '1'.repeat(64) : '2'.repeat(64)}`,
        resumed: false,
      });
      await args.onDurableProviderPhase?.({
        providerRequestIdentity,
        phase: 'streaming',
      });
      await args.onDurableProviderPhase?.({
        providerRequestIdentity,
        phase: 'terminal_observed',
      });
      if (firstRound) {
        return {
          ok: true,
          value: {
            assistantText: '',
            terminalResult: { ok: true, finalProse: '' },
            functionCalls: [
              {
                id: 'read-file-item',
                callId: 'read-file-call',
                name: 'read_file',
                arguments: '{"path":"README.md"}',
              },
            ],
            providerUsageTelemetry: {
              inputTokens: 17,
              outputTokens: 4,
              cachedInputTokens: 9,
            },
          },
        };
      }
      return {
        ok: true,
        value: {
          assistantText: 'tool window settled',
          terminalResult: {
            ok: true,
            finalProse: 'tool window settled',
          },
          functionCalls: [],
        },
      };
    },
  };
}

function structuredEffectModelRoundPort(): NonNullable<
  AgentInput['modelRoundPort']
> {
  return {
    async runModelRound(args) {
      await args.onDurableProviderRequestPrepared?.({
        requestIdentity: PROVIDER_REQUEST_IDENTITY,
        providerRequestAttempt: 0,
        modelRoundAttempt: 0,
        transportKind: 'websocket',
        contextDigest: `sha256:${'d'.repeat(64)}`,
        resumed: false,
      });
      await args.onDurableProviderPhase?.({
        providerRequestIdentity: PROVIDER_REQUEST_IDENTITY,
        phase: 'streaming',
      });
      await args.onDurableProviderPhase?.({
        providerRequestIdentity: PROVIDER_REQUEST_IDENTITY,
        phase: 'terminal_observed',
      });
      return {
        ok: true as const,
        value: {
          assistantText: '',
          terminalResult: {
            ok: true,
            finalProse: 'structured result',
          },
          functionCalls: [],
          providerUsageTelemetry: {
            inputTokens: 13,
            outputTokens: 3,
            cachedInputTokens: 2,
          },
          structuredOutputs: [
            {
              schemaVersion: 1,
              kind: 'test_effect',
              payload: { operation: 'commit' },
            },
          ],
        },
      };
    },
  };
}

function fixedToolProjection() {
  return {
    async resolveProjection() {
      return {
        ok: true as const,
        identity: TOOL_PROJECTION_IDENTITY,
      };
    },
  };
}

function createTerminalReplayCall(resumed: boolean) {
  return async function* (
    input: Parameters<
      NonNullable<Parameters<typeof runAgentLoop>[0]['callModelImpl']>
    >[0],
  ) {
    const prepared = input.onDurableProviderRequestPrepared;
    if (prepared === undefined) {
      throw new Error('durable provider preparation callback is unavailable');
    }
    await prepared({
      requestIdentity: PROVIDER_REQUEST_IDENTITY,
      providerRequestAttempt: 0,
      transportKind: 'websocket',
      resumed,
    });
    yield {
      type: 'text_delta' as const,
      text: 'durable terminal',
      phase: 'final_answer' as const,
    };
    yield {
      type: 'done' as const,
      assistantText: 'durable terminal',
      finalText: 'durable terminal',
    };
  };
}
