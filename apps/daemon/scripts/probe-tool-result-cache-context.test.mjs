import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProbeInputError,
  buildCheckpointCacheReuseIdentity,
  evaluateCacheContextComparison,
  evaluateCheckpointCacheReuseEvidence,
  evaluateCompactionPolicyTrials,
  evaluateEnumerablePreviewBudget,
  evaluateEvidenceSelectionTradeoff,
  evaluateIndependentEvidenceWorkload,
  expandProviderNativeFunctionCallBatch,
  parseProbeOptions,
  runRecoveryTask,
  selectEvidencePageWindow,
  selectWarmCacheControl,
  summarizeCacheContextRound,
  summarizeExactAnswerDiagnostic,
} from './probe-tool-result-cache-context.mjs';

const VALID_ARGS = [
  '--large-lines',
  '12',
  '--line-payload-bytes',
  '80',
  '--small-result-count',
  '3',
  '--small-lines',
  '4',
  '--same-round-visible-bytes',
  '4096',
  '--compaction-padding-bytes',
  '60000',
  '--cache-settle-ms',
  '0',
  '--warm-controls',
  '2',
  '--evidence-page-chars',
  '8192',
  '--evidence-marker-line',
  '6',
  '--evidence-ref-count',
  '3',
  '--target-evidence-ref',
  '2',
  '--evidence-free-turns',
  '3',
  '--evidence-needed-turns',
  '1',
  '--max-model-rounds',
  '4',
  '--policy-trials',
  '3',
];

function testRound({ label, requestBytes, inputTokens, cachedInputTokens }) {
  return {
    label,
    requestMeasurement: {
      serializedBytes: requestBytes,
      dominantPressureSource: 'history',
      serializedBytesBySource: {
        history: requestBytes - 30,
        instructions: 10,
        toolDefinitions: 10,
        envelope: 10,
      },
    },
    requestPreparationCount: 1,
    providerUsageTelemetry:
      inputTokens === undefined && cachedInputTokens === undefined
        ? undefined
        : { inputTokens, cachedInputTokens },
    timeToFirstTokenMs: 20.1234,
    timeToFirstSemanticMs: 10.9876,
    totalLatencyMs: 40.5555,
  };
}

function exactRow({ label, requestBytes, inputTokens, cachedInputTokens }) {
  return summarizeCacheContextRound(
    testRound({ label, requestBytes, inputTokens, cachedInputTokens }),
    { contextWindow: 1_000, answerCorrect: true },
  );
}

void test('parseProbeOptions requires explicit comparable workload inputs', () => {
  assert.deepEqual(parseProbeOptions(VALID_ARGS), {
    largeLines: 12,
    linePayloadBytes: 80,
    smallResultCount: 3,
    smallLines: 4,
    sameRoundVisibleBytes: 4096,
    compactionPaddingBytes: 60000,
    cacheSettleMs: 0,
    warmControls: 2,
    evidencePageChars: 8192,
    evidenceMarkerLine: 6,
    evidenceRefCount: 3,
    targetEvidenceRef: 2,
    evidenceFreeTurns: 3,
    evidenceNeededTurns: 1,
    maxModelRounds: 4,
    policyTrials: 3,
    enumerableOnly: false,
  });
  assert.equal(
    parseProbeOptions([...VALID_ARGS, '--enumerable-only']).enumerableOnly,
    true,
  );
  assert.throws(
    () =>
      parseProbeOptions([
        ...VALID_ARGS,
        '--enumerable-only',
        '--enumerable-only',
      ]),
    { name: ProbeInputError.name },
  );
  assert.throws(() => parseProbeOptions(VALID_ARGS.slice(0, -2)), {
    name: ProbeInputError.name,
  });
  assert.throws(
    () => parseProbeOptions(VALID_ARGS.with(VALID_ARGS.indexOf('12'), '13')),
    /must equal/u,
  );
  assert.equal(
    parseProbeOptions(
      VALID_ARGS.with(VALID_ARGS.indexOf('--policy-trials') + 1, '0'),
    ).policyTrials,
    0,
  );
  assert.throws(
    () =>
      parseProbeOptions(
        VALID_ARGS.with(VALID_ARGS.indexOf('--evidence-marker-line') + 1, '13'),
      ),
    /must be <= --large-lines/u,
  );
  assert.throws(
    () =>
      parseProbeOptions(
        VALID_ARGS.with(VALID_ARGS.indexOf('--target-evidence-ref') + 1, '4'),
      ),
    /must be <= --evidence-ref-count/u,
  );
  const noTurns = VALID_ARGS.with(
    VALID_ARGS.indexOf('--evidence-free-turns') + 1,
    '0',
  ).with(VALID_ARGS.indexOf('--evidence-needed-turns') + 1, '0');
  assert.throws(() => parseProbeOptions(noTurns), /at least one/u);
});

