import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { createProviderAuthRuntimeStore } from '../src/daemon/auth/runtime-state.js';
import { loadInitialHistory } from '../src/daemon/agent/loop-history.js';
import { runModelRound } from '../src/daemon/agent/loop-model-round.js';
import {
  recordToolCall,
  recordToolResult,
} from '../src/daemon/agent/loop-tool-support.js';
import {
  resolveProviderRequestOptions,
  resolveProviderRequestOptionsForRun,
} from '../src/daemon/llm/provider/provider-options.js';
import { appendProviderRound } from '../src/daemon/sessions/provider-round-journal.js';
import { createRunCheckpointStore } from '../src/daemon/sessions/run-checkpoint-store.js';
import { appendTranscriptEntry } from '../src/daemon/sessions/transcript-log.js';

const REPORT_SCHEMA_VERSION = 1;
const FIXTURE_TIMESTAMP = '2026-07-29T00:00:00.000Z';
const PRIOR_USER_MARKER = 'P8_FAULT_LAB_PRIOR_USER_MEANING';
const PRIOR_ASSISTANT_MARKER = 'P8_FAULT_LAB_PRIOR_ASSISTANT_MEANING';
const CURRENT_PROMPT_MARKER = 'P8_FAULT_LAB_CURRENT_REQUEST_MEANING';
const PROVIDER_BOUND_MARKER = 'P8_FAULT_LAB_PROVIDER_BOUND_REASONING';
const TARGET_FINAL_TEXT = 'P8_FAULT_LAB_TARGET_COMPLETED';

const DIRECTIONS = [
  {
    id: 'gpt_to_grok',
    source: {
      providerId: 'openai_codex_direct',
      model: 'gpt-5.6-sol',
    },
    target: {
      providerId: 'grok_oauth',
      model: 'grok-4.5',
    },
  },
  {
    id: 'grok_to_gpt',
    source: {
      providerId: 'grok_oauth',
      model: 'grok-4.5',
    },
    target: {
      providerId: 'openai_codex_direct',
      model: 'gpt-5.6-sol',
    },
  },
];

const FAILURE_CASES = [
  {
    id: 'idle_timeout',
    category: 'llm_idle_timeout',
    errorCode: 'llm_idle_timeout',
    expectedEligible: true,
  },
  {
    id: 'connection_lost',
    category: 'llm_connection_lost',
    errorCode: 'llm_connection_lost',
    expectedEligible: true,
  },
  {
    id: 'tls_verification_failed',
    category: 'llm_tls_verification_failed',
    errorCode: 'llm_tls_verification_failed',
    expectedEligible: false,
  },
  {
    id: 'overloaded',
    category: 'llm_overloaded',
    errorCode: 'llm_overloaded',
    expectedEligible: true,
  },
  {
    id: 'rate_limited',
    category: 'llm_rate_limited',
    errorCode: 'llm_rate_limited',
    expectedEligible: false,
  },
  {
    id: 'usage_limit',
    category: 'llm_usage_limit_exceeded',
    errorCode: 'llm_usage_limit_exceeded',
    expectedEligible: false,
  },
  {
    id: 'auth_expired',
    category: 'llm_auth_expired',
    errorCode: 'llm_auth_failed',
    expectedEligible: false,
  },
  {
    id: 'context_overflow',
    category: 'llm_context_overflow',
    errorCode: 'llm_context_length_exceeded',
    expectedEligible: false,
  },
  {
    id: 'output_budget',
    category: 'llm_output_budget_exceeded',
    errorCode: 'llm_output_budget_exceeded',
    expectedEligible: false,
  },
  {
    id: 'replay_rejected',
    category: 'llm_replay_state_rejected',
    errorCode: 'invalid_encrypted_content',
    expectedEligible: false,
  },
  {
    id: 'context_preparation',
    category: 'llm_context_preparation_required',
    errorCode: 'llm_context_preparation_required',
    expectedEligible: false,
  },
  {
    id: 'provider_transition_required',
    category: 'llm_provider_transition_required',
    errorCode: 'provider_transition_required',
    expectedEligible: false,
  },
  {
    id: 'oversize_input',
    category: 'oversize_input',
    errorCode: 'oversize_input',
    expectedEligible: false,
  },
  {
    id: 'refused',
    category: 'llm_refused',
    errorCode: 'llm_refused',
    expectedEligible: false,
  },
  {
    id: 'user_abort',
    category: 'abort_user',
    errorCode: 'aborted',
    expectedEligible: false,
  },
  {
    id: 'budget_abort',
    category: 'abort_budget',
    errorCode: 'abort_budget',
    expectedEligible: false,
  },
  {
    id: 'unknown',
    category: 'unknown',
    errorCode: 'fault_lab_unknown_provider_error',
    expectedEligible: false,
  },
  {
    id: 'partial_text_then_connection_lost',
    category: 'llm_connection_lost',
    errorCode: 'llm_connection_lost',
    mode: 'partial_text',
    expectedEligible: false,
  },
  {
    id: 'tool_call_then_connection_lost',
    category: 'llm_connection_lost',
    errorCode: 'llm_connection_lost',
    mode: 'partial_tool_call',
    expectedEligible: false,
  },
  {
    id: 'approval_then_connection_lost',
    category: 'llm_connection_lost',
    errorCode: 'llm_connection_lost',
    mode: 'approval_evidence',
    expectedEligible: false,
  },
  {
    id: 'read_tool_then_connection_lost',
    category: 'llm_connection_lost',
    errorCode: 'llm_connection_lost',
    mode: 'completed_read_tool',
    expectedEligible: false,
  },
  {
    id: 'mutation_tool_then_connection_lost',
    category: 'llm_connection_lost',
    errorCode: 'llm_connection_lost',
    mode: 'completed_mutation_tool',
    expectedEligible: false,
  },
];