void test('enumerable preview budget requires exact recovery when target evidence is outside the preview', () => {
  const evaluation = evaluateEnumerablePreviewBudget({
    availableModelVisibleBytes: 8_192,
    fullModelVisibleBytes: 80_000,
    projectedModelVisibleBytes: 7_900,
    projections: [
      {
        tool: 'list_files',
        targetPosition: 30,
        targetEvidenceVisible: true,
      },
      {
        tool: 'search_files',
        targetPosition: 30,
        targetEvidenceVisible: false,
      },
    ],
    snapshotsExact: true,
    recovery: {
      answerCorrect: true,
      extraModelRounds: 1,
      recoveryPageDiagnostics: [
        {
          mode: 'items',
          toolName: 'search_files',
          offset: 29,
          endOffset: 30,
          returnedItems: 1,
        },
      ],
      rows: [
        exactRow({
          label: 'enumerable recovery round 1',
          requestBytes: 10_000,
          inputTokens: 2_000,
          cachedInputTokens: 1_000,
        }),
        exactRow({
          label: 'enumerable recovery round 2',
          requestBytes: 12_000,
          inputTokens: 2_500,
          cachedInputTokens: 1_500,
        }),
      ],
    },
  });

  assert.deepEqual(evaluation, {
    status: 'passed',
    projectionWithinBudget: true,
    projectionReducesRequest: true,
    snapshotsExact: true,
    targetEvidenceVisible: false,
    recoveryTriggeredWhenRequired: true,
    toolContractOnlyRecoverySelected: true,
    exactUsageAvailable: true,
    totalInputTokens: 4_500,
    totalCachedInputTokens: 2_500,
  });
});

void test('enumerable preview budget fails when omitted target evidence is answered without recovery', () => {
  const evaluation = evaluateEnumerablePreviewBudget({
    availableModelVisibleBytes: 4_096,
    fullModelVisibleBytes: 80_000,
    projectedModelVisibleBytes: 4_000,
    projections: [
      {
        tool: 'list_files',
        targetPosition: 30,
        targetEvidenceVisible: false,
      },
      {
        tool: 'search_files',
        targetPosition: 30,
        targetEvidenceVisible: false,
      },
    ],
    snapshotsExact: true,
    recovery: {
      answerCorrect: true,
      extraModelRounds: 0,
      rows: [
        testRound({
          label: 'unsupported direct answer',
          requestBytes: 8_000,
        }),
      ].map((round) =>
        summarizeCacheContextRound(round, { contextWindow: 1_000 }),
      ),
    },
  });

  assert.equal(evaluation.status, 'failed');
  assert.equal(evaluation.recoveryTriggeredWhenRequired, false);
  assert.equal(evaluation.toolContractOnlyRecoverySelected, false);
  assert.equal(evaluation.exactUsageAvailable, false);
  assert.equal(evaluation.totalInputTokens, null);
});

void test('enumerable preview budget rejects a correct answer recovered through a non-minimal character page', () => {
  const evaluation = evaluateEnumerablePreviewBudget({
    availableModelVisibleBytes: 4_096,
    fullModelVisibleBytes: 80_000,
    projectedModelVisibleBytes: 4_000,
    projections: [
      {
        tool: 'list_files',
        targetPosition: 30,
        targetEvidenceVisible: false,
      },
    ],
    snapshotsExact: true,
    recovery: {
      answerCorrect: true,
      extraModelRounds: 1,
      recoveryPageDiagnostics: [
        {
          mode: 'characters',
          toolName: 'list_files',
          offset: 0,
          endOffset: 8_192,
          returnedItems: null,
        },
      ],
      rows: [
        exactRow({
          label: 'character recovery round 1',
          requestBytes: 10_000,
          inputTokens: 2_000,
          cachedInputTokens: 0,
        }),
        exactRow({
          label: 'character recovery round 2',
          requestBytes: 20_000,
          inputTokens: 4_000,
          cachedInputTokens: 0,
        }),
      ],
    },
  });

  assert.equal(evaluation.status, 'failed');
  assert.equal(evaluation.recoveryTriggeredWhenRequired, true);
  assert.equal(evaluation.toolContractOnlyRecoverySelected, false);
  assert.equal(evaluation.totalInputTokens, 6_000);
});