const AUTOMATIC_CANDIDATE_CATEGORIES = new Set([
  'llm_connection_lost',
  'llm_idle_timeout',
  'llm_overloaded',
]);

const LAB_ARMS = [
  {
    id: 'current_composition',
    quarantineSourceTerminal: false,
  },
  {
    id: 'candidate_terminal_quarantine',
    quarantineSourceTerminal: true,
  },
];

const COMMIT_BLOCKING_EVENT_TYPES = new Set([
  'approval_required',
  'artifact_committed',
  'artifact_stream_delta',
  'commentary_delta',
  'final_answer_delta',
  'interject_applied',
  'subagent_approval_required',
  'subagent_spawned',
  'subagent_status',
  'subagent_terminal',
  'tool_call',
  'tool_call_delta',
  'tool_result',
]);

const unusedProviderWebSocketSessions = {
  async acquireWebSocket() {
    throw new Error('fault lab must not acquire a provider websocket');
  },
};

function resolveLabProviderOptions(providerModel) {
  const base = resolveProviderRequestOptions({});
  const options = resolveProviderRequestOptionsForRun(base, {
    providerModel,
  });
  return {
    ...options,
    modelRoundRetry: {
      llmConnectionLost: { maxRetries: 0 },
      llmOverloaded: { maxRetries: 0 },
      llmRateLimited: { maxRetries: 0 },
    },
  };
}

function createEmitter(events) {
  return (type, payload) => {
    events.push({ type, payload });
  };
}

function createFailureCallModel({
  expectedProvider,
  scenario,
  requestObservations,
  attemptSemanticKinds,
}) {
  return async function* (input) {
    const observedProvider = input.providerRequestOptions.providerId;
    const observedModel = input.providerRequestOptions.model;
    if (
      observedProvider !== expectedProvider.providerId ||
      observedModel !== expectedProvider.model
    ) {
      throw new Error('fault lab provider request target mismatch');
    }
    requestObservations.push({
      providerId: observedProvider,
      model: observedModel,
    });

    if (scenario.mode === 'partial_text') {
      attemptSemanticKinds.push('text_delta');
      yield {
        type: 'text_delta',
        text: 'fault-lab-partial-output',
        phase: 'final_answer',
      };
    } else if (scenario.mode === 'partial_tool_call') {
      attemptSemanticKinds.push('tool_call');
      yield {
        type: 'tool_call',
        id: 'fault-lab-partial-tool-item',
        callId: 'fault-lab-partial-tool-call',
        toolName: 'fault_lab_read',
        argumentsJson: '{}',
      };
    }

    yield {
      type: 'error',
      code: scenario.errorCode,
      message: 'injected provider fault',
    };
  };
}