void test('recovery task records bounded provider and schema argument corrections', async () => {
  const histories = [];
  const recordedFailures = [];
  let modelRound = 0;
  const malformedArguments = '{"outputRef":';
  const schemaInvalidArguments = JSON.stringify({
    outputRef: 'tool-output:thread/run/call',
    limit: 'not-a-number',
  });
  const validArguments = JSON.stringify({
    outputRef: 'tool-output:thread/run/call',
    mode: 'items',
    offset: 6,
    limit: 1,
  });
  const live = {
    async *callModel(request) {
      modelRound += 1;
      histories.push(structuredClone(request.history));
      request.onProviderRequestPrepared({
        serializedBytes: 100 + modelRound,
        dominantPressureSource: 'history',
        serializedBytesBySource: {
          history: 70 + modelRound,
          instructions: 10,
          toolDefinitions: 10,
          envelope: 10,
        },
      });
      if (modelRound <= 3) {
        const argumentsJson =
          modelRound === 1
            ? malformedArguments
            : modelRound === 2
              ? schemaInvalidArguments
              : validArguments;
        yield {
          type: 'tool_call',
          id: `fc-invalid-recovery-${modelRound}`,
          callId: `call-invalid-recovery-${modelRound}`,
          toolName: 'read_tool_output',
          argumentsJson,
        };
        yield {
          type: 'done',
          finalText: '',
          itemsToAppend: [
            {
              kind: 'backend_item',
              data: {
                type: 'function_call',
                id: `fc-invalid-recovery-${modelRound}`,
                call_id: `call-invalid-recovery-${modelRound}`,
                name: 'read_tool_output',
                arguments: argumentsJson,
              },
            },
          ],
          providerUsageTelemetry: {
            inputTokens: 100,
            cachedInputTokens: 0,
          },
        };
        return;
      }
      yield {
        type: 'done',
        finalText: 'RECOVERED',
        itemsToAppend: [],
        providerUsageTelemetry: {
          inputTokens: 120,
          cachedInputTokens: 0,
        },
      };
    },
    parseToolCallArguments(argumentsJson) {
      if (argumentsJson === malformedArguments) {
        return {
          ok: false,
          error: {
            ok: false,
            output: '',
            errorCode: 'invalid_args',
            error: 'arguments JSON parse failed',
          },
        };
      }
      if (argumentsJson === validArguments) {
        return {
          ok: true,
          args: {
            outputRef: 'tool-output:thread/run/call',
            mode: 'items',
            offset: 6,
            limit: 1,
          },
        };
      }
      return {
        ok: true,
        args: {
          outputRef: 'tool-output:thread/run/call',
          limit: 'not-a-number',
        },
      };
    },
    async executeTool(_toolName, args) {
      if (args.mode === 'items') {
        return {
          ok: true,
          output: JSON.stringify({
            ok: true,
            toolName: 'search_files',
            mode: 'items',
            offset: 6,
            endOffset: 7,
            totalItems: 10,
            items: [{ path: 'recovered.ts' }],
          }),
        };
      }
      return {
        ok: false,
        output: '',
        errorCode: 'invalid_args',
        error: 'limit must be a number',
      };
    },
    async recordInvalidToolArguments(args) {
      recordedFailures.push(args.errorResult);
      args.history.push({
        kind: 'function_call_output',
        callId: args.functionCall.callId,
        output: JSON.stringify({
          ok: false,
          errorCode: args.errorResult.errorCode,
          error: args.errorResult.error,
        }),
      });
    },
  };

  const result = await runRecoveryTask({
    live,
    context: {
      provider: {
        webSocketSessions: undefined,
        authRuntime: undefined,
        requestOptions: {},
      },
      toolRegistry: {},
    },
    history: [],
    systemPrompt: 'test recovery',
    recoveryTools: [],
    providerReplayScopeId: 'scope-recovery',
    workspaceRoot: '/workspace',
    threadId: 'thread-recovery',
    contextWindow: 1_000,
    expectedAnswer: 'RECOVERED',
    maxModelRounds: 4,
  });

  assert.equal(result.answerCorrect, true);
  assert.equal(result.observedAnswer, 'RECOVERED');
  assert.equal(result.extraModelRounds, 3);
  assert.equal(result.invalidArgumentCorrections, 2);
  assert.deepEqual(result.invalidArgumentDiagnostics, [
    {
      modelRound: 1,
      source: 'provider_arguments',
      errorCode: 'invalid_args',
      error: 'arguments JSON parse failed',
    },
    {
      modelRound: 2,
      source: 'tool_schema',
      errorCode: 'invalid_args',
      error: 'limit must be a number',
    },
  ]);
  assert.deepEqual(result.recoveryPageDiagnostics, [
    {
      modelRound: 3,
      mode: 'items',
      toolName: 'search_files',
      offset: 6,
      endOffset: 7,
      totalUnits: 10,
      returnedItems: 1,
    },
  ]);
  assert.equal(result.rows.length, 4);
  assert.equal(recordedFailures.length, 2);
  assert.equal(histories.length, 4);
  const retryResults = histories[3].filter(
    (item) => item.kind === 'function_call_output',
  );
  assert.equal(retryResults.length, 3);
  assert.deepEqual(JSON.parse(retryResults[0].output), {
    ok: false,
    errorCode: 'invalid_args',
    error: 'arguments JSON parse failed',
  });
  assert.deepEqual(JSON.parse(retryResults[1].output), {
    ok: false,
    errorCode: 'invalid_args',
    error: 'limit must be a number',
  });
  assert.deepEqual(JSON.parse(retryResults[2].output), {
    ok: true,
    toolName: 'search_files',
    mode: 'items',
    offset: 6,
    endOffset: 7,
    totalItems: 10,
    items: [{ path: 'recovered.ts' }],
  });
});

void test('evidence page selection keeps early, middle, and late markers in one bounded page', () => {
  const marker = 'EXACT_MARKER';
  for (const output of [
    `${marker}${'x'.repeat(100)}`,
    `${'x'.repeat(50)}${marker}${'x'.repeat(50)}`,
    `${'x'.repeat(100)}${marker}`,
  ]) {
    const page = selectEvidencePageWindow({ output, marker, limit: 32 });
    assert.equal(page.content.length, 32);
    assert.equal(page.content.includes(marker), true);
    assert.equal(page.endOffset - page.offset, 32);
    assert.equal(page.totalChars, output.length);
    assert.equal(page.markerOffset, output.indexOf(marker));
  }
  assert.throws(
    () => selectEvidencePageWindow({ output: 'no marker', marker, limit: 32 }),
    /marker is absent/u,
  );
  assert.throws(
    () => selectEvidencePageWindow({ output: marker, marker, limit: 3 }),
    /large enough for the marker/u,
  );
});

void test('independent evidence workload charges compaction once and preserves explicit turn mix', () => {
  const workload = evaluateIndependentEvidenceWorkload({
    evidenceFreeTurns: 3,
    evidenceNeededTurns: 1,
    referenceNoEvidence: 1_000,
    referenceEvidenceNeeded: 3_000,
    expandedNoEvidence: 1_500,
    expandedEvidenceNeeded: 1_800,
    referenceCompactionInputTokens: 100,
    expandedCompactionInputTokens: 600,
  });

  assert.equal(workload.evidenceNeededShare, 0.25);
  assert.deepEqual(workload.observedInputTokens, {
    referenceOnly: 6_100,
    selectivelyExpanded: 6_900,
    selectivelyExpandedMinusReferenceOnly: 800,
  });
  assert.equal(workload.decision, 'reference_only_lower_input');
  assert.equal(workload.amortizedBreakEvenEvidenceNeedProbability, 0.367647);
});

void test('compaction policy pilot advances only a candidate that clears fidelity after the baseline fails', () => {
  const policyTrial = ({ exactAnswer, requestBytes, inputTokens }) => ({
    row: exactRow({
      label: 'policy trial',
      requestBytes,
      inputTokens,
      cachedInputTokens: 0,
    }),
    fidelity: { exactAnswer },
  });
  const evaluation = evaluateCompactionPolicyTrials({
    baselineTrials: [
      policyTrial({ exactAnswer: false, requestBytes: 600, inputTokens: 150 }),
      policyTrial({ exactAnswer: true, requestBytes: 620, inputTokens: 155 }),
      policyTrial({ exactAnswer: false, requestBytes: 610, inputTokens: 152 }),
    ],
    candidateTrials: [
      policyTrial({ exactAnswer: true, requestBytes: 640, inputTokens: 160 }),
      policyTrial({ exactAnswer: true, requestBytes: 630, inputTokens: 158 }),
      policyTrial({ exactAnswer: true, requestBytes: 650, inputTokens: 162 }),
    ],
  });

  assert.equal(
    evaluation.decision,
    'advance_candidate_to_fresh_process_validation',
  );
  assert.deepEqual(evaluation.baseline, {
    trialCount: 3,
    exactPassCount: 1,
    allHardGatesPassed: false,
    medianRequestBytes: 610,
    medianInputTokens: 152,
    medianUncachedInputTokens: 152,
  });
  assert.equal(evaluation.candidate.allHardGatesPassed, true);
  assert.equal(evaluation.promotionAllowed, false);
});