function createToolCallModel({ expectedProvider, mode, requestObservations }) {
  return async function* (input) {
    if (
      input.providerRequestOptions.providerId !== expectedProvider.providerId ||
      input.providerRequestOptions.model !== expectedProvider.model
    ) {
      throw new Error('fault lab tool round target mismatch');
    }
    requestObservations.push({
      providerId: input.providerRequestOptions.providerId,
      model: input.providerRequestOptions.model,
    });
    const toolName =
      mode === 'completed_mutation_tool'
        ? 'fault_lab_mutation'
        : 'fault_lab_read';
    yield {
      type: 'tool_call',
      id: `fault-lab-${toolName}-item`,
      callId: `fault-lab-${toolName}-call`,
      toolName,
      argumentsJson: '{}',
    };
    yield {
      type: 'done',
      assistantText: '',
      finalText: '',
      stopReason: 'tool_calls',
    };
  };
}

function classifyAutomaticAdmission({
  category,
  attemptSemanticKinds,
  events,
}) {
  if (!AUTOMATIC_CANDIDATE_CATEGORIES.has(category)) {
    return {
      eligible: false,
      reason: 'failure_class_ineligible',
      blockerEventCount: 0,
    };
  }
  if (attemptSemanticKinds.length > 0) {
    return {
      eligible: false,
      reason: 'attempt_semantic_output_observed',
      blockerEventCount: 0,
    };
  }
  const blockerEventCount = events.filter((event) =>
    COMMIT_BLOCKING_EVENT_TYPES.has(event.type),
  ).length;
  if (blockerEventCount > 0) {
    return {
      eligible: false,
      reason: 'durable_run_commit_observed',
      blockerEventCount,
    };
  }
  return {
    eligible: true,
    reason: 'zero_commit_candidate',
    blockerEventCount: 0,
  };
}

async function buildScenarioHistory({
  stateRoot,
  threadId,
  source,
  priorRunId,
}) {
  const priorUser = await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: PRIOR_USER_MARKER,
    timestamp: FIXTURE_TIMESTAMP,
  });
  await appendProviderRound({
    stateRoot,
    threadId,
    runId: priorRunId,
    round: 0,
    providerId: source.providerId,
    model: source.model,
    replayScopeId: null,
    precedingTranscriptEntryId: priorUser.entryId,
    items: [
      {
        id: 'fault-lab-provider-bound-item',
        type: 'reasoning',
        encrypted_content: PROVIDER_BOUND_MARKER,
      },
    ],
    functionCalls: [],
    now: () => FIXTURE_TIMESTAMP,
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'assistant',
    content: PRIOR_ASSISTANT_MARKER,
    timestamp: FIXTURE_TIMESTAMP,
  });
  await appendTranscriptEntry(stateRoot, threadId, {
    role: 'user',
    content: CURRENT_PROMPT_MARKER,
    timestamp: FIXTURE_TIMESTAMP,
  });
  const sourceHistory = await loadInitialHistory(
    stateRoot,
    threadId,
    CURRENT_PROMPT_MARKER,
    source,
  );
  if (!sourceHistory.some((item) => item.kind === 'backend_item')) {
    throw new Error('fault lab source history did not use provider round data');
  }
  return sourceHistory;
}

async function runModelFailure({
  history,
  threadId,
  provider,
  scenario,
  emit,
  requestObservations,
  attemptSemanticKinds,
  round,
}) {
  return await runModelRound({
    history,
    systemPrompt: 'fault lab system contract',
    round,
    toolDefs: [],
    threadId,
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: resolveLabProviderOptions(provider),
    emit,
    retrySleep: async () => undefined,
    callModelImpl: createFailureCallModel({
      expectedProvider: provider,
      scenario,
      requestObservations,
      attemptSemanticKinds,
    }),
  });
}