void test('compaction policy pilot discards candidates that fail fidelity or add no measured fidelity gain', () => {
  const policyTrial = (exactAnswer) => ({
    row: exactRow({
      label: 'policy trial',
      requestBytes: 600,
      inputTokens: 150,
      cachedInputTokens: 20,
    }),
    fidelity: { exactAnswer },
  });
  assert.equal(
    evaluateCompactionPolicyTrials({
      baselineTrials: [policyTrial(true)],
      candidateTrials: [policyTrial(false)],
    }).decision,
    'discard_candidate_hard_gate_failure',
  );
  assert.equal(
    evaluateCompactionPolicyTrials({
      baselineTrials: [policyTrial(true)],
      candidateTrials: [policyTrial(true)],
    }).decision,
    'discard_candidate_no_measured_fidelity_gain',
  );
  assert.throws(
    () =>
      evaluateCompactionPolicyTrials({
        baselineTrials: [],
        candidateTrials: [],
      }),
    ProbeInputError,
  );
});

void test('evidence selection reports the observed break-even without choosing a product probability', () => {
  const condition = (inputTokens, { answerCorrect = true } = {}) => ({
    rows: [
      exactRow({
        label: 'evidence selection',
        requestBytes: inputTokens * 2,
        inputTokens,
        cachedInputTokens: 0,
      }),
    ],
    answerCorrect,
  });
  const evaluation = evaluateEvidenceSelectionTradeoff({
    referenceOnlyNoEvidence: condition(1_000),
    referenceOnlyEvidenceNeeded: {
      rows: [condition(1_400).rows[0], condition(1_600).rows[0]],
      answerCorrect: true,
    },
    selectivelyExpandedNoEvidence: condition(1_500),
    selectivelyExpandedEvidenceNeeded: condition(1_800),
    referenceOnlyCompactionInputBytes: 10_000,
    selectivelyExpandedCompactionInputBytes: 30_000,
    referenceOnlyCompactionUsage: {
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 0,
    },
    selectivelyExpandedCompactionUsage: {
      inputTokens: 600,
      outputTokens: 50,
      cachedInputTokens: 100,
    },
    evidenceFreeTurns: 3,
    evidenceNeededTurns: 1,
  });

  assert.equal(evaluation.status, 'break_even_observed');
  assert.equal(
    evaluation.continuationOnlyBreakEvenEvidenceNeedProbability,
    0.294118,
  );
  assert.equal(evaluation.referenceOnlyPreferredBelowBreakEven, true);
  assert.deepEqual(evaluation.expectedInputTokens, {
    referenceOnly: { intercept: 1_000, evidenceNeedIncrement: 2_000 },
    selectivelyExpanded: { intercept: 1_500, evidenceNeedIncrement: 300 },
  });
  assert.deepEqual(evaluation.compactionInput, {
    measurement:
      'model-visible history, instructions, and tool-definition component bytes',
    referenceOnlyBytes: 10_000,
    selectivelyExpandedBytes: 30_000,
    selectivelyExpandedByteDelta: 20_000,
  });
  assert.deepEqual(evaluation.providerCompactionUsage, {
    referenceOnly: {
      availability: 'exact',
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 0,
    },
    selectivelyExpanded: {
      availability: 'exact',
      inputTokens: 600,
      outputTokens: 50,
      cachedInputTokens: 100,
    },
  });
  assert.equal(evaluation.inclusiveStatus, 'break_even_observed');
  assert.deepEqual(evaluation.inclusiveExpectedInputTokens, {
    referenceOnly: { intercept: 1_100, evidenceNeedIncrement: 2_000 },
    selectivelyExpanded: { intercept: 2_100, evidenceNeedIncrement: 300 },
  });
  assert.equal(evaluation.inclusiveBreakEvenEvidenceNeedProbability, 0.588235);
  assert.equal(evaluation.referenceOnlyPreferredBelowInclusiveBreakEven, true);
  assert.equal(evaluation.providerCompactionUsageIncluded, true);
  assert.deepEqual(evaluation.independentTurnWorkload.observedInputTokens, {
    referenceOnly: 6_100,
    selectivelyExpanded: 6_900,
    selectivelyExpandedMinusReferenceOnly: 800,
  });
  assert.equal(
    evaluation.independentTurnWorkload
      .amortizedBreakEvenEvidenceNeedProbability,
    0.367647,
  );
  assert.equal(evaluation.productPolicyChanged, false);
});

void test('evidence selection refuses efficiency conclusions when fidelity or exact usage is absent', () => {
  const exactCondition = {
    rows: [
      exactRow({
        label: 'exact',
        requestBytes: 100,
        inputTokens: 50,
        cachedInputTokens: 0,
      }),
    ],
    answerCorrect: true,
  };
  const failedFidelity = evaluateEvidenceSelectionTradeoff({
    referenceOnlyNoEvidence: exactCondition,
    referenceOnlyEvidenceNeeded: exactCondition,
    selectivelyExpandedNoEvidence: exactCondition,
    selectivelyExpandedEvidenceNeeded: {
      ...exactCondition,
      answerCorrect: false,
    },
    referenceOnlyCompactionInputBytes: 10,
    selectivelyExpandedCompactionInputBytes: 20,
    evidenceFreeTurns: 3,
    evidenceNeededTurns: 1,
  });
  assert.equal(failedFidelity.status, 'fidelity_gate_failed');
  assert.equal(
    failedFidelity.continuationOnlyBreakEvenEvidenceNeedProbability,
    null,
  );

  const unavailableCondition = {
    rows: [
      summarizeCacheContextRound(
        testRound({ label: 'usage unavailable', requestBytes: 100 }),
        { contextWindow: 1_000, answerCorrect: true },
      ),
    ],
    answerCorrect: true,
  };
  const unavailable = evaluateEvidenceSelectionTradeoff({
    referenceOnlyNoEvidence: unavailableCondition,
    referenceOnlyEvidenceNeeded: exactCondition,
    selectivelyExpandedNoEvidence: exactCondition,
    selectivelyExpandedEvidenceNeeded: exactCondition,
    referenceOnlyCompactionInputBytes: 10,
    selectivelyExpandedCompactionInputBytes: 20,
    evidenceFreeTurns: 3,
    evidenceNeededTurns: 1,
  });
  assert.equal(unavailable.status, 'inconclusive_usage');
  assert.equal(unavailable.exactInputUsageAvailable, false);

  const missingCompactionUsage = evaluateEvidenceSelectionTradeoff({
    referenceOnlyNoEvidence: exactCondition,
    referenceOnlyEvidenceNeeded: exactCondition,
    selectivelyExpandedNoEvidence: exactCondition,
    selectivelyExpandedEvidenceNeeded: exactCondition,
    referenceOnlyCompactionInputBytes: 10,
    selectivelyExpandedCompactionInputBytes: 20,
    evidenceFreeTurns: 3,
    evidenceNeededTurns: 1,
  });
  assert.equal(missingCompactionUsage.status, 'equivalent_observed_endpoints');
  assert.equal(
    missingCompactionUsage.inclusiveStatus,
    'compaction_usage_unavailable',
  );
  assert.equal(
    missingCompactionUsage.inclusiveBreakEvenEvidenceNeedProbability,
    null,
  );
  assert.equal(missingCompactionUsage.providerCompactionUsageIncluded, false);
});

void test('provider-native same-round expansion preserves one reasoning item and creates unique calls', () => {
  const replayScopeId = 'sha256:test-replay-scope';
  const expanded = expandProviderNativeFunctionCallBatch(
    {
      historyPrefix: [
        { kind: 'user', text: 'read once' },
        {
          kind: 'backend_item',
          providerReplayScopeId: replayScopeId,
          data: {
            type: 'reasoning',
            id: 'reasoning-1',
            encrypted_content: 'opaque',
          },
        },
        {
          kind: 'backend_item',
          providerReplayScopeId: replayScopeId,
          data: {
            type: 'function_call',
            id: 'fc-source',
            call_id: 'call-source',
            name: 'read_file',
            arguments: '{"path":"source"}',
          },
        },
      ],
      providerReplayScopeId: replayScopeId,
      functionCalls: [
        {
          id: 'fc-source',
          callId: 'call-source',
          name: 'read_file',
          arguments: '{"path":"source"}',
        },
      ],
    },
    [
      { path: 'one', offset: 0, limit: 10 },
      { path: 'two', offset: 10, limit: 10 },
      { path: 'three', offset: 20, limit: 10 },
    ],
  );

  assert.equal(
    expanded.historyPrefix.filter(
      (item) => item.kind === 'backend_item' && item.data.type === 'reasoning',
    ).length,
    1,
  );
  assert.equal(
    expanded.historyPrefix.filter(
      (item) =>
        item.kind === 'backend_item' && item.data.type === 'function_call',
    ).length,
    3,
  );
  assert.equal(
    expanded.historyPrefix.some((item) => item.kind === 'function_call'),
    false,
  );
  assert.equal(new Set(expanded.functionCalls.map((call) => call.id)).size, 3);
  assert.equal(
    new Set(expanded.functionCalls.map((call) => call.callId)).size,
    3,
  );
  assert.equal(
    expanded.functionCalls.every((call) => call.name === 'read_file'),
    true,
  );
});

void test('summarizeCacheContextRound keeps cache and occupancy as separate exact axes', () => {
  const summary = exactRow({
    label: 'exact',
    requestBytes: 400,
    inputTokens: 100,
    cachedInputTokens: 60,
  });

  assert.deepEqual(summary.cache, {
    availability: 'exact',
    inputTokens: 100,
    cachedInputTokens: 60,
    uncachedInputTokens: 40,
    hitRatio: 0.6,
  });
  assert.deepEqual(summary.context, {
    availability: 'exact',
    contextWindow: 1_000,
    inputTokens: 100,
    occupancyRatio: 0.1,
  });
  assert.deepEqual(summary.timing, {
    timeToFirstTokenMs: 20.123,
    timeToFirstSemanticMs: 10.988,
    totalLatencyMs: 40.556,
  });
});