async function executeCompletedToolEvidence({
  mode,
  stateRoot,
  threadId,
  runId,
  source,
  history,
  events,
  requestObservations,
  markerPath,
}) {
  const toolRound = await runModelRound({
    history,
    systemPrompt: 'fault lab system contract',
    round: 0,
    toolDefs: [],
    threadId,
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: resolveLabProviderOptions(source),
    emit: createEmitter(events),
    retrySleep: async () => undefined,
    callModelImpl: createToolCallModel({
      expectedProvider: source,
      mode,
      requestObservations,
    }),
  });
  if (!toolRound.ok || toolRound.value.functionCalls.length !== 1) {
    throw new Error('fault lab tool round did not produce one tool call');
  }
  const functionCall = toolRound.value.functionCalls[0];
  const toolArgs = {};
  const runContext = { stateRoot, threadId };
  await recordToolCall({
    functionCall,
    round: 0,
    toolArgs,
    runContext,
    emit: createEmitter(events),
    recoveryStrategy: 'replay_safe',
  });

  let invocationCount = 0;
  let mutationCommitCount = 0;
  let output;
  invocationCount += 1;
  if (mode === 'completed_mutation_tool') {
    await writeFile(markerPath, 'mutated', 'utf8');
    mutationCommitCount += 1;
    output = JSON.stringify({ committed: true });
  } else {
    output = JSON.stringify({
      observed: (await readFile(markerPath, 'utf8')) === 'initial',
    });
  }
  await recordToolResult({
    functionCall,
    round: 0,
    toolResult: { ok: true, output },
    computerFilesMayHaveChanged: mode === 'completed_mutation_tool',
    runContext,
    runId,
    history,
    emit: createEmitter(events),
  });
  return { invocationCount, mutationCommitCount };
}

async function runTargetRound({
  history,
  threadId,
  target,
  targetRequestObservations,
}) {
  const targetEvents = [];
  const startedAt = performance.now();
  const result = await runModelRound({
    history,
    systemPrompt: 'fault lab system contract',
    round: 0,
    toolDefs: [],
    threadId,
    providerWebSocketSessions: unusedProviderWebSocketSessions,
    providerAuthRuntime: createProviderAuthRuntimeStore(),
    providerRequestOptions: resolveLabProviderOptions(target),
    emit: createEmitter(targetEvents),
    retrySleep: async () => undefined,
    callModelImpl: async function* (input) {
      if (
        input.providerRequestOptions.providerId !== target.providerId ||
        input.providerRequestOptions.model !== target.model
      ) {
        throw new Error('fault lab target provider request mismatch');
      }
      targetRequestObservations.push({
        providerId: input.providerRequestOptions.providerId,
        model: input.providerRequestOptions.model,
      });
      yield {
        type: 'text_delta',
        text: TARGET_FINAL_TEXT,
        phase: 'final_answer',
      };
      yield {
        type: 'done',
        assistantText: TARGET_FINAL_TEXT,
        finalText: TARGET_FINAL_TEXT,
      };
    },
  });
  return {
    completed: result.ok && result.value.terminalResult.ok,
    injectedRecoveryLatencyMs: Math.max(
      0,
      Math.round(performance.now() - startedAt),
    ),
  };
}

async function runFaultCase(arm, direction, scenario) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-p8-fault-lab-'));
  const threadId = randomUUID();
  const runId = randomUUID();
  const markerPath = join(stateRoot, 'fault-lab-marker.txt');
  const sourceEvents = [];
  const quarantinedSourceTerminalEvents = [];
  const sourceRequestObservations = [];
  const targetRequestObservations = [];
  const attemptSemanticKinds = [];
  let toolInvocationCount = 0;
  let mutationCommitCount = 0;
  const sourceFailureEmitter = (type, payload) => {
    if (arm.quarantineSourceTerminal && (type === 'error' || type === 'done')) {
      quarantinedSourceTerminalEvents.push({ type, payload });
      return;
    }
    sourceEvents.push({ type, payload });
  };

  try {
    await writeFile(markerPath, 'initial', 'utf8');
    const history = await buildScenarioHistory({
      stateRoot,
      threadId,
      source: direction.source,
      priorRunId: randomUUID(),
    });

    if (scenario.mode === 'approval_evidence') {
      sourceEvents.push({
        type: 'approval_required',
        payload: {
          callId: 'fault-lab-approval-call',
          runId,
          threadId,
          toolName: 'fault_lab_mutation',
          approvalClass: 'fault-lab-mutation',
          permissionMode: 'default',
          argumentsPreview: {},
          sideEffectLevel: 'write',
        },
      });
    }

    if (
      scenario.mode === 'completed_read_tool' ||
      scenario.mode === 'completed_mutation_tool'
    ) {
      const toolEvidence = await executeCompletedToolEvidence({
        mode: scenario.mode,
        stateRoot,
        threadId,
        runId,
        source: direction.source,
        history,
        events: sourceEvents,
        requestObservations: sourceRequestObservations,
        markerPath,
      });
      toolInvocationCount = toolEvidence.invocationCount;
      mutationCommitCount = toolEvidence.mutationCommitCount;
    }

    const sourceResult = await runModelFailure({
      history,
      threadId,
      provider: direction.source,
      scenario,
      emit: sourceFailureEmitter,
      requestObservations: sourceRequestObservations,
      attemptSemanticKinds,
      round:
        scenario.mode === 'completed_read_tool' ||
        scenario.mode === 'completed_mutation_tool'
          ? 1
          : 0,
    });
    if (sourceResult.ok) {
      throw new Error('fault lab source failure unexpectedly completed');
    }

    const admission = classifyAutomaticAdmission({
      category: scenario.category,
      attemptSemanticKinds,
      events: sourceEvents,
    });
    const sourceTerminalEventsBeforeTarget = sourceEvents.filter(
      (event) => event.type === 'error' || event.type === 'done',
    ).length;
    let historyMeaningPreserved = false;
    let providerBoundHistoryRemoved = false;
    let targetCompleted = false;
    let injectedRecoveryLatencyMs = null;

    if (admission.eligible) {
      const targetHistory = await loadInitialHistory(
        stateRoot,
        threadId,
        CURRENT_PROMPT_MARKER,
        direction.target,
      );
      const targetHistoryJson = JSON.stringify(targetHistory);
      historyMeaningPreserved =
        targetHistoryJson.includes(PRIOR_USER_MARKER) &&
        targetHistoryJson.includes(PRIOR_ASSISTANT_MARKER) &&
        targetHistoryJson.includes(CURRENT_PROMPT_MARKER);
      providerBoundHistoryRemoved =
        !targetHistory.some((item) => item.kind === 'backend_item') &&
        !targetHistoryJson.includes(PROVIDER_BOUND_MARKER);
      const target = await runTargetRound({
        history: targetHistory,
        threadId,
        target: direction.target,
        targetRequestObservations,
      });
      targetCompleted = target.completed;
      injectedRecoveryLatencyMs = target.injectedRecoveryLatencyMs;
    }

    const sourceTerminalSuppressed =
      admission.eligible && targetCompleted && arm.quarantineSourceTerminal;
    if (arm.quarantineSourceTerminal && !sourceTerminalSuppressed) {
      sourceEvents.push(...quarantinedSourceTerminalEvents);
    }
    const marker = await readFile(markerPath, 'utf8');
    const duplicateSideEffectCount = Math.max(0, mutationCommitCount - 1);
    const mutationOracleSatisfied =
      scenario.mode !== 'completed_mutation_tool' ||
      (mutationCommitCount === 1 && marker === 'mutated');
    const eligibilityMatched = admission.eligible === scenario.expectedEligible;
    const targetRequestContractSatisfied = admission.eligible
      ? targetRequestObservations.length === 1
      : targetRequestObservations.length === 0;
    const historyContractSatisfied =
      !admission.eligible ||
      (historyMeaningPreserved && providerBoundHistoryRemoved);
    const lifecycleContractSatisfied =
      !admission.eligible || sourceTerminalEventsBeforeTarget === 0;
    const casePassed =
      eligibilityMatched &&
      targetRequestContractSatisfied &&
      historyContractSatisfied &&
      mutationOracleSatisfied &&
      duplicateSideEffectCount === 0 &&
      targetCompleted === admission.eligible &&
      lifecycleContractSatisfied;
    const sourceTerminalCode = [
      ...sourceEvents,
      ...quarantinedSourceTerminalEvents,
    ].findLast((event) => event.type === 'error')?.payload?.code;

    return {
      id: `${arm.id}:${direction.id}:${scenario.id}`,
      arm: arm.id,
      direction: direction.id,
      sourceProviderId: direction.source.providerId,
      sourceModelId: direction.source.model,
      targetProviderId: direction.target.providerId,
      targetModelId: direction.target.model,
      failureCategory: scenario.category,
      expectedEligible: scenario.expectedEligible,
      actualEligible: admission.eligible,
      admissionReason: admission.reason,
      attemptSemanticEvidenceCount: attemptSemanticKinds.length,
      durableBlockerEventCount: admission.blockerEventCount,
      sourceRequestCount: sourceRequestObservations.length,
      targetRequestCount: targetRequestObservations.length,
      sourceTerminalEventCountBeforeTarget: sourceTerminalEventsBeforeTarget,
      quarantinedSourceTerminalEventCount:
        quarantinedSourceTerminalEvents.length,
      sourceTerminalSuppressed,
      sourceTerminalCode:
        typeof sourceTerminalCode === 'string' ? sourceTerminalCode : null,
      historyMeaningPreserved,
      providerBoundHistoryRemoved,
      toolInvocationCount,
      mutationCommitCount,
      duplicateSideEffectCount,
      mutationOracleSatisfied,
      targetCompleted,
      injectedRecoveryLatencyMs,
      billedCostObserved: false,
      casePassed,
    };
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

function summarizeCases(cases) {
  const eligibleCases = cases.filter((entry) => entry.actualEligible);
  const ineligibleCases = cases.filter((entry) => !entry.actualEligible);
  const sourceRequestCount = cases.reduce(
    (sum, entry) => sum + entry.sourceRequestCount,
    0,
  );
  const targetRequestCount = cases.reduce(
    (sum, entry) => sum + entry.targetRequestCount,
    0,
  );
  const duplicateSideEffectCount = cases.reduce(
    (sum, entry) => sum + entry.duplicateSideEffectCount,
    0,
  );
  const historyLossCount = eligibleCases.filter(
    (entry) =>
      !entry.historyMeaningPreserved || !entry.providerBoundHistoryRemoved,
  ).length;
  const ineligibleTargetRequestCount = ineligibleCases.reduce(
    (sum, entry) => sum + entry.targetRequestCount,
    0,
  );
  const terminalEventLeakCount = eligibleCases.reduce(
    (sum, entry) => sum + entry.sourceTerminalEventCountBeforeTarget,
    0,
  );
  return {
    caseCount: cases.length,
    expectedEligibleCaseCount: cases.filter((entry) => entry.expectedEligible)
      .length,
    actualEligibleCaseCount: eligibleCases.length,
    recoveredEligibleCaseCount: eligibleCases.filter(
      (entry) => entry.targetCompleted,
    ).length,
    rejectedCaseCount: ineligibleCases.length,
    sourceRequestCount,
    targetRequestCount,
    ineligibleTargetRequestCount,
    duplicateSideEffectCount,
    historyLossCount,
    terminalEventLeakCount,
    casePassCount: cases.filter((entry) => entry.casePassed).length,
    gatePassed: cases.every((entry) => entry.casePassed),
  };
}

async function runRestartIdentityProbe(direction) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'geulbat-p8-restart-lab-'));
  const threadId = randomUUID();
  const runId = randomUUID();
  const transitionId = randomUUID();
  const transitionReason = 'llm_connection_lost';

  try {
    const initialStore = createRunCheckpointStore({
      stateRoot,
      now: () => FIXTURE_TIMESTAMP,
    });
    const started = await initialStore.startRun({
      threadId,
      runId,
      request: {
        workingDirectory: 'fault-lab-workspace',
        permissionMode: 'basic',
        providerModel: direction.source,
      },
    });
    if (!started.ok) {
      throw new Error('fault lab restart checkpoint was not admitted');
    }

    // The candidate transition exists only in the interrupted process here.
    // Recreate the store from disk exactly as a daemon restart would.
    const restartedStore = createRunCheckpointStore({
      stateRoot,
      now: () => FIXTURE_TIMESTAMP,
    });
    const recovered = await restartedStore.readThread(threadId);
    if (
      recovered === null ||
      recovered.status !== 'running' ||
      recovered.runId !== runId
    ) {
      throw new Error('fault lab restart checkpoint did not round-trip');
    }
    const recoveredJson = JSON.stringify(recovered);
    const sourceSelectionRecovered =
      recovered.request.providerModel?.providerId ===
        direction.source.providerId &&
      recovered.request.providerModel?.model === direction.source.model;
    const targetSelectionRecovered =
      recoveredJson.includes(direction.target.providerId) &&
      recoveredJson.includes(direction.target.model);
    const transitionReasonRecovered = recoveredJson.includes(transitionReason);
    const transitionIdentityRecovered = recoveredJson.includes(transitionId);
    const transitionMutationOwnerObserved = Object.keys(restartedStore).some(
      (name) => /provider.*(transition|fallback|failover)/iu.test(name),
    );
    return {
      direction: direction.id,
      checkpointRoundTrip: true,
      sourceSelectionRecovered,
      targetSelectionRecovered,
      transitionReasonRecovered,
      transitionIdentityRecovered,
      transitionMutationOwnerObserved,
      exactlyOnceProvable:
        sourceSelectionRecovered &&
        targetSelectionRecovered &&
        transitionReasonRecovered &&
        transitionIdentityRecovered &&
        transitionMutationOwnerObserved,
    };
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
}