void test('summarizeCacheContextRound does not invent usage or occupancy', () => {
  const summary = summarizeCacheContextRound(
    testRound({ label: 'missing', requestBytes: 400 }),
    { contextWindow: 1_000 },
  );

  assert.deepEqual(summary.cache, {
    availability: 'unavailable',
    inputTokens: null,
    cachedInputTokens: null,
    uncachedInputTokens: null,
    hitRatio: null,
  });
  assert.deepEqual(summary.context, {
    availability: 'unavailable',
    contextWindow: 1_000,
    inputTokens: null,
    occupancyRatio: null,
  });
});

void test('exact-answer diagnostics classify fidelity loss without retaining answer content', () => {
  const expected = 'MARKER=secret;TOTAL_LINES=600';

  assert.deepEqual(
    summarizeExactAnswerDiagnostic(`  ${expected}\n`, expected),
    {
      status: 'exact',
      answerCorrect: true,
      normalizedActualChars: 29,
      expectedChars: 29,
      characterDelta: 0,
      expectedFieldCount: 2,
      matchedExpectedFieldCount: 2,
      expectedAnswerContained: true,
      allExpectedFieldsPresent: true,
    },
  );
  assert.deepEqual(summarizeExactAnswerDiagnostic(`${expected}.`, expected), {
    status: 'expected_answer_with_extra_text',
    answerCorrect: false,
    normalizedActualChars: 30,
    expectedChars: 29,
    characterDelta: 1,
    expectedFieldCount: 2,
    matchedExpectedFieldCount: 2,
    expectedAnswerContained: true,
    allExpectedFieldsPresent: true,
  });
  assert.equal(
    summarizeExactAnswerDiagnostic('TOTAL_LINES=600;MARKER=secret', expected)
      .status,
    'all_fields_present_noncanonical',
  );
  assert.equal(
    summarizeExactAnswerDiagnostic('TOTAL_LINES=600', expected).status,
    'partial_fields',
  );
  assert.equal(
    summarizeExactAnswerDiagnostic('NO_EVIDENCE', expected).status,
    'expected_fields_missing',
  );
});

void test('comparison reports projection savings and an observed retroactive prefix separately', () => {
  const fullRows = [
    exactRow({
      label: 'full cold',
      requestBytes: 800,
      inputTokens: 200,
      cachedInputTokens: 0,
    }),
    exactRow({
      label: 'full warm 1',
      requestBytes: 800,
      inputTokens: 200,
      cachedInputTokens: 180,
    }),
    exactRow({
      label: 'full warm 2',
      requestBytes: 800,
      inputTokens: 200,
      cachedInputTokens: 160,
    }),
  ];
  const slimRows = [
    exactRow({
      label: 'slim cold',
      requestBytes: 500,
      inputTokens: 120,
      cachedInputTokens: 0,
    }),
    exactRow({
      label: 'slim warm 1',
      requestBytes: 500,
      inputTokens: 120,
      cachedInputTokens: 100,
    }),
    exactRow({
      label: 'slim warm 2',
      requestBytes: 500,
      inputTokens: 120,
      cachedInputTokens: 110,
    }),
  ];
  const retroactiveTailRow = exactRow({
    label: 'changed tail',
    requestBytes: 500,
    inputTokens: 120,
    cachedInputTokens: 80,
  });

  assert.deepEqual(selectWarmCacheControl(slimRows), {
    availability: 'exact',
    cachedInputTokens: 110,
  });
  assert.deepEqual(
    evaluateCacheContextComparison({
      fullRows,
      slimRows,
      retroactiveTailRow,
    }),
    {
      status: 'passed',
      projectionReducesRequest: true,
      projectionReducesOccupancy: true,
      requestBytesSaved: 300,
      inputTokensSaved: 80,
      fullWarmCache: {
        availability: 'exact',
        cachedInputTokens: 180,
      },
      slimWarmCache: {
        availability: 'exact',
        cachedInputTokens: 110,
      },
      diagnosticRetroactiveTail: {
        expectedBoundary:
          'stable prefix before the changed function_call_output tail',
        observed: 'observed_stable_prefix',
        cachedInputTokens: 80,
      },
    },
  );
});

void test('comparison reports unavailable cache evidence as inconclusive', () => {
  const full = exactRow({
    label: 'full',
    requestBytes: 800,
    inputTokens: 200,
    cachedInputTokens: 0,
  });
  const slim = exactRow({
    label: 'slim',
    requestBytes: 500,
    inputTokens: 120,
    cachedInputTokens: 0,
  });
  const unavailable = summarizeCacheContextRound(
    testRound({ label: 'unavailable', requestBytes: 500 }),
    { contextWindow: 1_000 },
  );

  const comparison = evaluateCacheContextComparison({
    fullRows: [full, full, full],
    slimRows: [slim, slim, slim],
    retroactiveTailRow: unavailable,
  });
  assert.equal(comparison.status, 'inconclusive');
  assert.equal(
    comparison.diagnosticRetroactiveTail.observed,
    'usage_unavailable',
  );
});

void test('a one-shot retroactive-tail cache miss stays diagnostic when paired controls hit', () => {
  const fullCold = exactRow({
    label: 'full cold',
    requestBytes: 800,
    inputTokens: 200,
    cachedInputTokens: 0,
  });
  const fullWarm = exactRow({
    label: 'full warm',
    requestBytes: 800,
    inputTokens: 200,
    cachedInputTokens: 180,
  });
  const slimCold = exactRow({
    label: 'slim cold',
    requestBytes: 500,
    inputTokens: 120,
    cachedInputTokens: 0,
  });
  const slimWarm = exactRow({
    label: 'slim warm',
    requestBytes: 500,
    inputTokens: 120,
    cachedInputTokens: 100,
  });

  const comparison = evaluateCacheContextComparison({
    fullRows: [fullCold, fullWarm, fullWarm],
    slimRows: [slimCold, slimWarm, slimWarm],
    retroactiveTailRow: slimCold,
  });
  assert.equal(comparison.status, 'passed');
  assert.equal(
    comparison.diagnosticRetroactiveTail.observed,
    'provider_cache_miss',
  );
});

void test('checkpoint cache reuse separates exact local prefix continuity from provider hit observation', () => {
  const identity = buildCheckpointCacheReuseIdentity({
    baseWireInput: [{ role: 'user', content: 'question' }],
    appendWireInput: [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'continue' },
    ],
    baseCacheTrace: {
      cacheKeyHash: 'cache-key',
      stablePrefixFingerprint: 'stable-prefix',
    },
    appendCacheTrace: {
      cacheKeyHash: 'cache-key',
      stablePrefixFingerprint: 'stable-prefix',
    },
    baseReplayScopeId: 'scope-a',
    appendReplayScopeId: 'scope-a',
  });
  assert.equal(identity.localInvariantPassed, true);
  assert.equal(identity.appendExtendsBaseWireInput, true);
  assert.equal(identity.baseWireInputHash, identity.appendPrefixHash);
  assert.notEqual(identity.baseWireInputHash, identity.appendWireInputHash);

  assert.deepEqual(
    evaluateCheckpointCacheReuseEvidence({
      identity,
      baseWarm: { availability: 'exact', cachedInputTokens: 2_048 },
      appendWarm: { availability: 'exact', cachedInputTokens: 0 },
    }),
    {
      status: 'provider_cache_not_observed',
      productInvariantPassed: true,
      providerObservation: 'not_observed',
      providerCacheObserved: false,
      baseCacheObserved: true,
      appendCacheObserved: false,
      identity,
      baseWarm: { availability: 'exact', cachedInputTokens: 2_048 },
      appendWarm: { availability: 'exact', cachedInputTokens: 0 },
    },
  );
});

void test('checkpoint cache reuse rejects a changed local prefix even when cache telemetry is present', () => {
  const identity = buildCheckpointCacheReuseIdentity({
    baseWireInput: [{ role: 'user', content: 'question' }],
    appendWireInput: [
      { role: 'user', content: 'changed question' },
      { role: 'assistant', content: 'answer' },
    ],
    baseCacheTrace: {
      cacheKeyHash: 'cache-key',
      stablePrefixFingerprint: 'stable-prefix',
    },
    appendCacheTrace: {
      cacheKeyHash: 'cache-key',
      stablePrefixFingerprint: 'stable-prefix',
    },
    baseReplayScopeId: 'scope-a',
    appendReplayScopeId: 'scope-a',
  });
  assert.equal(identity.localInvariantPassed, false);
  assert.equal(identity.appendExtendsBaseWireInput, false);

  const evaluation = evaluateCheckpointCacheReuseEvidence({
    identity,
    baseWarm: { availability: 'exact', cachedInputTokens: 2_048 },
    appendWarm: { availability: 'exact', cachedInputTokens: 2_048 },
  });
  assert.equal(evaluation.status, 'local_prefix_drift');
  assert.equal(evaluation.productInvariantPassed, false);
  assert.equal(evaluation.providerCacheObserved, true);
});