async function runProviderFailoverFaultLab({ now = () => new Date() } = {}) {
  const cases = [];
  for (const arm of LAB_ARMS) {
    for (const direction of DIRECTIONS) {
      for (const scenario of FAILURE_CASES) {
        cases.push(await runFaultCase(arm, direction, scenario));
      }
    }
  }
  const armSummaries = Object.fromEntries(
    LAB_ARMS.map((arm) => [
      arm.id,
      summarizeCases(cases.filter((entry) => entry.arm === arm.id)),
    ]),
  );
  const restartIdentityProbes = [];
  for (const direction of DIRECTIONS) {
    restartIdentityProbes.push(await runRestartIdentityProbe(direction));
  }
  const restartExactlyOnceProvable = restartIdentityProbes.every(
    (entry) => entry.exactlyOnceProvable,
  );
  const terminalQuarantineArmPassed =
    armSummaries.candidate_terminal_quarantine.gatePassed;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: 'provider_failover_fault_lab',
    generatedAt: now().toISOString(),
    executionMode: 'injected_non_network',
    policy: {
      automaticCandidateCategories: [...AUTOMATIC_CANDIDATE_CATEGORIES].sort(),
      failClosedOnAttemptSemanticEvidence: true,
      failClosedOnDurableRunCommitEvidence: true,
      sameProviderRetryBudgetForcedToZeroForLab: true,
      liveProviderRequestsAllowed: false,
    },
    summary: {
      totalCaseCount: cases.length,
      currentComposition: armSummaries.current_composition,
      candidateTerminalQuarantine: armSummaries.candidate_terminal_quarantine,
      terminalQuarantineArmPassed,
      restartExactlyOnceProvable,
      p8cCandidateGatePassed:
        terminalQuarantineArmPassed && restartExactlyOnceProvable,
      productPathObserved: false,
    },
    restartIdentityProbes,
    cases,
  };
}

async function writeProviderFailoverFaultLabReport(outputPath, report) {
  const resolvedOutput = resolve(outputPath);
  await mkdir(dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function readOutputPath(argv) {
  const outputIndex = argv.indexOf('--output');
  const outputPath = outputIndex < 0 ? undefined : argv[outputIndex + 1];
  if (outputPath === undefined || outputPath.trim() === '') {
    throw new Error('--output <report.json> is required');
  }
  return outputPath;
}

async function main() {
  const outputPath = readOutputPath(process.argv.slice(2));
  const report = await runProviderFailoverFaultLab();
  await writeProviderFailoverFaultLabReport(outputPath, report);
  process.stdout.write(
    `${JSON.stringify({
      report: resolve(outputPath),
      totalCaseCount: report.summary.totalCaseCount,
      currentCompositionGatePassed:
        report.summary.currentComposition.gatePassed,
      p8cCandidateGatePassed: report.summary.p8cCandidateGatePassed,
      currentTerminalEventLeakCount:
        report.summary.currentComposition.terminalEventLeakCount,
    })}\n`,
  );
}

const invokedPath =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await main();
}
