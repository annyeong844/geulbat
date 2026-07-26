#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE_OPT_IN_ENV = 'GEULBAT_TOOL_RESULT_CACHE_CONTEXT_PROBE';
const SCHEMA_VERSION = 'tool_result_cache_context_probe_v10';
const COMPACTION_POLICY_CANDIDATE_INSTRUCTIONS = `This diagnostic compaction candidate is evaluated on continuation fidelity before token, cache, or latency efficiency.

Treat every user-authored requirement that was not explicitly revoked as an active constraint. Preserve exact required output formats, negative constraints, confirmed decisions, exact paths and identifiers, unresolved work, and the evidence references needed to continue correctly. Do not infer revocation from later setup text, repetition, or filler. Prefer removing repeated explanations and low-value filler before any active constraint or grounding evidence. The continuation must be able to obey the retained requirements without seeing the original prefix.`;
const INTEGER_OPTIONS = Object.freeze({
  '--large-lines': { key: 'largeLines', minimum: 1 },
  '--line-payload-bytes': { key: 'linePayloadBytes', minimum: 1 },
  '--small-result-count': { key: 'smallResultCount', minimum: 2 },
  '--small-lines': { key: 'smallLines', minimum: 1 },
  '--same-round-visible-bytes': {
    key: 'sameRoundVisibleBytes',
    minimum: 1,
  },
  '--compaction-padding-bytes': {
    key: 'compactionPaddingBytes',
    minimum: 1,
  },
  '--cache-settle-ms': { key: 'cacheSettleMs', minimum: 0 },
  '--warm-controls': { key: 'warmControls', minimum: 2 },
  '--evidence-page-chars': { key: 'evidencePageChars', minimum: 1 },
  '--evidence-marker-line': { key: 'evidenceMarkerLine', minimum: 1 },
  '--evidence-ref-count': { key: 'evidenceRefCount', minimum: 1 },
  '--target-evidence-ref': { key: 'targetEvidenceRef', minimum: 1 },
  '--evidence-free-turns': { key: 'evidenceFreeTurns', minimum: 0 },
  '--evidence-needed-turns': { key: 'evidenceNeededTurns', minimum: 0 },
  '--max-model-rounds': { key: 'maxModelRounds', minimum: 2 },
  '--policy-trials': { key: 'policyTrials', minimum: 0 },
});
const ENUMERABLE_ONLY_FLAG = '--enumerable-only';
const USAGE = [
  'Usage:',
  `  ${LIVE_OPT_IN_ENV}=1 npm run probe:tool-result-cache-context -w apps/daemon -- \\`,
  ...Object.keys(INTEGER_OPTIONS).map(
    (name, index, names) =>
      `    ${name} <integer>${index === names.length - 1 ? ` [${ENUMERABLE_ONLY_FLAG}]` : ' \\'}`,
  ),
  '',
  'The probe is diagnostic-only. Every workload size, cache pause, and loop',
  'bound is explicit input and does not define a product policy.',
].join('\n');

export class ProbeInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeInputError';
  }
}

export function parseProbeOptions(argv) {
  const values = new Map();
  let enumerableOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === ENUMERABLE_ONLY_FLAG && !enumerableOnly) {
      enumerableOnly = true;
      continue;
    }
    const descriptor = INTEGER_OPTIONS[name];
    if (descriptor === undefined || values.has(name)) {
      throw new ProbeInputError(USAGE);
    }
    const raw = argv[index + 1];
    if (raw === undefined || !/^\d+$/u.test(raw)) {
      throw new ProbeInputError(`${name} requires an integer`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < descriptor.minimum) {
      throw new ProbeInputError(
        `${name} must be a safe integer >= ${descriptor.minimum}`,
      );
    }
    values.set(name, value);
    index += 1;
  }

  if (values.size !== Object.keys(INTEGER_OPTIONS).length) {
    throw new ProbeInputError(USAGE);
  }

  const options = {};
  for (const [name, descriptor] of Object.entries(INTEGER_OPTIONS)) {
    options[descriptor.key] = values.get(name);
  }
  if (options.largeLines !== options.smallResultCount * options.smallLines) {
    throw new ProbeInputError(
      '--large-lines must equal --small-result-count * --small-lines',
    );
  }
  if (options.evidenceMarkerLine > options.largeLines) {
    throw new ProbeInputError(
      '--evidence-marker-line must be <= --large-lines',
    );
  }
  if (options.targetEvidenceRef > options.evidenceRefCount) {
    throw new ProbeInputError(
      '--target-evidence-ref must be <= --evidence-ref-count',
    );
  }
  if (options.evidenceFreeTurns + options.evidenceNeededTurns === 0) {
    throw new ProbeInputError(
      'at least one of --evidence-free-turns or --evidence-needed-turns must be greater than zero',
    );
  }
  return { ...options, enumerableOnly };
}

function roundMetric(value, digits = 3) {
  if (value === null || value === undefined) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function readUsageMetric(telemetry, key) {
  const value = telemetry?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function summarizeCacheContextRound(
  round,
  { contextWindow, modelRounds = 1, answerCorrect = null } = {},
) {
  const inputTokens = readUsageMetric(
    round.providerUsageTelemetry,
    'inputTokens',
  );
  const cachedInputTokens = readUsageMetric(
    round.providerUsageTelemetry,
    'cachedInputTokens',
  );
  const exactCacheUsage = inputTokens !== null && cachedInputTokens !== null;
  const uncachedInputTokens = exactCacheUsage
    ? Math.max(0, inputTokens - cachedInputTokens)
    : null;
  const cacheHitRatio =
    exactCacheUsage && inputTokens > 0 ? cachedInputTokens / inputTokens : null;
  const exactContextUsage =
    inputTokens !== null &&
    Number.isSafeInteger(contextWindow) &&
    contextWindow > 0;

  return {
    label: round.label,
    request: {
      serializedBytes: round.requestMeasurement.serializedBytes,
      dominantPressureSource: round.requestMeasurement.dominantPressureSource,
      serializedBytesBySource: {
        ...round.requestMeasurement.serializedBytesBySource,
      },
      preparationCount: round.requestPreparationCount,
    },
    cache: {
      availability: exactCacheUsage ? 'exact' : 'unavailable',
      inputTokens,
      cachedInputTokens,
      uncachedInputTokens,
      hitRatio: roundMetric(cacheHitRatio, 6),
    },
    context: {
      availability: exactContextUsage ? 'exact' : 'unavailable',
      contextWindow:
        Number.isSafeInteger(contextWindow) && contextWindow > 0
          ? contextWindow
          : null,
      inputTokens,
      occupancyRatio: exactContextUsage
        ? roundMetric(inputTokens / contextWindow, 6)
        : null,
    },
    timing: {
      timeToFirstTokenMs: roundMetric(round.timeToFirstTokenMs),
      timeToFirstSemanticMs: roundMetric(round.timeToFirstSemanticMs),
      totalLatencyMs: roundMetric(round.totalLatencyMs),
    },
    modelRounds,
    answerCorrect,
  };
}

export function summarizeExactAnswerDiagnostic(actual, expected) {
  const normalizedActual = actual.trim();
  const expectedFields = expected.split(';').filter((field) => field !== '');
  const matchedExpectedFieldCount = expectedFields.filter((field) =>
    normalizedActual.includes(field),
  ).length;
  const expectedAnswerContained = normalizedActual.includes(expected);
  const allExpectedFieldsPresent =
    matchedExpectedFieldCount === expectedFields.length;
  const status =
    normalizedActual === expected
      ? 'exact'
      : expectedAnswerContained
        ? 'expected_answer_with_extra_text'
        : allExpectedFieldsPresent
          ? 'all_fields_present_noncanonical'
          : matchedExpectedFieldCount > 0
            ? 'partial_fields'
            : 'expected_fields_missing';

  return {
    status,
    answerCorrect: status === 'exact',
    normalizedActualChars: normalizedActual.length,
    expectedChars: expected.length,
    characterDelta: normalizedActual.length - expected.length,
    expectedFieldCount: expectedFields.length,
    matchedExpectedFieldCount,
    expectedAnswerContained,
    allExpectedFieldsPresent,
  };
}

export function selectWarmCacheControl(rows) {
  const warmRows = rows.slice(1);
  if (warmRows.length === 0) {
    return { availability: 'unavailable', cachedInputTokens: null };
  }
  const exactRows = warmRows.filter(
    (row) => row.cache.availability === 'exact',
  );
  if (exactRows.length !== warmRows.length) {
    return { availability: 'unavailable', cachedInputTokens: null };
  }
  return exactRows.reduce(
    (best, row) =>
      (row.cache.cachedInputTokens ?? 0) > best.cachedInputTokens
        ? {
            availability: 'exact',
            cachedInputTokens: row.cache.cachedInputTokens ?? 0,
          }
        : best,
    { availability: 'exact', cachedInputTokens: 0 },
  );
}

export function buildCheckpointCacheReuseIdentity({
  baseWireInput,
  appendWireInput,
  baseCacheTrace,
  appendCacheTrace,
  baseReplayScopeId,
  appendReplayScopeId,
}) {
  const baseWireInputJson = JSON.stringify(baseWireInput);
  const appendWireInputJson = JSON.stringify(appendWireInput);
  const appendPrefixJson = JSON.stringify(
    appendWireInput.slice(0, baseWireInput.length),
  );
  const baseReplayScopeHash = hashProbeValue(baseReplayScopeId);
  const appendReplayScopeHash = hashProbeValue(appendReplayScopeId);
  const promptCacheKeyMatched =
    typeof baseCacheTrace?.cacheKeyHash === 'string' &&
    baseCacheTrace.cacheKeyHash !== '' &&
    baseCacheTrace.cacheKeyHash === appendCacheTrace?.cacheKeyHash;
  const stablePrefixFingerprintMatched =
    typeof baseCacheTrace?.stablePrefixFingerprint === 'string' &&
    baseCacheTrace.stablePrefixFingerprint !== '' &&
    baseCacheTrace.stablePrefixFingerprint ===
      appendCacheTrace?.stablePrefixFingerprint;
  const replayScopeMatched = baseReplayScopeHash === appendReplayScopeHash;
  const appendExtendsBaseWireInput =
    appendWireInput.length >= baseWireInput.length &&
    baseWireInputJson === appendPrefixJson;

  return {
    baseWireInputHash: hashProbeValue(baseWireInputJson),
    appendWireInputHash: hashProbeValue(appendWireInputJson),
    appendPrefixHash: hashProbeValue(appendPrefixJson),
    baseWireInputItems: baseWireInput.length,
    appendWireInputItems: appendWireInput.length,
    promptCacheKeyHash: baseCacheTrace?.cacheKeyHash ?? null,
    stablePrefixFingerprint: baseCacheTrace?.stablePrefixFingerprint ?? null,
    replayScopeHash: baseReplayScopeHash,
    appendExtendsBaseWireInput,
    promptCacheKeyMatched,
    stablePrefixFingerprintMatched,
    replayScopeMatched,
    localInvariantPassed:
      appendExtendsBaseWireInput &&
      promptCacheKeyMatched &&
      stablePrefixFingerprintMatched &&
      replayScopeMatched,
  };
}

export function evaluateCheckpointCacheReuseEvidence({
  identity,
  baseWarm,
  appendWarm,
}) {
  const exactUsageAvailable =
    baseWarm.availability === 'exact' &&
    appendWarm.availability === 'exact' &&
    typeof baseWarm.cachedInputTokens === 'number' &&
    typeof appendWarm.cachedInputTokens === 'number';
  const baseCacheObserved =
    exactUsageAvailable && (baseWarm.cachedInputTokens ?? 0) > 0;
  const appendCacheObserved =
    exactUsageAvailable && (appendWarm.cachedInputTokens ?? 0) > 0;
  const providerCacheObserved = baseCacheObserved && appendCacheObserved;
  const providerObservation = !exactUsageAvailable
    ? 'unavailable'
    : providerCacheObserved
      ? 'observed'
      : 'not_observed';

  return {
    status: !identity.localInvariantPassed
      ? 'local_prefix_drift'
      : providerObservation === 'observed'
        ? 'cache_reuse_observed'
        : providerObservation === 'unavailable'
          ? 'provider_usage_unavailable'
          : 'provider_cache_not_observed',
    productInvariantPassed: identity.localInvariantPassed,
    providerObservation,
    providerCacheObserved,
    baseCacheObserved,
    appendCacheObserved,
    identity,
    baseWarm,
    appendWarm,
  };
}

function hashProbeValue(value) {
  if (value === undefined) return null;
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

export function evaluateCacheContextComparison({
  fullRows,
  slimRows,
  retroactiveTailRow,
}) {
  const full = fullRows[0];
  const slim = slimRows[0];
  if (full === undefined || slim === undefined) {
    throw new ProbeInputError('comparison requires full and slim rows');
  }
  const fullWarm = selectWarmCacheControl(fullRows);
  const slimWarm = selectWarmCacheControl(slimRows);
  const projectionReducesRequest =
    slim.request.serializedBytes < full.request.serializedBytes;
  const exactOccupancyComparable =
    full.context.availability === 'exact' &&
    slim.context.availability === 'exact';
  const projectionReducesOccupancy = exactOccupancyComparable
    ? (slim.context.inputTokens ?? Number.POSITIVE_INFINITY) <
      (full.context.inputTokens ?? Number.NEGATIVE_INFINITY)
    : null;
  const warmCacheObserved =
    fullWarm.availability === 'exact' &&
    slimWarm.availability === 'exact' &&
    fullWarm.cachedInputTokens > 0 &&
    slimWarm.cachedInputTokens > 0;
  const retroactiveBoundary =
    retroactiveTailRow.cache.availability === 'exact'
      ? (retroactiveTailRow.cache.cachedInputTokens ?? 0) > 0
        ? 'observed_stable_prefix'
        : 'provider_cache_miss'
      : 'usage_unavailable';
  const status =
    !projectionReducesRequest || projectionReducesOccupancy === false
      ? 'failed'
      : projectionReducesOccupancy === null || !warmCacheObserved
        ? 'inconclusive'
        : 'passed';

  return {
    status,
    projectionReducesRequest,
    projectionReducesOccupancy,
    requestBytesSaved:
      full.request.serializedBytes - slim.request.serializedBytes,
    inputTokensSaved: exactOccupancyComparable
      ? (full.context.inputTokens ?? 0) - (slim.context.inputTokens ?? 0)
      : null,
    fullWarmCache: fullWarm,
    slimWarmCache: slimWarm,
    diagnosticRetroactiveTail: {
      expectedBoundary:
        'stable prefix before the changed function_call_output tail',
      observed: retroactiveBoundary,
      cachedInputTokens: retroactiveTailRow.cache.cachedInputTokens,
    },
  };
}

export function evaluateEnumerablePreviewBudget({
  availableModelVisibleBytes,
  fullModelVisibleBytes,
  projectedModelVisibleBytes,
  projections,
  snapshotsExact,
  recovery,
}) {
  const projectionWithinBudget =
    projectedModelVisibleBytes <= availableModelVisibleBytes;
  const projectionReducesRequest =
    projectedModelVisibleBytes < fullModelVisibleBytes;
  const targetEvidenceVisible = projections.every(
    (projection) => projection.targetEvidenceVisible,
  );
  const recoveryTriggeredWhenRequired =
    targetEvidenceVisible || recovery.extraModelRounds > 0;
  const hiddenProjections = projections.filter(
    (projection) => !projection.targetEvidenceVisible,
  );
  const recoveryPageDiagnostics = recovery.recoveryPageDiagnostics ?? [];
  const toolContractOnlyRecoverySelected =
    hiddenProjections.length === 0 ||
    (recoveryPageDiagnostics.length === hiddenProjections.length &&
      hiddenProjections.every((projection) =>
        recoveryPageDiagnostics.some(
          (page) =>
            page.mode === 'items' &&
            page.toolName === projection.tool &&
            page.offset === projection.targetPosition - 1 &&
            page.endOffset === projection.targetPosition &&
            page.returnedItems === 1,
        ),
      ));
  const exactUsageAvailable = recovery.rows.every(
    (row) =>
      row.cache.availability === 'exact' &&
      row.context.availability === 'exact',
  );
  const totalInputTokens = exactUsageAvailable
    ? recovery.rows.reduce(
        (total, row) => total + (row.context.inputTokens ?? 0),
        0,
      )
    : null;
  const totalCachedInputTokens = exactUsageAvailable
    ? recovery.rows.reduce(
        (total, row) => total + (row.cache.cachedInputTokens ?? 0),
        0,
      )
    : null;
  const passed =
    projectionWithinBudget &&
    projectionReducesRequest &&
    snapshotsExact &&
    recovery.answerCorrect &&
    recoveryTriggeredWhenRequired &&
    toolContractOnlyRecoverySelected;

  return {
    status: passed ? 'passed' : 'failed',
    projectionWithinBudget,
    projectionReducesRequest,
    snapshotsExact,
    targetEvidenceVisible,
    recoveryTriggeredWhenRequired,
    toolContractOnlyRecoverySelected,
    exactUsageAvailable,
    totalInputTokens,
    totalCachedInputTokens,
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function summarizeCompactionPolicyTrials(trials) {
  const exactPassCount = trials.filter(
    (trial) => trial.fidelity.exactAnswer,
  ).length;
  const inputTokens = trials
    .map((trial) => trial.row.context.inputTokens)
    .filter((value) => value !== null);
  const uncachedInputTokens = trials
    .map((trial) => trial.row.cache.uncachedInputTokens)
    .filter((value) => value !== null);
  return {
    trialCount: trials.length,
    exactPassCount,
    allHardGatesPassed: exactPassCount === trials.length,
    medianRequestBytes: median(
      trials.map((trial) => trial.row.request.serializedBytes),
    ),
    medianInputTokens:
      inputTokens.length === trials.length ? median(inputTokens) : null,
    medianUncachedInputTokens:
      uncachedInputTokens.length === trials.length
        ? median(uncachedInputTokens)
        : null,
  };
}

export function evaluateCompactionPolicyTrials({
  baselineTrials,
  candidateTrials,
}) {
  if (
    baselineTrials.length === 0 ||
    baselineTrials.length !== candidateTrials.length
  ) {
    throw new ProbeInputError(
      'compaction policy comparison requires equal non-empty trial sets',
    );
  }
  const baseline = summarizeCompactionPolicyTrials(baselineTrials);
  const candidate = summarizeCompactionPolicyTrials(candidateTrials);
  const decision = !candidate.allHardGatesPassed
    ? 'discard_candidate_hard_gate_failure'
    : !baseline.allHardGatesPassed
      ? 'advance_candidate_to_fresh_process_validation'
      : 'discard_candidate_no_measured_fidelity_gain';
  return {
    objectiveOrder: [
      'constraint_and_grounding_fidelity',
      'provider_and_wire_continuity',
      'model_visible_context',
      'uncached_input',
      'latency_and_model_rounds',
      'cache_reuse',
    ],
    baseline,
    candidate,
    decision,
    promotionAllowed: false,
    promotionBlocker:
      'pilot trials share one process; promotion requires paired fresh-process validation',
  };
}

function summarizeEvidenceSelectionCondition(label, condition) {
  if (
    !Array.isArray(condition?.rows) ||
    condition.rows.length === 0 ||
    typeof condition.answerCorrect !== 'boolean'
  ) {
    throw new ProbeInputError(
      `${label} requires non-empty rows and an exact answer result`,
    );
  }
  const exactInputRows = condition.rows.filter(
    (row) => row.context.inputTokens !== null,
  );
  const exactUncachedRows = condition.rows.filter(
    (row) => row.cache.uncachedInputTokens !== null,
  );
  const exactLatencyRows = condition.rows.filter(
    (row) => row.timing.totalLatencyMs !== null,
  );
  return {
    answerCorrect: condition.answerCorrect,
    modelRounds: condition.rows.length,
    totalRequestBytes: condition.rows.reduce(
      (total, row) => total + row.request.serializedBytes,
      0,
    ),
    totalInputTokens:
      exactInputRows.length === condition.rows.length
        ? exactInputRows.reduce(
            (total, row) => total + (row.context.inputTokens ?? 0),
            0,
          )
        : null,
    totalUncachedInputTokens:
      exactUncachedRows.length === condition.rows.length
        ? exactUncachedRows.reduce(
            (total, row) => total + (row.cache.uncachedInputTokens ?? 0),
            0,
          )
        : null,
    totalLatencyMs:
      exactLatencyRows.length === condition.rows.length
        ? roundMetric(
            exactLatencyRows.reduce(
              (total, row) => total + (row.timing.totalLatencyMs ?? 0),
              0,
            ),
          )
        : null,
  };
}

function summarizeProviderCompactionUsage(telemetry) {
  const inputTokens =
    Number.isSafeInteger(telemetry?.inputTokens) && telemetry.inputTokens >= 0
      ? telemetry.inputTokens
      : null;
  const outputTokens =
    Number.isSafeInteger(telemetry?.outputTokens) && telemetry.outputTokens >= 0
      ? telemetry.outputTokens
      : null;
  const cachedInputTokens =
    Number.isSafeInteger(telemetry?.cachedInputTokens) &&
    telemetry.cachedInputTokens >= 0
      ? telemetry.cachedInputTokens
      : null;
  return {
    availability: inputTokens === null ? 'unavailable' : 'exact',
    inputTokens,
    outputTokens,
    cachedInputTokens,
  };
}

function evaluateEvidenceSelectionCostLines({
  referenceNoEvidence,
  referenceEvidenceNeeded,
  expandedNoEvidence,
  expandedEvidenceNeeded,
}) {
  const endpoints = [
    referenceNoEvidence,
    referenceEvidenceNeeded,
    expandedNoEvidence,
    expandedEvidenceNeeded,
  ];
  if (endpoints.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new ProbeInputError(
      'evidence selection cost lines require exact non-negative input tokens',
    );
  }

  const referenceSlope = referenceEvidenceNeeded - referenceNoEvidence;
  const expandedSlope = expandedEvidenceNeeded - expandedNoEvidence;
  const denominator = referenceSlope - expandedSlope;
  const expectedInputTokens = {
    referenceOnly: {
      intercept: referenceNoEvidence,
      evidenceNeedIncrement: referenceSlope,
    },
    selectivelyExpanded: {
      intercept: expandedNoEvidence,
      evidenceNeedIncrement: expandedSlope,
    },
  };

  if (
    referenceNoEvidence === expandedNoEvidence &&
    referenceEvidenceNeeded === expandedEvidenceNeeded
  ) {
    return {
      status: 'equivalent_observed_endpoints',
      expectedInputTokens,
      breakEvenEvidenceNeedProbability: null,
      referenceOnlyPreferredBelowBreakEven: null,
    };
  }
  if (
    referenceNoEvidence <= expandedNoEvidence &&
    referenceEvidenceNeeded <= expandedEvidenceNeeded
  ) {
    return {
      status: 'reference_only_dominates_observed_endpoints',
      expectedInputTokens,
      breakEvenEvidenceNeedProbability: null,
      referenceOnlyPreferredBelowBreakEven: null,
    };
  }
  if (
    expandedNoEvidence <= referenceNoEvidence &&
    expandedEvidenceNeeded <= referenceEvidenceNeeded
  ) {
    return {
      status: 'selectively_expanded_dominates_observed_endpoints',
      expectedInputTokens,
      breakEvenEvidenceNeedProbability: null,
      referenceOnlyPreferredBelowBreakEven: null,
    };
  }
  if (denominator === 0) {
    return {
      status: 'parallel_cost_lines',
      expectedInputTokens,
      breakEvenEvidenceNeedProbability: null,
      referenceOnlyPreferredBelowBreakEven: null,
    };
  }

  const probability = (expandedNoEvidence - referenceNoEvidence) / denominator;
  if (probability < 0 || probability > 1) {
    return {
      status: 'no_break_even_in_unit_interval',
      expectedInputTokens,
      breakEvenEvidenceNeedProbability: null,
      referenceOnlyPreferredBelowBreakEven: null,
    };
  }
  return {
    status: 'break_even_observed',
    expectedInputTokens,
    breakEvenEvidenceNeedProbability: roundMetric(probability, 6),
    referenceOnlyPreferredBelowBreakEven:
      referenceNoEvidence < expandedNoEvidence,
  };
}

export function evaluateIndependentEvidenceWorkload({
  evidenceFreeTurns,
  evidenceNeededTurns,
  referenceNoEvidence,
  referenceEvidenceNeeded,
  expandedNoEvidence,
  expandedEvidenceNeeded,
  referenceCompactionInputTokens,
  expandedCompactionInputTokens,
}) {
  const turnCounts = [evidenceFreeTurns, evidenceNeededTurns];
  if (
    turnCounts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    evidenceFreeTurns + evidenceNeededTurns === 0
  ) {
    throw new ProbeInputError(
      'independent evidence workload requires non-negative turn counts with at least one turn',
    );
  }
  const endpointCost = evaluateEvidenceSelectionCostLines({
    referenceNoEvidence,
    referenceEvidenceNeeded,
    expandedNoEvidence,
    expandedEvidenceNeeded,
  });
  for (const value of [
    referenceCompactionInputTokens,
    expandedCompactionInputTokens,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProbeInputError(
        'independent evidence workload requires exact non-negative compaction input tokens',
      );
    }
  }

  const totalTurns = evidenceFreeTurns + evidenceNeededTurns;
  const referenceOnlyInputTokens =
    referenceCompactionInputTokens +
    evidenceFreeTurns * referenceNoEvidence +
    evidenceNeededTurns * referenceEvidenceNeeded;
  const selectivelyExpandedInputTokens =
    expandedCompactionInputTokens +
    evidenceFreeTurns * expandedNoEvidence +
    evidenceNeededTurns * expandedEvidenceNeeded;
  if (
    !Number.isSafeInteger(referenceOnlyInputTokens) ||
    !Number.isSafeInteger(selectivelyExpandedInputTokens)
  ) {
    throw new ProbeInputError(
      'independent evidence workload input token total exceeds safe integer range',
    );
  }
  const amortizedCost = evaluateEvidenceSelectionCostLines({
    referenceNoEvidence:
      referenceCompactionInputTokens + totalTurns * referenceNoEvidence,
    referenceEvidenceNeeded:
      referenceCompactionInputTokens + totalTurns * referenceEvidenceNeeded,
    expandedNoEvidence:
      expandedCompactionInputTokens + totalTurns * expandedNoEvidence,
    expandedEvidenceNeeded:
      expandedCompactionInputTokens + totalTurns * expandedEvidenceNeeded,
  });
  const delta = selectivelyExpandedInputTokens - referenceOnlyInputTokens;

  return {
    status: 'measured',
    methodology:
      'one measured compaction cost plus explicit counts of independent comparable continuation endpoints; sequential history and cache carry-over were not replayed',
    evidenceFreeTurns,
    evidenceNeededTurns,
    totalTurns,
    evidenceNeededShare: roundMetric(evidenceNeededTurns / totalTurns, 6),
    observedInputTokens: {
      referenceOnly: referenceOnlyInputTokens,
      selectivelyExpanded: selectivelyExpandedInputTokens,
      selectivelyExpandedMinusReferenceOnly: delta,
    },
    decision:
      delta > 0
        ? 'reference_only_lower_input'
        : delta < 0
          ? 'selectively_expanded_lower_input'
          : 'equivalent_input',
    continuationEndpointCost: endpointCost.expectedInputTokens,
    amortizedStatus: amortizedCost.status,
    amortizedBreakEvenEvidenceNeedProbability:
      amortizedCost.breakEvenEvidenceNeedProbability,
    referenceOnlyPreferredBelowAmortizedBreakEven:
      amortizedCost.referenceOnlyPreferredBelowBreakEven,
  };
}

export function evaluateEvidenceSelectionTradeoff({
  referenceOnlyNoEvidence,
  referenceOnlyEvidenceNeeded,
  selectivelyExpandedNoEvidence,
  selectivelyExpandedEvidenceNeeded,
  referenceOnlyCompactionInputBytes,
  selectivelyExpandedCompactionInputBytes,
  referenceOnlyCompactionUsage,
  selectivelyExpandedCompactionUsage,
  evidenceFreeTurns,
  evidenceNeededTurns,
}) {
  if (
    !Number.isSafeInteger(evidenceFreeTurns) ||
    evidenceFreeTurns < 0 ||
    !Number.isSafeInteger(evidenceNeededTurns) ||
    evidenceNeededTurns < 0 ||
    evidenceFreeTurns + evidenceNeededTurns === 0
  ) {
    throw new ProbeInputError(
      'evidence selection requires non-negative turn counts with at least one turn',
    );
  }
  if (
    !Number.isSafeInteger(referenceOnlyCompactionInputBytes) ||
    referenceOnlyCompactionInputBytes < 0 ||
    !Number.isSafeInteger(selectivelyExpandedCompactionInputBytes) ||
    selectivelyExpandedCompactionInputBytes < 0
  ) {
    throw new ProbeInputError(
      'evidence selection requires exact non-negative compaction input byte measurements',
    );
  }
  const referenceOnly = {
    noEvidence: summarizeEvidenceSelectionCondition(
      'reference-only no-evidence continuation',
      referenceOnlyNoEvidence,
    ),
    evidenceNeeded: summarizeEvidenceSelectionCondition(
      'reference-only evidence-needed continuation',
      referenceOnlyEvidenceNeeded,
    ),
  };
  const selectivelyExpanded = {
    noEvidence: summarizeEvidenceSelectionCondition(
      'selectively-expanded no-evidence continuation',
      selectivelyExpandedNoEvidence,
    ),
    evidenceNeeded: summarizeEvidenceSelectionCondition(
      'selectively-expanded evidence-needed continuation',
      selectivelyExpandedEvidenceNeeded,
    ),
  };
  const conditions = [
    referenceOnly.noEvidence,
    referenceOnly.evidenceNeeded,
    selectivelyExpanded.noEvidence,
    selectivelyExpanded.evidenceNeeded,
  ];
  const allHardGatesPassed = conditions.every(
    (condition) => condition.answerCorrect,
  );
  const exactInputUsageAvailable = conditions.every(
    (condition) => condition.totalInputTokens !== null,
  );

  let continuationCost = null;
  if (allHardGatesPassed && exactInputUsageAvailable) {
    const referenceNoEvidence = referenceOnly.noEvidence.totalInputTokens ?? 0;
    const referenceEvidenceNeeded =
      referenceOnly.evidenceNeeded.totalInputTokens ?? 0;
    const expandedNoEvidence =
      selectivelyExpanded.noEvidence.totalInputTokens ?? 0;
    const expandedEvidenceNeeded =
      selectivelyExpanded.evidenceNeeded.totalInputTokens ?? 0;
    continuationCost = evaluateEvidenceSelectionCostLines({
      referenceNoEvidence,
      referenceEvidenceNeeded,
      expandedNoEvidence,
      expandedEvidenceNeeded,
    });
  }

  const referenceCompaction = summarizeProviderCompactionUsage(
    referenceOnlyCompactionUsage,
  );
  const expandedCompaction = summarizeProviderCompactionUsage(
    selectivelyExpandedCompactionUsage,
  );
  const providerCompactionUsageIncluded =
    referenceCompaction.inputTokens !== null &&
    expandedCompaction.inputTokens !== null;
  let inclusiveCost = null;
  if (
    allHardGatesPassed &&
    continuationCost !== null &&
    providerCompactionUsageIncluded
  ) {
    inclusiveCost = evaluateEvidenceSelectionCostLines({
      referenceNoEvidence:
        continuationCost.expectedInputTokens.referenceOnly.intercept +
        referenceCompaction.inputTokens,
      referenceEvidenceNeeded:
        continuationCost.expectedInputTokens.referenceOnly.intercept +
        continuationCost.expectedInputTokens.referenceOnly
          .evidenceNeedIncrement +
        referenceCompaction.inputTokens,
      expandedNoEvidence:
        continuationCost.expectedInputTokens.selectivelyExpanded.intercept +
        expandedCompaction.inputTokens,
      expandedEvidenceNeeded:
        continuationCost.expectedInputTokens.selectivelyExpanded.intercept +
        continuationCost.expectedInputTokens.selectivelyExpanded
          .evidenceNeedIncrement +
        expandedCompaction.inputTokens,
    });
  }
  const independentTurnWorkload =
    allHardGatesPassed &&
    continuationCost !== null &&
    providerCompactionUsageIncluded
      ? evaluateIndependentEvidenceWorkload({
          evidenceFreeTurns,
          evidenceNeededTurns,
          referenceNoEvidence:
            continuationCost.expectedInputTokens.referenceOnly.intercept,
          referenceEvidenceNeeded:
            continuationCost.expectedInputTokens.referenceOnly.intercept +
            continuationCost.expectedInputTokens.referenceOnly
              .evidenceNeedIncrement,
          expandedNoEvidence:
            continuationCost.expectedInputTokens.selectivelyExpanded.intercept,
          expandedEvidenceNeeded:
            continuationCost.expectedInputTokens.selectivelyExpanded.intercept +
            continuationCost.expectedInputTokens.selectivelyExpanded
              .evidenceNeedIncrement,
          referenceCompactionInputTokens: referenceCompaction.inputTokens,
          expandedCompactionInputTokens: expandedCompaction.inputTokens,
        })
      : {
          status: allHardGatesPassed
            ? 'exact_usage_unavailable'
            : 'fidelity_gate_failed',
          methodology:
            'one measured compaction cost plus explicit counts of independent comparable continuation endpoints; sequential history and cache carry-over were not replayed',
          evidenceFreeTurns,
          evidenceNeededTurns,
          totalTurns: evidenceFreeTurns + evidenceNeededTurns,
          evidenceNeededShare:
            evidenceFreeTurns + evidenceNeededTurns === 0
              ? null
              : roundMetric(
                  evidenceNeededTurns /
                    (evidenceFreeTurns + evidenceNeededTurns),
                  6,
                ),
          observedInputTokens: null,
          decision: 'unavailable',
          continuationEndpointCost: null,
          amortizedStatus: 'unavailable',
          amortizedBreakEvenEvidenceNeedProbability: null,
          referenceOnlyPreferredBelowAmortizedBreakEven: null,
        };
  const status = !allHardGatesPassed
    ? 'fidelity_gate_failed'
    : (continuationCost?.status ?? 'inconclusive_usage');
  const inclusiveStatus = !allHardGatesPassed
    ? 'fidelity_gate_failed'
    : continuationCost === null
      ? 'inconclusive_usage'
      : (inclusiveCost?.status ?? 'compaction_usage_unavailable');
  const limitations = [
    ...(providerCompactionUsageIncluded
      ? [
          'provider-native compaction input usage is included exactly; output tokens are reported separately and are not part of the input-context objective',
        ]
      : [
          'provider-native compaction input usage was unavailable, so inclusive cost and break-even remain unresolved',
          'compaction input byte delta is measured, but it is not converted into fabricated token usage',
        ]),
    'single-process diagnostic pilot; no workload-distribution probability is assumed',
  ];

  return {
    objectiveOrder: [
      'exact_continuation_fidelity',
      'total_input_tokens',
      'model_rounds',
      'request_bytes',
      'latency',
    ],
    referenceOnly,
    selectivelyExpanded,
    allHardGatesPassed,
    exactInputUsageAvailable,
    status,
    expectedInputTokens: continuationCost?.expectedInputTokens ?? null,
    continuationOnlyBreakEvenEvidenceNeedProbability:
      continuationCost?.breakEvenEvidenceNeedProbability ?? null,
    referenceOnlyPreferredBelowBreakEven:
      continuationCost?.referenceOnlyPreferredBelowBreakEven ?? null,
    compactionInput: {
      measurement:
        'model-visible history, instructions, and tool-definition component bytes',
      referenceOnlyBytes: referenceOnlyCompactionInputBytes,
      selectivelyExpandedBytes: selectivelyExpandedCompactionInputBytes,
      selectivelyExpandedByteDelta:
        selectivelyExpandedCompactionInputBytes -
        referenceOnlyCompactionInputBytes,
    },
    providerCompactionUsage: {
      referenceOnly: referenceCompaction,
      selectivelyExpanded: expandedCompaction,
    },
    inclusiveStatus,
    inclusiveExpectedInputTokens: inclusiveCost?.expectedInputTokens ?? null,
    inclusiveBreakEvenEvidenceNeedProbability:
      inclusiveCost?.breakEvenEvidenceNeedProbability ?? null,
    referenceOnlyPreferredBelowInclusiveBreakEven:
      inclusiveCost?.referenceOnlyPreferredBelowBreakEven ?? null,
    providerCompactionUsageIncluded,
    independentTurnWorkload,
    productPolicyChanged: false,
    decision: 'retain_reference_first_pending_workload_distribution',
    limitations,
  };
}

async function loadLiveRuntime() {
  const [
    providerClient,
    daemonContext,
    toolDefinitions,
    toolSupport,
    systemPrompt,
    toolExecutor,
    toolProjection,
    wireMeasurement,
    codexRequest,
    compaction,
    memory,
    compactionRun,
    transcript,
    toolOutputStore,
  ] = await Promise.all([
    import('../src/daemon/llm/provider/client.ts'),
    import('../src/daemon/context.ts'),
    import('../src/daemon/agent/loop-tool-definitions.ts'),
    import('../src/daemon/agent/loop-tool-support.ts'),
    import('../src/daemon/agent/prompt/build-system-prompt.ts'),
    import('../src/daemon/tools/executor.ts'),
    import('../src/daemon/agent/tool-output-offload.ts'),
    import('../src/daemon/llm/provider/transport/responses-wire-input.ts'),
    import('../src/daemon/llm/provider/codex-request.ts'),
    import('../src/daemon/llm/provider/provider-native-compaction.ts'),
    import('../src/daemon/agent/memory/compaction-loop.ts'),
    import('../src/daemon/agent/memory/compaction-run.ts'),
    import('../src/daemon/sessions/transcript-log.ts'),
    import('../src/daemon/files/tool-output-store.ts'),
  ]);
  return {
    callModel: providerClient.callModel,
    createDaemonContext: daemonContext.createDaemonContext,
    createAgentLoopToolDefinitionPort:
      toolDefinitions.createAgentLoopToolDefinitionPort,
    parseToolCallArguments: toolSupport.parseToolCallArguments,
    recordInvalidToolArguments: toolSupport.recordInvalidToolArguments,
    buildSystemPrompt: systemPrompt.buildSystemPrompt,
    executeTool: toolExecutor.executeTool,
    createToolOutputProjectionRound:
      toolProjection.createToolOutputProjectionRound,
    maybeOffloadToolResult: toolProjection.maybeOffloadToolResult,
    measureResponseWireFunctionCallOutputAppendBytes:
      wireMeasurement.measureResponseWireFunctionCallOutputAppendBytes,
    measureResponseWireInputBytes:
      wireMeasurement.measureResponseWireInputBytes,
    buildResponseWireInput: wireMeasurement.buildResponseWireInput,
    buildCodexDirectPromptCacheProjection:
      codexRequest.buildCodexDirectPromptCacheProjection,
    resolveProviderNativeCompactionPolicy:
      compaction.resolveProviderNativeCompactionPolicy,
    compactProviderNativeHistory: compaction.compactProviderNativeHistory,
    createAgentLoopMemoryPort: memory.createAgentLoopMemoryPort,
    compactThreadContextNative: compactionRun.compactThreadContextNative,
    appendTranscriptEntry: transcript.appendTranscriptEntry,
    readToolOutputSnapshot: toolOutputStore.readToolOutputSnapshot,
  };
}

async function collectModelRound({
  callModel,
  history,
  systemPrompt,
  tools,
  providerSessionId,
  providerWebSocketSessions,
  providerAuthRuntime,
  providerRequestOptions,
  providerReplayScopeId,
  label,
}) {
  const startedAt = performance.now();
  let firstTokenAt = null;
  let firstSemanticAt = null;
  let doneChunk;
  const functionCalls = [];
  const requestMeasurements = [];

  for await (const chunk of callModel({
    history,
    systemPrompt,
    ...(tools === undefined ? {} : { tools }),
    providerSessionId,
    providerWebSocketSessions,
    providerAuthRuntime,
    providerRequestOptions,
    ...(providerReplayScopeId === undefined ? {} : { providerReplayScopeId }),
    onProviderRequestPrepared(measurement) {
      requestMeasurements.push(measurement);
    },
  })) {
    const receivedAt = performance.now();
    if (
      firstSemanticAt === null &&
      ((chunk.type === 'text_delta' && chunk.text.length > 0) ||
        (chunk.type === 'tool_call_delta' && chunk.argsDelta.length > 0) ||
        chunk.type === 'tool_call')
    ) {
      firstSemanticAt = receivedAt;
    }
    if (
      firstTokenAt === null &&
      chunk.type === 'text_delta' &&
      chunk.text.length > 0
    ) {
      firstTokenAt = receivedAt;
    }
    if (chunk.type === 'tool_call') {
      functionCalls.push({
        id: chunk.id,
        callId: chunk.callId,
        name: chunk.toolName,
        arguments: chunk.argumentsJson,
      });
    } else if (chunk.type === 'done') {
      doneChunk = chunk;
      if (
        firstTokenAt === null &&
        (chunk.finalText?.length > 0 || chunk.assistantText?.length > 0)
      ) {
        firstTokenAt = receivedAt;
      }
      if (
        firstSemanticAt === null &&
        (chunk.finalText?.length > 0 || chunk.assistantText?.length > 0)
      ) {
        firstSemanticAt = receivedAt;
      }
    } else if (chunk.type === 'error') {
      throw new Error(`${label} failed: ${chunk.code}: ${chunk.message}`);
    }
  }

  const completedAt = performance.now();
  const requestMeasurement = requestMeasurements.at(-1);
  if (requestMeasurement === undefined) {
    throw new Error(`${label} did not expose a provider request measurement`);
  }
  if (doneChunk === undefined) {
    throw new Error(`${label} did not produce a done chunk`);
  }

  return {
    label,
    requestMeasurement,
    requestPreparationCount: requestMeasurements.length,
    providerUsageTelemetry: doneChunk.providerUsageTelemetry,
    timeToFirstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
    timeToFirstSemanticMs:
      firstSemanticAt === null ? null : firstSemanticAt - startedAt,
    totalLatencyMs: completedAt - startedAt,
    functionCalls,
    itemsToAppend: doneChunk.itemsToAppend ?? [],
    finalText: doneChunk.finalText || doneChunk.assistantText || '',
  };
}

function readProviderReplayScopeId(items, label) {
  const scopeIds = new Set(
    items.flatMap((item) =>
      item.providerReplayScopeId === undefined ||
      item.providerReplayScopeId === null
        ? []
        : [item.providerReplayScopeId],
    ),
  );
  if (scopeIds.size !== 1) {
    throw new Error(`${label} did not produce one replay scope`);
  }
  return [...scopeIds][0];
}

function requireProviderNativeBatch(round, label) {
  if (
    round.itemsToAppend.length === 0 ||
    round.itemsToAppend.some((item) => item.kind !== 'backend_item')
  ) {
    throw new Error(`${label} did not produce an all-backend_item batch`);
  }
}

function parseFunctionCallArguments(functionCall) {
  let value;
  try {
    value = JSON.parse(functionCall.arguments);
  } catch {
    throw new Error(`tool call ${functionCall.callId} arguments are not JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `tool call ${functionCall.callId} arguments are not an object`,
    );
  }
  return value;
}

function operationKey(operation) {
  return JSON.stringify({
    path: operation.path,
    offset: operation.offset ?? 0,
    limit: operation.limit,
  });
}

async function executeReadFileBatch({
  live,
  context,
  functionCalls,
  expectedOperations,
  workspaceRoot,
  threadId,
}) {
  if (functionCalls.length !== expectedOperations.length) {
    throw new Error(
      `expected ${expectedOperations.length} read_file calls, received ${functionCalls.length}`,
    );
  }
  const expectedKeys = new Set(expectedOperations.map(operationKey));
  const results = [];
  for (const functionCall of functionCalls) {
    if (functionCall.name !== 'read_file') {
      throw new Error(`unexpected setup tool: ${functionCall.name}`);
    }
    const args = parseFunctionCallArguments(functionCall);
    const key = operationKey(args);
    if (!expectedKeys.delete(key)) {
      throw new Error(`unexpected or duplicate read_file arguments: ${key}`);
    }
    const result = await live.executeTool(
      functionCall.name,
      args,
      {
        callId: functionCall.callId,
        workspaceRoot,
        stateRoot: workspaceRoot,
        computerFileRoot: context.computerFileRoot,
        workingDirectory: workspaceRoot,
        threadId,
        projectId: 'tool-result-cache-context-probe',
        fileStateCache: context.fileStateCache,
      },
      { toolRegistry: context.toolRegistry },
    );
    if (!result.ok) {
      throw new Error(`read_file setup failed: ${result.errorCode}`);
    }
    results.push(result);
  }
  if (expectedKeys.size !== 0) {
    throw new Error('read_file setup omitted one or more requested operations');
  }
  return results;
}

async function requestReadFileBatch({
  live,
  context,
  systemPrompt,
  readFileTools,
  operations,
  workspaceRoot,
  threadId,
  label,
}) {
  const userText = [
    'Diagnostic setup only.',
    `Call read_file exactly ${operations.length} time(s), all in this one model response,`,
    'using exactly the JSON argument objects below. Do not answer with prose.',
    JSON.stringify(operations),
  ].join('\n');
  const round = await collectModelRound({
    callModel: live.callModel,
    history: [{ kind: 'user', text: userText }],
    systemPrompt,
    tools: readFileTools,
    providerSessionId: randomUUID(),
    providerWebSocketSessions: context.provider.webSocketSessions,
    providerAuthRuntime: context.provider.authRuntime,
    providerRequestOptions: context.provider.requestOptions,
    label,
  });
  requireProviderNativeBatch(round, label);
  const toolResults = await executeReadFileBatch({
    live,
    context,
    functionCalls: round.functionCalls,
    expectedOperations: operations,
    workspaceRoot,
    threadId,
  });
  return {
    historyPrefix: [{ kind: 'user', text: userText }, ...round.itemsToAppend],
    providerReplayScopeId: readProviderReplayScopeId(
      round.itemsToAppend,
      label,
    ),
    functionCalls: round.functionCalls,
    toolResults,
  };
}

function hasExactFlatArguments(actual, expected) {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return false;
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => Object.is(actual[key], expected[key]))
  );
}

async function requestEnumerableToolBatch({
  live,
  context,
  systemPrompt,
  tools,
  expectedCalls,
  workspaceRoot,
  threadId,
}) {
  const userText = [
    'Diagnostic setup only.',
    `Call each of these ${expectedCalls.length} tools exactly once,`,
    'continuing after each tool result until every named call is complete.',
    'using exactly the named tool and JSON arguments below. Do not answer with prose.',
    JSON.stringify(expectedCalls),
  ].join('\n');
  const historyWithFullResults = [{ kind: 'user', text: userText }];
  const remainingCalls = new Map(
    expectedCalls.map((expectedCall) => [
      expectedCall.toolName,
      expectedCall.arguments,
    ]),
  );
  const providerSessionId = randomUUID();
  let providerReplayScopeId;
  const functionCalls = [];
  const toolResults = [];
  while (remainingCalls.size > 0) {
    const setupRound = expectedCalls.length - remainingCalls.size + 1;
    const round = await collectModelRound({
      callModel: live.callModel,
      history: historyWithFullResults,
      systemPrompt,
      tools,
      providerSessionId,
      providerWebSocketSessions: context.provider.webSocketSessions,
      providerAuthRuntime: context.provider.authRuntime,
      providerRequestOptions: context.provider.requestOptions,
      ...(providerReplayScopeId === undefined ? {} : { providerReplayScopeId }),
      label: `enumerable preview setup round ${setupRound}`,
    });
    requireProviderNativeBatch(
      round,
      `enumerable preview setup round ${setupRound}`,
    );
    const roundReplayScopeId = readProviderReplayScopeId(
      round.itemsToAppend,
      `enumerable preview setup round ${setupRound}`,
    );
    if (
      providerReplayScopeId !== undefined &&
      roundReplayScopeId !== providerReplayScopeId
    ) {
      throw new Error('enumerable setup changed provider replay scope');
    }
    providerReplayScopeId = roundReplayScopeId;
    historyWithFullResults.push(...round.itemsToAppend);

    for (const functionCall of round.functionCalls) {
      const expectedArguments = remainingCalls.get(functionCall.name);
      if (expectedArguments === undefined) {
        throw new Error(
          `unexpected or duplicate enumerable setup tool: ${functionCall.name}`,
        );
      }
      const actualArguments = parseFunctionCallArguments(functionCall);
      if (!hasExactFlatArguments(actualArguments, expectedArguments)) {
        throw new Error(
          `enumerable setup arguments differed for ${functionCall.name}`,
        );
      }
      remainingCalls.delete(functionCall.name);
      const result = await live.executeTool(
        functionCall.name,
        actualArguments,
        {
          callId: functionCall.callId,
          workspaceRoot,
          stateRoot: workspaceRoot,
          computerFileRoot: context.computerFileRoot,
          workingDirectory: workspaceRoot,
          threadId,
          projectId: 'tool-result-cache-context-probe',
          fileStateCache: context.fileStateCache,
        },
        { toolRegistry: context.toolRegistry },
      );
      if (!result.ok) {
        throw new Error(
          `${functionCall.name} enumerable setup failed: ${result.errorCode}`,
        );
      }
      functionCalls.push(functionCall);
      toolResults.push(result);
      historyWithFullResults.push({
        kind: 'function_call_output',
        callId: functionCall.callId,
        output: result.output,
      });
    }
  }

  return {
    historyWithFullResults,
    providerReplayScopeId,
    functionCalls,
    toolResults,
  };
}

export function expandProviderNativeFunctionCallBatch(sourceBatch, operations) {
  if (sourceBatch.functionCalls.length !== 1) {
    throw new Error('provider-native expansion requires one live source call');
  }
  const sourceFunctionCall = sourceBatch.functionCalls[0];
  const expandedFunctionCalls = operations.map((operation) => ({
    id: `fc_${randomUUID().replaceAll('-', '')}`,
    callId: `call_${randomUUID().replaceAll('-', '')}`,
    name: sourceFunctionCall.name,
    arguments: JSON.stringify(operation),
  }));
  let replaced = false;
  const expandedItems = sourceBatch.historyPrefix.slice(1).flatMap((item) => {
    const data = item.kind === 'backend_item' ? item.data : undefined;
    if (
      data === null ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      data.type !== 'function_call'
    ) {
      return [item];
    }
    if (data.call_id !== sourceFunctionCall.callId) {
      throw new Error('live source batch contains an unexpected function call');
    }
    replaced = true;
    return expandedFunctionCalls.map((functionCall) => ({
      ...item,
      data: {
        ...data,
        id: functionCall.id,
        call_id: functionCall.callId,
        name: functionCall.name,
        arguments: functionCall.arguments,
      },
    }));
  });
  if (!replaced) {
    throw new Error('live source batch has no replayable native function call');
  }
  return {
    historyPrefix: [sourceBatch.historyPrefix[0], ...expandedItems],
    providerReplayScopeId: sourceBatch.providerReplayScopeId,
    functionCalls: expandedFunctionCalls,
  };
}

async function createDeterministicManyReadFileBatch({
  live,
  context,
  sourceBatch,
  operations,
  workspaceRoot,
  threadId,
}) {
  const expanded = expandProviderNativeFunctionCallBatch(
    sourceBatch,
    operations,
  );
  const toolResults = await executeReadFileBatch({
    live,
    context,
    functionCalls: expanded.functionCalls,
    expectedOperations: operations,
    workspaceRoot,
    threadId,
  });
  return { ...expanded, toolResults };
}

async function projectToolResultBatch({
  live,
  context,
  batch,
  stateRoot,
  threadId,
  availableModelVisibleBytes,
}) {
  const projectionRound = live.createToolOutputProjectionRound({
    availableModelVisibleBytes,
    resultCount: batch.toolResults.length,
  });
  const runId = randomUUID();
  const projectedResults = [];
  for (let index = 0; index < batch.toolResults.length; index += 1) {
    const functionCall = batch.functionCalls[index];
    const toolResult = batch.toolResults[index];
    const resultProjection = context.toolRegistry.getToolMeta(
      functionCall.name,
    )?.resultProjection;
    if (resultProjection === undefined) {
      throw new Error(`${functionCall.name} has no result projection`);
    }
    const projected = await live.maybeOffloadToolResult({
      functionCall,
      runContext: { threadId, stateRoot },
      runId,
      toolResult,
      resultProjection,
      projectionRound,
      toolOutputRecoveryAvailable: true,
      measureModelVisibleResultBytes(result) {
        return live.measureResponseWireFunctionCallOutputAppendBytes({
          kind: 'function_call_output',
          callId: functionCall.callId,
          output: result.output,
        });
      },
    });
    const visible = JSON.parse(projected.output);
    if (visible.offloaded !== true || typeof visible.outputRef !== 'string') {
      throw new Error(
        `${functionCall.name} did not select first-visible projection`,
      );
    }
    projectedResults.push(projected);
  }
  return projectedResults;
}

function appendToolResults(historyPrefix, functionCalls, results) {
  return [
    ...historyPrefix,
    ...results.map((result, index) => ({
      kind: 'function_call_output',
      callId: functionCalls[index].callId,
      output: result.output,
    })),
  ];
}

function replaceFunctionCallOutputs(history, functionCalls, results) {
  const outputByCallId = new Map(
    functionCalls.map((functionCall, index) => [
      functionCall.callId,
      results[index].output,
    ]),
  );
  return history.map((item) => {
    if (item.kind !== 'function_call_output') {
      return item;
    }
    const output = outputByCallId.get(item.callId);
    return output === undefined ? item : { ...item, output };
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function runRepeatedCondition({
  live,
  context,
  history,
  systemPrompt,
  tools,
  providerReplayScopeId,
  contextWindow,
  warmControls,
  cacheSettleMs,
  providerSessionId = randomUUID(),
  label,
  answerCorrect,
}) {
  const rawRounds = [];
  const rows = [];
  for (let attempt = 0; attempt <= warmControls; attempt += 1) {
    if (attempt > 0) await sleep(cacheSettleMs);
    const raw = await collectModelRound({
      callModel: live.callModel,
      history,
      systemPrompt,
      tools,
      providerSessionId,
      providerWebSocketSessions: context.provider.webSocketSessions,
      providerAuthRuntime: context.provider.authRuntime,
      providerRequestOptions: context.provider.requestOptions,
      providerReplayScopeId,
      label: `${label} ${attempt === 0 ? 'cold' : `warm-${attempt}`}`,
    });
    rawRounds.push(raw);
    rows.push(
      summarizeCacheContextRound(raw, {
        contextWindow,
        answerCorrect: answerCorrect(raw.finalText),
      }),
    );
  }
  return { providerSessionId, rawRounds, rows };
}

async function runOneRound({
  live,
  context,
  history,
  systemPrompt,
  tools,
  providerReplayScopeId,
  providerSessionId = randomUUID(),
  contextWindow,
  label,
  answerCorrect,
}) {
  const raw = await collectModelRound({
    callModel: live.callModel,
    history,
    systemPrompt,
    tools,
    providerSessionId,
    providerWebSocketSessions: context.provider.webSocketSessions,
    providerAuthRuntime: context.provider.authRuntime,
    providerRequestOptions: context.provider.requestOptions,
    providerReplayScopeId,
    label,
  });
  return {
    raw,
    row: summarizeCacheContextRound(raw, {
      contextWindow,
      answerCorrect: answerCorrect(raw.finalText),
    }),
  };
}

export async function runRecoveryTask({
  live,
  context,
  history,
  systemPrompt,
  recoveryTools,
  providerReplayScopeId,
  workspaceRoot,
  threadId,
  contextWindow,
  expectedAnswer,
  maxModelRounds,
  labelPrefix = 'slim exact-recovery',
  isAnswerCorrect = (answer) => answer === expectedAnswer,
}) {
  const mutableHistory = [...history];
  const rows = [];
  const providerSessionId = randomUUID();
  let invalidArgumentCorrections = 0;
  const invalidArgumentDiagnostics = [];
  const recoveryPageDiagnostics = [];
  const recoveryRunContext = {
    stateRoot: workspaceRoot,
    threadId,
  };
  const recordInvalidArguments = async (
    functionCall,
    round,
    errorResult,
    source,
  ) => {
    await live.recordInvalidToolArguments({
      functionCall,
      round,
      errorResult,
      runContext: recoveryRunContext,
      runId: providerSessionId,
      history: mutableHistory,
      emit() {},
    });
    invalidArgumentCorrections += 1;
    invalidArgumentDiagnostics.push({
      modelRound: round + 1,
      source,
      errorCode: errorResult.errorCode,
      error: errorResult.error,
    });
  };
  for (let roundIndex = 0; roundIndex < maxModelRounds; roundIndex += 1) {
    const raw = await collectModelRound({
      callModel: live.callModel,
      history: mutableHistory,
      systemPrompt,
      tools: recoveryTools,
      providerSessionId,
      providerWebSocketSessions: context.provider.webSocketSessions,
      providerAuthRuntime: context.provider.authRuntime,
      providerRequestOptions: context.provider.requestOptions,
      providerReplayScopeId,
      label: `${labelPrefix} round ${roundIndex + 1}`,
    });
    const terminal = raw.functionCalls.length === 0;
    const observedAnswer = terminal ? raw.finalText.trim() : null;
    const answerCorrect =
      observedAnswer === null ? null : isAnswerCorrect(observedAnswer);
    rows.push(
      summarizeCacheContextRound(raw, {
        contextWindow,
        modelRounds: roundIndex + 1,
        answerCorrect,
      }),
    );
    if (terminal) {
      return {
        rows,
        extraModelRounds: roundIndex,
        invalidArgumentCorrections,
        invalidArgumentDiagnostics,
        recoveryPageDiagnostics,
        answerCorrect,
        observedAnswer,
      };
    }
    requireProviderNativeBatch(raw, `recovery round ${roundIndex + 1}`);
    mutableHistory.push(...raw.itemsToAppend);
    for (const functionCall of raw.functionCalls) {
      if (functionCall.name !== 'read_tool_output') {
        throw new Error(`unexpected recovery tool: ${functionCall.name}`);
      }
      const parsedArguments = live.parseToolCallArguments(
        functionCall.arguments,
      );
      if (!parsedArguments.ok) {
        await recordInvalidArguments(
          functionCall,
          roundIndex,
          parsedArguments.error,
          'provider_arguments',
        );
        continue;
      }
      const result = await live.executeTool(
        functionCall.name,
        parsedArguments.args,
        {
          callId: functionCall.callId,
          workspaceRoot,
          stateRoot: workspaceRoot,
          threadId,
          projectId: 'tool-result-cache-context-probe',
        },
        { toolRegistry: context.toolRegistry },
      );
      if (!result.ok) {
        if (result.errorCode === 'invalid_args') {
          await recordInvalidArguments(
            functionCall,
            roundIndex,
            result,
            'tool_schema',
          );
          continue;
        }
        throw new Error(
          `read_tool_output recovery failed: ${result.errorCode}`,
        );
      }
      const recoveredPage = JSON.parse(result.output);
      if (
        typeof recoveredPage !== 'object' ||
        recoveredPage === null ||
        Array.isArray(recoveredPage)
      ) {
        throw new Error('read_tool_output returned an invalid recovery page');
      }
      const itemPage =
        recoveredPage.mode === 'items' && Array.isArray(recoveredPage.items);
      recoveryPageDiagnostics.push({
        modelRound: roundIndex + 1,
        mode: itemPage ? 'items' : 'characters',
        toolName:
          typeof recoveredPage.toolName === 'string'
            ? recoveredPage.toolName
            : null,
        offset:
          typeof recoveredPage.offset === 'number'
            ? recoveredPage.offset
            : null,
        endOffset:
          typeof recoveredPage.endOffset === 'number'
            ? recoveredPage.endOffset
            : null,
        totalUnits:
          typeof recoveredPage.totalItems === 'number'
            ? recoveredPage.totalItems
            : typeof recoveredPage.totalChars === 'number'
              ? recoveredPage.totalChars
              : null,
        returnedItems: itemPage ? recoveredPage.items.length : null,
      });
      mutableHistory.push({
        kind: 'function_call_output',
        callId: functionCall.callId,
        output: result.output,
      });
    }
  }
  throw new Error(
    `exact recovery exceeded the explicit --max-model-rounds ${maxModelRounds}`,
  );
}

async function seedCompactionTranscript({
  live,
  workspaceRoot,
  threadId,
  batch,
  projectedResults,
  prelude,
  retentionPrompt,
}) {
  const timestamp = new Date().toISOString();
  const setupUser = batch.historyPrefix[0];
  if (setupUser?.kind !== 'user') {
    throw new Error('compaction setup history does not start with a user');
  }
  for (const item of prelude) {
    await live.appendTranscriptEntry(workspaceRoot, threadId, {
      role: item.kind,
      content: item.text,
      timestamp,
    });
  }
  await live.appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: setupUser.text,
    timestamp,
  });
  for (let index = 0; index < batch.functionCalls.length; index += 1) {
    const functionCall = batch.functionCalls[index];
    const projectedResult = projectedResults[index];
    await live.appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'tool_call',
      content: JSON.stringify({
        callId: functionCall.callId,
        id: functionCall.id,
        name: functionCall.name,
        arguments: functionCall.arguments,
      }),
      timestamp,
    });
    await live.appendTranscriptEntry(workspaceRoot, threadId, {
      role: 'tool_result',
      content: JSON.stringify({
        callId: functionCall.callId,
        output: projectedResult.output,
      }),
      timestamp,
    });
  }
  await live.appendTranscriptEntry(workspaceRoot, threadId, {
    role: 'user',
    content: retentionPrompt.text,
    timestamp,
  });
}

async function compactProjectedHistory({
  live,
  context,
  workspaceRoot,
  threadId,
  history,
  systemPrompt,
  compactionSystemPrompt = systemPrompt,
  providerReplayScopeId,
  policy,
  resolveEvidencePages,
}) {
  let compactionInputMeasurement;
  const memory = live.createAgentLoopMemoryPort({
    resolvePolicy: async () => policy,
    compactHistory: async (input, targetPolicy) => {
      const historyBytes = live.measureResponseWireInputBytes(
        [...input.history],
        {
          providerId: targetPolicy.providerId,
          model: targetPolicy.model,
          ...(input.providerReplayScopeId === undefined
            ? {}
            : { providerReplayScopeId: input.providerReplayScopeId }),
        },
      );
      const instructionBytes = Buffer.byteLength(
        input.systemPrompt ?? '',
        'utf8',
      );
      const toolDefinitionBytes = Buffer.byteLength(
        JSON.stringify(input.tools ?? []),
        'utf8',
      );
      compactionInputMeasurement = {
        historyBytes,
        instructionBytes,
        toolDefinitionBytes,
        modelVisibleComponentBytes:
          historyBytes + instructionBytes + toolDefinitionBytes,
      };
      return await live.compactProviderNativeHistory(input, targetPolicy);
    },
    compactThread: live.compactThreadContextNative,
    ...(resolveEvidencePages === undefined ? {} : { resolveEvidencePages }),
  });
  const requestContext = {
    workspaceRoot,
    threadId,
    history,
    systemPrompt: compactionSystemPrompt,
    tools: [],
    providerAuthRuntime: context.provider.authRuntime,
    providerRequestOptions: context.provider.requestOptions,
    providerReplayScopeId,
  };
  const contextBudgetRound = memory.beginContextBudgetRound(requestContext);
  const result = await memory.compactAfterModelRound({
    ...requestContext,
    contextBudgetRound,
    // This diagnostic compares deliberate compaction below the automatic
    // threshold. The explicit policy threshold triggers the existing owner;
    // it is not reported as observed request usage.
    inputTokens: policy.thresholdTokens,
  });
  if (result.kind !== 'compacted') {
    throw new Error(
      `projection-first compaction did not commit: ${result.kind} ${result.reason ?? ''}`,
    );
  }
  const checkpoint = history[0];
  if (
    checkpoint?.kind !== 'provider_native_compaction' ||
    checkpoint.providerReplayScopeId === undefined ||
    checkpoint.providerReplayScopeId === null
  ) {
    throw new Error('projection-first compaction did not rebuild history');
  }
  if (compactionInputMeasurement === undefined) {
    throw new Error('projection-first compaction input was not measured');
  }
  return {
    history,
    providerReplayScopeId: checkpoint.providerReplayScopeId,
    forcedTriggerTokens: policy.thresholdTokens,
    compactionInputMeasurement,
    providerUsageTelemetry: result.providerUsageTelemetry,
  };
}

function measureVisibleBatchBytes(live, functionCalls, results) {
  return results.reduce(
    (total, result, index) =>
      total +
      live.measureResponseWireFunctionCallOutputAppendBytes({
        kind: 'function_call_output',
        callId: functionCalls[index].callId,
        output: result.output,
      }),
    0,
  );
}

function buildFixture({ lines, linePayloadBytes, marker, markerLine }) {
  return Array.from({ length: lines }, (_, index) => {
    const identity =
      index + 1 === markerLine
        ? `PROBE_MARKER=${marker}`
        : `PROBE_LINE=${String(index + 1).padStart(6, '0')}`;
    return `${identity} ${'x'.repeat(linePayloadBytes)}`;
  }).join('\n');
}

export function selectEvidencePageWindow({ output, marker, limit }) {
  if (
    typeof output !== 'string' ||
    typeof marker !== 'string' ||
    marker.length === 0 ||
    !Number.isSafeInteger(limit) ||
    limit < marker.length
  ) {
    throw new ProbeInputError(
      'evidence page selection requires string output, a non-empty marker, and a safe character limit large enough for the marker',
    );
  }
  const markerOffset = output.indexOf(marker);
  if (markerOffset < 0) {
    throw new ProbeInputError('evidence page marker is absent from output');
  }
  const preferredOffset = Math.max(
    0,
    markerOffset - Math.floor((limit - marker.length) / 2),
  );
  const offset = Math.min(preferredOffset, Math.max(0, output.length - limit));
  const endOffset = Math.min(output.length, offset + limit);
  const content = output.slice(offset, endOffset);
  if (!content.includes(marker)) {
    throw new Error('selected evidence page does not contain the full marker');
  }
  return {
    offset,
    limit,
    endOffset,
    totalChars: output.length,
    markerOffset,
    content,
  };
}

function buildCompactionPadding(byteLength) {
  const parts = [];
  let currentBytes = 0;
  let index = 0;
  while (currentBytes < byteLength) {
    const part = `PAD_${String(index).padStart(6, '0')} stable historical context for deliberate compaction measurement.\n`;
    parts.push(part);
    currentBytes += Buffer.byteLength(part, 'utf8');
    index += 1;
  }
  return parts.join('').slice(0, byteLength);
}

async function createEnumerablePreviewFixture({
  directory,
  entryCount,
  linePayloadBytes,
  targetPosition,
  marker,
}) {
  await mkdir(directory, { recursive: true });
  const indexWidth = String(entryCount).length;
  const targetName = `entry-${String(targetPosition).padStart(indexWidth, '0')}.txt`;
  const padding = 'x'.repeat(linePayloadBytes);
  await Promise.all(
    Array.from({ length: entryCount }, (_, index) => {
      const position = index + 1;
      const name = `entry-${String(position).padStart(indexWidth, '0')}.txt`;
      const target =
        position === targetPosition ? ` TARGET_MARKER=${marker}` : '';
      return writeFile(
        join(directory, name),
        `ENUMERABLE_MATCH position=${position}${target} ${padding}\n`,
        'utf8',
      );
    }),
  );
  return targetName;
}

function summarizeEnumerableProjection({
  functionCall,
  fullResult,
  projectedResult,
  targetName,
  targetPosition,
}) {
  const full = JSON.parse(fullResult.output);
  const projected = JSON.parse(projectedResult.output);
  if (projected.offloaded !== true || typeof projected.outputRef !== 'string') {
    throw new Error(`${functionCall.name} enumerable result was not projected`);
  }

  if (functionCall.name === 'list_files') {
    if (
      !Array.isArray(full.entries) ||
      !Array.isArray(projected.previewEntries)
    ) {
      throw new Error('list_files enumerable result shape is invalid');
    }
    const targetIndex = full.entries.findIndex(
      (entry) => entry?.name === targetName,
    );
    if (targetIndex < 0) {
      throw new Error('list_files enumerable target is unavailable');
    }
    return {
      tool: functionCall.name,
      outputRef: projected.outputRef,
      fullOutputBytes: Buffer.byteLength(fullResult.output, 'utf8'),
      modelVisibleBytes: Buffer.byteLength(projectedResult.output, 'utf8'),
      total: full.entries.length,
      previewCount: projected.previewEntries.length,
      previewHasMore: projected.previewHasMore === true,
      targetPosition: targetIndex + 1,
      targetEvidenceVisible: projected.previewEntries.some(
        (entry) => entry?.name === targetName,
      ),
      expectedValue: targetName,
    };
  }

  if (functionCall.name === 'search_files') {
    if (
      !Array.isArray(full.results) ||
      !Array.isArray(projected.previewResults)
    ) {
      throw new Error('search_files enumerable result shape is invalid');
    }
    const targetIndex = targetPosition - 1;
    const target = full.results[targetIndex];
    if (targetIndex < 0 || typeof target?.path !== 'string') {
      throw new Error('search_files enumerable target is unavailable');
    }
    return {
      tool: functionCall.name,
      outputRef: projected.outputRef,
      fullOutputBytes: Buffer.byteLength(fullResult.output, 'utf8'),
      modelVisibleBytes: Buffer.byteLength(projectedResult.output, 'utf8'),
      total: full.results.length,
      previewCount: projected.previewResults.length,
      previewHasMore: projected.previewHasMore === true,
      targetPosition: targetIndex + 1,
      targetEvidenceVisible:
        projected.previewResults[targetIndex]?.path === target.path,
      expectedValue: target.path,
    };
  }

  throw new Error(
    `unexpected enumerable projection tool: ${functionCall.name}`,
  );
}

async function runEnumerablePreviewBudgetProbe(options) {
  const live = await loadLiveRuntime();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-enumerable-preview-'),
  );
  const fixtureDirectory = join(workspaceRoot, 'enumerable');
  const marker = `GBEP_${randomUUID().replaceAll('-', '')}`;
  const threadId = randomUUID();
  const context = live.createDaemonContext();

  try {
    if (context.computerFileRoot === undefined) {
      throw new Error('computer filesystem authority is unavailable');
    }
    const targetName = await createEnumerablePreviewFixture({
      directory: fixtureDirectory,
      entryCount: options.largeLines,
      linePayloadBytes: options.linePayloadBytes,
      targetPosition: options.evidenceMarkerLine,
      marker,
    });
    const definitionPort = live.createAgentLoopToolDefinitionPort(
      context.toolRegistry,
    );
    const enumerableTools = definitionPort.buildToolDefinitions({
      directRegistryNames: ['list_files', 'search_files'],
    });
    const recoveryTools = definitionPort.buildToolDefinitions({
      directRegistryNames: ['read_tool_output'],
    });
    const systemPrompt = live.buildSystemPrompt({
      profile: 'root',
      computerSessionAvailable: true,
      workingDirectory: workspaceRoot,
    });
    const expectedCalls = [
      {
        toolName: 'list_files',
        arguments: { path: fixtureDirectory, recursive: false },
      },
      {
        toolName: 'search_files',
        arguments: {
          pattern: 'ENUMERABLE_MATCH',
          path: fixtureDirectory,
          type: 'content',
        },
      },
    ];
    const batch = await requestEnumerableToolBatch({
      live,
      context,
      systemPrompt,
      tools: enumerableTools,
      expectedCalls,
      workspaceRoot,
      threadId,
    });
    const projectedResults = await projectToolResultBatch({
      live,
      context,
      batch,
      stateRoot: workspaceRoot,
      threadId,
      availableModelVisibleBytes: options.sameRoundVisibleBytes,
    });
    const projections = batch.functionCalls.map((functionCall, index) =>
      summarizeEnumerableProjection({
        functionCall,
        fullResult: batch.toolResults[index],
        projectedResult: projectedResults[index],
        targetName,
        targetPosition: options.evidenceMarkerLine,
      }),
    );
    const projectionByTool = new Map(
      projections.map((projection) => [projection.tool, projection]),
    );
    const listProjection = projectionByTool.get('list_files');
    const searchProjection = projectionByTool.get('search_files');
    if (listProjection === undefined || searchProjection === undefined) {
      throw new Error('enumerable projection omitted a required tool');
    }

    const snapshotsExact = (
      await Promise.all(
        projections.map(async (projection, index) => {
          const snapshot = await live.readToolOutputSnapshot({
            stateRoot: workspaceRoot,
            threadId,
            outputRef: projection.outputRef,
          });
          return (
            snapshot.ok &&
            snapshot.value.output === batch.toolResults[index].output
          );
        }),
      )
    ).every(Boolean);
    const fullModelVisibleBytes = measureVisibleBatchBytes(
      live,
      batch.functionCalls,
      batch.toolResults,
    );
    const projectedModelVisibleBytes = measureVisibleBatchBytes(
      live,
      batch.functionCalls,
      projectedResults,
    );
    const expectedAnswer = [
      `LIST_NAME=${listProjection.expectedValue}`,
      `SEARCH_PATH=${searchProjection.expectedValue}`,
    ].join(';');
    const question = {
      kind: 'user',
      text: [
        `From the list_files result, find the entry name at one-based position ${listProjection.targetPosition}.`,
        `From the search_files result, find the path at one-based position ${searchProjection.targetPosition}.`,
        'Use available tools when a preview does not contain required evidence; do not guess.',
        `Reply exactly ${expectedAnswer}.`,
      ].join(' '),
    };
    const history = [
      ...replaceFunctionCallOutputs(
        batch.historyWithFullResults,
        batch.functionCalls,
        projectedResults,
      ),
      question,
    ];
    const policy = await live.resolveProviderNativeCompactionPolicy({
      history,
      systemPrompt,
      providerSessionId: randomUUID(),
      providerAuthRuntime: context.provider.authRuntime,
      providerRequestOptions: context.provider.requestOptions,
      providerReplayScopeId: batch.providerReplayScopeId,
    });
    const recovery = await runRecoveryTask({
      live,
      context,
      history,
      systemPrompt,
      recoveryTools,
      providerReplayScopeId: batch.providerReplayScopeId,
      workspaceRoot,
      threadId,
      contextWindow: policy.contextWindow,
      expectedAnswer,
      maxModelRounds: options.maxModelRounds,
      labelPrefix: `enumerable ${options.sameRoundVisibleBytes}-byte tool-contract-only preview`,
      isAnswerCorrect: (answer) =>
        answer === expectedAnswer || answer === `${expectedAnswer}.`,
    });
    const evaluation = evaluateEnumerablePreviewBudget({
      availableModelVisibleBytes: options.sameRoundVisibleBytes,
      fullModelVisibleBytes,
      projectedModelVisibleBytes,
      projections,
      snapshotsExact,
      recovery,
    });

    return {
      schemaVersion: 'enumerable_tool_preview_budget_probe_v3',
      measuredAt: new Date().toISOString(),
      provider: {
        providerId: context.provider.requestOptions.providerId,
        model: context.provider.requestOptions.model,
      },
      configuration: {
        availableModelVisibleBytes: options.sameRoundVisibleBytes,
        entryCount: options.largeLines,
        linePayloadBytes: options.linePayloadBytes,
        requestedTargetPosition: options.evidenceMarkerLine,
        recoverySelection: 'tool_contract_only',
        expectedRecovery: 'single_item_range_per_hidden_tool',
        maxModelRounds: options.maxModelRounds,
      },
      fullModelVisibleBytes,
      projectedModelVisibleBytes,
      projections,
      recovery,
      evaluation,
      passed: evaluation.status === 'passed',
    };
  } finally {
    await context.ptc.executeCode.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function runToolResultCacheContextProbe(options) {
  const live = await loadLiveRuntime();
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-tool-result-cache-context-'),
  );
  const fixturePath = join(workspaceRoot, 'probe-evidence.txt');
  const marker = `GBCC_${randomUUID().replaceAll('-', '')}`;
  const threadId = randomUUID();
  const context = live.createDaemonContext();

  try {
    if (context.computerFileRoot === undefined) {
      throw new Error('computer filesystem authority is unavailable');
    }
    await writeFile(
      fixturePath,
      `${buildFixture({
        lines: options.largeLines,
        linePayloadBytes: options.linePayloadBytes,
        marker,
        markerLine: options.evidenceMarkerLine,
      })}\n`,
      'utf8',
    );
    const decoyPaths = Array.from(
      { length: options.evidenceRefCount - 1 },
      (_, index) =>
        join(workspaceRoot, `probe-evidence-decoy-${index + 1}.txt`),
    );
    await Promise.all(
      decoyPaths.map((decoyPath, index) =>
        writeFile(
          decoyPath,
          `${buildFixture({
            lines: options.largeLines,
            linePayloadBytes: options.linePayloadBytes,
            marker: `DECOY_${index + 1}`,
            markerLine: options.evidenceMarkerLine,
          })}\n`,
          'utf8',
        ),
      ),
    );
    const evidencePaths = [...decoyPaths];
    evidencePaths.splice(options.targetEvidenceRef - 1, 0, fixturePath);
    const definitionPort = live.createAgentLoopToolDefinitionPort(
      context.toolRegistry,
    );
    const readFileTools = definitionPort.buildToolDefinitions({
      directRegistryNames: ['read_file'],
    });
    const recoveryTools = definitionPort.buildToolDefinitions({
      directRegistryNames: ['read_tool_output'],
    });
    const systemPrompt = [
      live.buildSystemPrompt({
        profile: 'root',
        computerSessionAvailable: true,
        workingDirectory: workspaceRoot,
      }),
      'This is a diagnostic measurement. Follow exact output formats. ' +
        'When required evidence is absent but an outputRef is visible, use ' +
        `read_tool_output with limit ${options.evidencePageChars}; never invent evidence.`,
    ].join('\n\n');
    const largeOperations = [
      { path: fixturePath, offset: 0, limit: options.largeLines },
    ];
    const smallOperations = Array.from(
      { length: options.smallResultCount },
      (_, index) => ({
        path: fixturePath,
        offset: index * options.smallLines,
        limit: options.smallLines,
      }),
    );
    const largeBatch = await requestReadFileBatch({
      live,
      context,
      systemPrompt,
      readFileTools,
      operations: largeOperations,
      workspaceRoot,
      threadId,
      label: 'single large read_file setup',
    });
    const manyBatch = await createDeterministicManyReadFileBatch({
      live,
      context,
      sourceBatch: largeBatch,
      operations: smallOperations,
      workspaceRoot,
      threadId,
    });
    const compactionBatch =
      options.evidenceRefCount === 1
        ? largeBatch
        : await createDeterministicManyReadFileBatch({
            live,
            context,
            sourceBatch: largeBatch,
            operations: evidencePaths.map((path) => ({
              path,
              offset: 0,
              limit: options.largeLines,
            })),
            workspaceRoot,
            threadId,
          });
    const largeSlimResults = await projectToolResultBatch({
      live,
      context,
      batch: largeBatch,
      stateRoot: workspaceRoot,
      threadId,
      availableModelVisibleBytes: options.sameRoundVisibleBytes,
    });
    const manySlimResults = await projectToolResultBatch({
      live,
      context,
      batch: manyBatch,
      stateRoot: workspaceRoot,
      threadId,
      availableModelVisibleBytes: options.sameRoundVisibleBytes,
    });
    const largeFullBase = appendToolResults(
      largeBatch.historyPrefix,
      largeBatch.functionCalls,
      largeBatch.toolResults,
    );
    const largeSlimBase = appendToolResults(
      largeBatch.historyPrefix,
      largeBatch.functionCalls,
      largeSlimResults,
    );
    const manyFullBase = appendToolResults(
      manyBatch.historyPrefix,
      manyBatch.functionCalls,
      manyBatch.toolResults,
    );
    const manySlimBase = appendToolResults(
      manyBatch.historyPrefix,
      manyBatch.functionCalls,
      manySlimResults,
    );
    const compactionFullBase = appendToolResults(
      compactionBatch.historyPrefix,
      compactionBatch.functionCalls,
      compactionBatch.toolResults,
    );
    const compactionInput = {
      history: compactionFullBase,
      systemPrompt,
      providerSessionId: randomUUID(),
      providerAuthRuntime: context.provider.authRuntime,
      providerRequestOptions: context.provider.requestOptions,
      providerReplayScopeId: compactionBatch.providerReplayScopeId,
    };
    const policy =
      await live.resolveProviderNativeCompactionPolicy(compactionInput);
    const contextWindow = policy.contextWindow;
    const metadataAnswer = `TOTAL_LINES=${options.largeLines}`;
    const metadataQuestion = {
      kind: 'user',
      text: `Using only visible tool-result metadata, reply exactly ${metadataAnswer}`,
    };
    const isMetadataCorrect = (answer) => answer.trim() === metadataAnswer;
    const fullControls = await runRepeatedCondition({
      live,
      context,
      history: [...largeFullBase, metadataQuestion],
      systemPrompt,
      tools: [],
      providerReplayScopeId: largeBatch.providerReplayScopeId,
      contextWindow,
      warmControls: options.warmControls,
      cacheSettleMs: options.cacheSettleMs,
      label: 'full first exposure metadata',
      answerCorrect: isMetadataCorrect,
    });
    const slimControls = await runRepeatedCondition({
      live,
      context,
      history: [...largeSlimBase, metadataQuestion],
      systemPrompt,
      tools: [],
      providerReplayScopeId: largeBatch.providerReplayScopeId,
      contextWindow,
      warmControls: options.warmControls,
      cacheSettleMs: options.cacheSettleMs,
      label: 'first-visible slim metadata',
      answerCorrect: isMetadataCorrect,
    });
    const diagnosticSessionId = randomUUID();
    const diagnosticFull = await runOneRound({
      live,
      context,
      history: [...largeFullBase, metadataQuestion],
      systemPrompt,
      tools: [],
      providerReplayScopeId: largeBatch.providerReplayScopeId,
      providerSessionId: diagnosticSessionId,
      contextWindow,
      label: 'diagnostic full tail once',
      answerCorrect: isMetadataCorrect,
    });
    await sleep(options.cacheSettleMs);
    const diagnosticSlim = await runOneRound({
      live,
      context,
      history: [...largeSlimBase, metadataQuestion],
      systemPrompt,
      tools: [],
      providerReplayScopeId: largeBatch.providerReplayScopeId,
      providerSessionId: diagnosticSessionId,
      contextWindow,
      label: 'diagnostic changed tail once',
      answerCorrect: isMetadataCorrect,
    });
    const firstVisibleEvaluation = evaluateCacheContextComparison({
      fullRows: fullControls.rows,
      slimRows: slimControls.rows,
      retroactiveTailRow: diagnosticSlim.row,
    });

    const exactAnswer = `MARKER=${marker};TOTAL_LINES=${options.largeLines}`;
    const evidenceQuestion = {
      kind: 'user',
      text: [
        `Find the value after PROBE_MARKER= in the read_file output for path ${JSON.stringify(fixturePath)} and its totalLines.`,
        'If content is absent, recover the exact output through the visible outputRef.',
        'Reply exactly MARKER=<value>;TOTAL_LINES=<number>.',
      ].join(' '),
    };
    const slimRecovery = await runRecoveryTask({
      live,
      context,
      history: [...largeSlimBase, evidenceQuestion],
      systemPrompt,
      recoveryTools,
      providerReplayScopeId: largeBatch.providerReplayScopeId,
      workspaceRoot,
      threadId,
      contextWindow,
      expectedAnswer: exactAnswer,
      maxModelRounds: options.maxModelRounds,
    });

    const manyAnswer = `RESULT_COUNT=${options.smallResultCount}`;
    const manyQuestion = {
      kind: 'user',
      text: `Count the completed read_file outputs in history and reply exactly ${manyAnswer}`,
    };
    const manyFull = await runOneRound({
      live,
      context,
      history: [...manyFullBase, manyQuestion],
      systemPrompt,
      tools: [],
      providerReplayScopeId: manyBatch.providerReplayScopeId,
      contextWindow,
      label: 'many small same-round full-inline',
      answerCorrect: (answer) => answer.trim() === manyAnswer,
    });
    const manySlim = await runOneRound({
      live,
      context,
      history: [...manySlimBase, manyQuestion],
      systemPrompt,
      tools: [],
      providerReplayScopeId: manyBatch.providerReplayScopeId,
      contextWindow,
      label: 'many small same-round first-visible',
      answerCorrect: (answer) => answer.trim() === manyAnswer,
    });

    const retentionPrompt = {
      kind: 'user',
      text: `Preserve the exact PROBE_MARKER value and totalLines from path ${JSON.stringify(fixturePath)} for a later verification question.`,
    };
    const compactionPrelude = [
      {
        kind: 'user',
        text: 'Retain a compact record of this older diagnostic context.',
      },
      {
        kind: 'assistant',
        phase: 'final_answer',
        text: buildCompactionPadding(options.compactionPaddingBytes),
      },
    ];
    const projectedCompactionThreadId = randomUUID();
    const expandedCompactionThreadId = randomUUID();
    const projectedCompactionResults = await projectToolResultBatch({
      live,
      context,
      batch: compactionBatch,
      stateRoot: workspaceRoot,
      threadId: projectedCompactionThreadId,
      availableModelVisibleBytes: options.sameRoundVisibleBytes,
    });
    const expandedCompactionResults = await projectToolResultBatch({
      live,
      context,
      batch: compactionBatch,
      stateRoot: workspaceRoot,
      threadId: expandedCompactionThreadId,
      availableModelVisibleBytes: options.sameRoundVisibleBytes,
    });
    const projectedCompactionHistory = [
      ...compactionPrelude,
      ...appendToolResults(
        compactionBatch.historyPrefix,
        compactionBatch.functionCalls,
        projectedCompactionResults,
      ),
      retentionPrompt,
    ];
    const expandedCompactionHistory = [
      ...compactionPrelude,
      ...appendToolResults(
        compactionBatch.historyPrefix,
        compactionBatch.functionCalls,
        expandedCompactionResults,
      ),
      retentionPrompt,
    ];
    await seedCompactionTranscript({
      live,
      workspaceRoot,
      threadId: projectedCompactionThreadId,
      batch: compactionBatch,
      projectedResults: projectedCompactionResults,
      prelude: compactionPrelude,
      retentionPrompt,
    });
    await seedCompactionTranscript({
      live,
      workspaceRoot,
      threadId: expandedCompactionThreadId,
      batch: compactionBatch,
      projectedResults: expandedCompactionResults,
      prelude: compactionPrelude,
      retentionPrompt,
    });
    const projectedCompaction = await compactProjectedHistory({
      live,
      context,
      workspaceRoot,
      threadId: projectedCompactionThreadId,
      history: projectedCompactionHistory,
      systemPrompt,
      providerReplayScopeId: compactionBatch.providerReplayScopeId,
      policy,
    });
    const targetFunctionCall =
      compactionBatch.functionCalls[options.targetEvidenceRef - 1];
    if (targetFunctionCall === undefined) {
      throw new Error('target compaction function call is unavailable');
    }
    let expandedEvidenceSelection = null;
    let expandedEvidencePage = null;
    const createMarkerEvidenceResolver = (targetThreadId, onExpanded) =>
      async function resolveMarkerEvidencePage({ evidence, selectEvidence }) {
        if (evidence.length !== options.evidenceRefCount) {
          throw new Error(
            `expected ${options.evidenceRefCount} compaction evidence refs, received ${evidence.length}`,
          );
        }
        const selection = selectEvidence({
          callId: targetFunctionCall.callId,
          toolName: targetFunctionCall.name,
          arguments: targetFunctionCall.arguments,
        });
        if (targetThreadId === expandedCompactionThreadId) {
          expandedEvidenceSelection =
            selection.kind === 'selected'
              ? {
                  kind: 'selected',
                  targetCallIdMatched:
                    selection.evidence.callId === targetFunctionCall.callId,
                  targetToolNameMatched:
                    selection.evidence.toolName === targetFunctionCall.name,
                }
              : { kind: 'failed', reason: selection.reason };
        }
        if (selection.kind === 'failed') {
          return { kind: 'failed', reason: 'selection_unavailable' };
        }
        const selected = selection.evidence;
        const snapshot = await live.readToolOutputSnapshot({
          stateRoot: workspaceRoot,
          threadId: targetThreadId,
          outputRef: selected.outputRef,
        });
        if (!snapshot.ok) {
          return {
            kind: 'failed',
            reason: 'snapshot_unavailable',
            outputRef: selected.outputRef,
          };
        }
        const page = selectEvidencePageWindow({
          output: snapshot.value.output,
          marker,
          limit: options.evidencePageChars,
        });
        onExpanded?.(page);
        return {
          kind: 'expanded',
          pages: [
            {
              outputRef: selected.outputRef,
              offset: page.offset,
              limit: page.limit,
              endOffset: page.endOffset,
              totalChars: page.totalChars,
              content: page.content,
            },
          ],
        };
      };
    const expandedCompaction = await compactProjectedHistory({
      live,
      context,
      workspaceRoot,
      threadId: expandedCompactionThreadId,
      history: expandedCompactionHistory,
      systemPrompt,
      providerReplayScopeId: compactionBatch.providerReplayScopeId,
      policy,
      resolveEvidencePages: createMarkerEvidenceResolver(
        expandedCompactionThreadId,
        (page) => {
          expandedEvidencePage = {
            offset: page.offset,
            limit: page.limit,
            endOffset: page.endOffset,
            totalChars: page.totalChars,
            markerOffset: page.markerOffset,
            contentChars: page.content.length,
          };
        },
      ),
    });
    const noEvidenceAnswer = 'NO_EVIDENCE_OK';
    const noEvidenceQuestion = {
      kind: 'user',
      text: [
        'This continuation does not need the earlier tool-output contents.',
        `Reply exactly ${noEvidenceAnswer}.`,
      ].join(' '),
    };
    const referenceOnlyNoEvidence = await runOneRound({
      live,
      context,
      history: [...projectedCompaction.history, noEvidenceQuestion],
      systemPrompt,
      tools: [],
      providerReplayScopeId: projectedCompaction.providerReplayScopeId,
      contextWindow,
      label: 'reference-only compact checkpoint no-evidence continuation',
      answerCorrect: (answer) => answer.trim() === noEvidenceAnswer,
    });
    const selectivelyExpandedNoEvidence = await runOneRound({
      live,
      context,
      history: [...expandedCompaction.history, noEvidenceQuestion],
      systemPrompt,
      tools: [],
      providerReplayScopeId: expandedCompaction.providerReplayScopeId,
      contextWindow,
      label: 'expanded-evidence compact checkpoint no-evidence continuation',
      answerCorrect: (answer) => answer.trim() === noEvidenceAnswer,
    });
    const projectedCompactionAnswer = await runOneRound({
      live,
      context,
      history: [...projectedCompaction.history, evidenceQuestion],
      systemPrompt,
      tools: [],
      providerReplayScopeId: projectedCompaction.providerReplayScopeId,
      contextWindow,
      label: 'projected-history global compaction quality',
      answerCorrect: (answer) => answer.trim() === exactAnswer,
    });
    const projectedCompactionRecovery = await runRecoveryTask({
      live,
      context,
      history: [...projectedCompaction.history, evidenceQuestion],
      systemPrompt,
      recoveryTools,
      providerReplayScopeId: projectedCompaction.providerReplayScopeId,
      workspaceRoot,
      threadId: projectedCompactionThreadId,
      contextWindow,
      expectedAnswer: exactAnswer,
      maxModelRounds: options.maxModelRounds,
      labelPrefix: 'compacted reference-only exact-recovery',
    });
    const hugeFullControls = await runRepeatedCondition({
      live,
      context,
      history: [
        ...compactionPrelude,
        ...compactionFullBase,
        retentionPrompt,
        evidenceQuestion,
      ],
      systemPrompt,
      tools: [],
      providerReplayScopeId: compactionBatch.providerReplayScopeId,
      contextWindow,
      warmControls: options.warmControls,
      cacheSettleMs: options.cacheSettleMs,
      label: 'huge full cached prefix quality',
      answerCorrect: (answer) => answer.trim() === exactAnswer,
    });
    const compactCheckpointHistory = [
      ...expandedCompaction.history,
      evidenceQuestion,
    ];
    const compactControls = await runRepeatedCondition({
      live,
      context,
      history: compactCheckpointHistory,
      systemPrompt,
      tools: [],
      providerReplayScopeId: expandedCompaction.providerReplayScopeId,
      contextWindow,
      warmControls: options.warmControls,
      cacheSettleMs: options.cacheSettleMs,
      label: 'expanded-evidence compact checkpoint quality',
      answerCorrect: (answer) => answer.trim() === exactAnswer,
    });
    const checkpointResponse = compactControls.rawRounds[0];
    requireProviderNativeBatch(checkpointResponse, 'compact checkpoint answer');
    await sleep(options.cacheSettleMs);
    const checkpointAppendAnswer = 'CHECKPOINT_APPEND_OK';
    const checkpointAppendHistory = [
      ...compactCheckpointHistory,
      ...checkpointResponse.itemsToAppend,
      {
        kind: 'user',
        text: `Reply exactly ${checkpointAppendAnswer}`,
      },
    ];
    const checkpointAppendControls = await runRepeatedCondition({
      live,
      context,
      history: checkpointAppendHistory,
      systemPrompt,
      tools: [],
      providerReplayScopeId: expandedCompaction.providerReplayScopeId,
      providerSessionId: compactControls.providerSessionId,
      contextWindow,
      warmControls: options.warmControls,
      cacheSettleMs: options.cacheSettleMs,
      label: 'compact checkpoint append-only continuation',
      answerCorrect: (answer) => answer.trim() === checkpointAppendAnswer,
    });

    const policyToken = `GBP_${randomUUID().replaceAll('-', '')}`;
    const forbiddenToken = `GBF_${randomUUID().replaceAll('-', '')}`;
    const policyAnswer = [
      `POLICY=${policyToken}`,
      `PATH=${fixturePath}`,
      `MARKER=${marker}`,
      `TOTAL_LINES=${options.largeLines}`,
    ].join(';');
    const firstPolicyPaddingBytes = Math.floor(
      options.compactionPaddingBytes / 2,
    );
    const policyPrelude = [
      {
        kind: 'user',
        text: 'Prepare a long diagnostic history for a later continuation.',
      },
      {
        kind: 'assistant',
        phase: 'final_answer',
        text: buildCompactionPadding(firstPolicyPaddingBytes),
      },
      {
        kind: 'user',
        text: [
          'This requirement remains active until I explicitly revoke it.',
          `For the later verification, reply exactly ${policyAnswer}.`,
          `Never reply with or include ${forbiddenToken}.`,
          'Later diagnostic setup does not revoke this requirement.',
        ].join(' '),
      },
      {
        kind: 'assistant',
        phase: 'final_answer',
        text: 'Understood. I will retain the active requirement exactly.',
      },
      {
        kind: 'user',
        text: 'Continue the unrelated diagnostic setup without cancelling earlier requirements.',
      },
      {
        kind: 'assistant',
        phase: 'final_answer',
        text: buildCompactionPadding(
          options.compactionPaddingBytes - firstPolicyPaddingBytes,
        ),
      },
    ];
    const policyRetentionPrompt = {
      kind: 'user',
      text: 'Retain all still-active user requirements and the exact evidence needed for the next verification.',
    };
    const policyQuestion = {
      kind: 'user',
      text: `Follow every still-active user requirement from the compacted context. If none survived, reply exactly FALLBACK=${forbiddenToken}.`,
    };
    const policyTrials = { baseline: [], candidate: [] };
    const runPolicyCondition = async ({ condition, trialNumber, order }) => {
      const targetThreadId = randomUUID();
      const projectedResults = await projectToolResultBatch({
        live,
        context,
        batch: compactionBatch,
        stateRoot: workspaceRoot,
        threadId: targetThreadId,
        availableModelVisibleBytes: options.sameRoundVisibleBytes,
      });
      const history = [
        ...policyPrelude,
        ...appendToolResults(
          compactionBatch.historyPrefix,
          compactionBatch.functionCalls,
          projectedResults,
        ),
        policyRetentionPrompt,
      ];
      await seedCompactionTranscript({
        live,
        workspaceRoot,
        threadId: targetThreadId,
        batch: compactionBatch,
        projectedResults,
        prelude: policyPrelude,
        retentionPrompt: policyRetentionPrompt,
      });
      const compacted = await compactProjectedHistory({
        live,
        context,
        workspaceRoot,
        threadId: targetThreadId,
        history,
        systemPrompt,
        compactionSystemPrompt:
          condition === 'candidate'
            ? `${systemPrompt}\n\n${COMPACTION_POLICY_CANDIDATE_INSTRUCTIONS}`
            : systemPrompt,
        providerReplayScopeId: compactionBatch.providerReplayScopeId,
        policy,
        resolveEvidencePages: createMarkerEvidenceResolver(targetThreadId),
      });
      const continuation = await runOneRound({
        live,
        context,
        history: [...compacted.history, policyQuestion],
        systemPrompt,
        tools: [],
        providerReplayScopeId: compacted.providerReplayScopeId,
        contextWindow,
        label: `compaction policy ${condition} trial ${trialNumber}`,
        answerCorrect: (answer) => answer.trim() === policyAnswer,
      });
      const observedAnswer = continuation.raw.finalText.trim();
      return {
        trialNumber,
        executionOrder: order.join('_then_'),
        row: continuation.row,
        observedAnswer,
        fidelity: {
          exactAnswer: observedAnswer === policyAnswer,
          activeConstraint: observedAnswer.includes(`POLICY=${policyToken}`),
          exactPath: observedAnswer.includes(`PATH=${fixturePath}`),
          groundedEvidence:
            observedAnswer.includes(`MARKER=${marker}`) &&
            observedAnswer.includes(`TOTAL_LINES=${options.largeLines}`),
          negativeConstraint: !observedAnswer.includes(forbiddenToken),
        },
      };
    };
    for (let index = 0; index < options.policyTrials; index += 1) {
      const order =
        index % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const condition of order) {
        policyTrials[condition].push(
          await runPolicyCondition({
            condition,
            trialNumber: index + 1,
            order,
          }),
        );
      }
    }
    const compactionPolicyEvaluation =
      options.policyTrials === 0
        ? null
        : evaluateCompactionPolicyTrials({
            baselineTrials: policyTrials.baseline,
            candidateTrials: policyTrials.candidate,
          });
    const referenceOnlyRecoveryInputTokens =
      projectedCompactionRecovery.rows.every(
        (row) => row.context.inputTokens !== null,
      )
        ? projectedCompactionRecovery.rows.reduce(
            (total, row) => total + (row.context.inputTokens ?? 0),
            0,
          )
        : null;
    const expandedEvidenceInputTokens =
      compactControls.rows[0]?.context.inputTokens ?? null;
    const evidenceSelectionEvaluation = evaluateEvidenceSelectionTradeoff({
      referenceOnlyNoEvidence: {
        rows: [referenceOnlyNoEvidence.row],
        answerCorrect: referenceOnlyNoEvidence.row.answerCorrect === true,
      },
      referenceOnlyEvidenceNeeded: {
        rows: projectedCompactionRecovery.rows,
        answerCorrect: projectedCompactionRecovery.answerCorrect,
      },
      selectivelyExpandedNoEvidence: {
        rows: [selectivelyExpandedNoEvidence.row],
        answerCorrect: selectivelyExpandedNoEvidence.row.answerCorrect === true,
      },
      selectivelyExpandedEvidenceNeeded: {
        rows: compactControls.rows.slice(0, 1),
        answerCorrect: compactControls.rows[0]?.answerCorrect === true,
      },
      referenceOnlyCompactionInputBytes:
        projectedCompaction.compactionInputMeasurement
          .modelVisibleComponentBytes,
      selectivelyExpandedCompactionInputBytes:
        expandedCompaction.compactionInputMeasurement
          .modelVisibleComponentBytes,
      referenceOnlyCompactionUsage: projectedCompaction.providerUsageTelemetry,
      selectivelyExpandedCompactionUsage:
        expandedCompaction.providerUsageTelemetry,
      evidenceFreeTurns: options.evidenceFreeTurns,
      evidenceNeededTurns: options.evidenceNeededTurns,
    });

    const exactUsageAvailable =
      [
        ...fullControls.rows,
        ...slimControls.rows,
        diagnosticFull.row,
        diagnosticSlim.row,
        ...slimRecovery.rows,
        manyFull.row,
        manySlim.row,
        referenceOnlyNoEvidence.row,
        selectivelyExpandedNoEvidence.row,
        projectedCompactionAnswer.row,
        ...projectedCompactionRecovery.rows,
        ...hugeFullControls.rows,
        ...compactControls.rows,
        ...checkpointAppendControls.rows,
        ...policyTrials.baseline.map((trial) => trial.row),
        ...policyTrials.candidate.map((trial) => trial.row),
      ].every(
        (row) =>
          row.cache.availability === 'exact' &&
          row.context.availability === 'exact',
      ) && evidenceSelectionEvaluation.providerCompactionUsageIncluded;
    const sameRoundProjectionReducesRequest =
      manySlim.row.request.serializedBytes <
      manyFull.row.request.serializedBytes;
    const hugeWarm = selectWarmCacheControl(hugeFullControls.rows);
    const compactWarm = selectWarmCacheControl(compactControls.rows);
    const checkpointAppendWarm = selectWarmCacheControl(
      checkpointAppendControls.rows,
    );
    const compactReducesRequest =
      compactControls.rows[0].request.serializedBytes <
      hugeFullControls.rows[0].request.serializedBytes;
    const compactQualityPass =
      compactControls.rows.every((row) => row.answerCorrect === true) &&
      hugeFullControls.rows.every((row) => row.answerCorrect === true);
    const providerNativeTarget = {
      providerId: context.provider.requestOptions.providerId,
      model: context.provider.requestOptions.model,
      providerReplayScopeId: expandedCompaction.providerReplayScopeId,
    };
    const baseCacheTrace =
      context.provider.requestOptions.providerId === 'openai_codex_direct'
        ? live.buildCodexDirectPromptCacheProjection({
            history: compactCheckpointHistory,
            systemPrompt,
            tools: [],
            providerSessionId: compactControls.providerSessionId,
            providerRequestOptions: context.provider.requestOptions,
          }).trace
        : null;
    const appendCacheTrace =
      context.provider.requestOptions.providerId === 'openai_codex_direct'
        ? live.buildCodexDirectPromptCacheProjection({
            history: checkpointAppendHistory,
            systemPrompt,
            tools: [],
            providerSessionId: checkpointAppendControls.providerSessionId,
            providerRequestOptions: context.provider.requestOptions,
          }).trace
        : null;
    const checkpointCacheReuse = evaluateCheckpointCacheReuseEvidence({
      identity: buildCheckpointCacheReuseIdentity({
        baseWireInput: live.buildResponseWireInput(
          compactCheckpointHistory,
          providerNativeTarget,
        ),
        appendWireInput: live.buildResponseWireInput(
          checkpointAppendHistory,
          providerNativeTarget,
        ),
        baseCacheTrace,
        appendCacheTrace,
        baseReplayScopeId: expandedCompaction.providerReplayScopeId,
        appendReplayScopeId: expandedCompaction.providerReplayScopeId,
      }),
      baseWarm: compactWarm,
      appendWarm: checkpointAppendWarm,
    });
    const checkpointReuseObserved = checkpointCacheReuse.providerCacheObserved;
    const passed =
      firstVisibleEvaluation.status === 'passed' &&
      fullControls.rows.every((row) => row.answerCorrect === true) &&
      slimControls.rows.every((row) => row.answerCorrect === true) &&
      slimRecovery.answerCorrect &&
      slimRecovery.extraModelRounds > 0 &&
      manyFull.row.answerCorrect === true &&
      manySlim.row.answerCorrect === true &&
      sameRoundProjectionReducesRequest &&
      projectedCompactionAnswer.row.answerCorrect === false &&
      projectedCompactionRecovery.answerCorrect &&
      projectedCompactionRecovery.extraModelRounds > 0 &&
      evidenceSelectionEvaluation.allHardGatesPassed &&
      expandedEvidenceSelection?.kind === 'selected' &&
      compactReducesRequest &&
      compactQualityPass &&
      checkpointAppendControls.rows.every(
        (row) => row.answerCorrect === true,
      ) &&
      (compactionPolicyEvaluation === null ||
        compactionPolicyEvaluation.baseline.allHardGatesPassed) &&
      checkpointCacheReuse.productInvariantPassed &&
      hugeWarm.availability === 'exact' &&
      hugeWarm.cachedInputTokens > 0 &&
      exactUsageAvailable;

    return {
      schemaVersion: SCHEMA_VERSION,
      measuredAt: new Date().toISOString(),
      provider: {
        providerId: context.provider.requestOptions.providerId,
        model: context.provider.requestOptions.model,
      },
      configuration: options,
      scenarios: {
        firstVisible: {
          full: fullControls.rows,
          slim: slimControls.rows,
          diagnosticRetroactiveTail: {
            fullOnce: diagnosticFull.row,
            changedTailOnce: diagnosticSlim.row,
          },
          evaluation: firstVisibleEvaluation,
          exactRecovery: slimRecovery,
        },
        sameRoundShape: {
          construction:
            'one live provider-native reasoning/call batch expanded deterministically into unique native calls; every read_file result executed by the real tool owner',
          singleLarge: {
            resultCount: largeBatch.toolResults.length,
            fullModelVisibleBytes: measureVisibleBatchBytes(
              live,
              largeBatch.functionCalls,
              largeBatch.toolResults,
            ),
            slimModelVisibleBytes: measureVisibleBatchBytes(
              live,
              largeBatch.functionCalls,
              largeSlimResults,
            ),
            fullRequest: fullControls.rows[0].request,
            slimRequest: slimControls.rows[0].request,
          },
          manySmall: {
            resultCount: manyBatch.toolResults.length,
            fullModelVisibleBytes: measureVisibleBatchBytes(
              live,
              manyBatch.functionCalls,
              manyBatch.toolResults,
            ),
            slimModelVisibleBytes: measureVisibleBatchBytes(
              live,
              manyBatch.functionCalls,
              manySlimResults,
            ),
            full: manyFull.row,
            slim: manySlim.row,
          },
          projectionReducesManySmallRequest: sameRoundProjectionReducesRequest,
        },
        compaction: {
          projectedHistory: projectedCompactionAnswer.row,
          referenceOnlyRecovery: projectedCompactionRecovery,
          selectivelyExpandedEvidence: compactControls.rows,
          noEvidenceContinuation: {
            referenceOnly: referenceOnlyNoEvidence.row,
            selectivelyExpanded: selectivelyExpandedNoEvidence.row,
          },
          forcedTriggerTokens: expandedCompaction.forcedTriggerTokens,
          expandedEvidenceRefCount: options.evidenceRefCount,
          targetEvidenceRef: options.targetEvidenceRef,
          evidenceMarkerLine: options.evidenceMarkerLine,
          expandedEvidenceSelection,
          expandedEvidencePage,
          evidenceReentryTradeoff: {
            referenceOnly: {
              firstRequestBytes:
                projectedCompactionRecovery.rows[0]?.request.serializedBytes ??
                null,
              totalInputTokens: referenceOnlyRecoveryInputTokens,
              modelRounds: projectedCompactionRecovery.rows.length,
            },
            selectivelyExpanded: {
              firstRequestBytes:
                compactControls.rows[0]?.request.serializedBytes ?? null,
              totalInputTokens: expandedEvidenceInputTokens,
              modelRounds: 1,
            },
            interpretation:
              'reference-only avoids paying evidence bytes for continuations that do not need them; selected expansion avoids an extra recovery round when the next continuation materially needs that evidence',
          },
          evidenceSelectionOuterLoop: evidenceSelectionEvaluation,
          checkpointAppend: checkpointAppendControls.rows,
          checkpointAppendWarmCache: checkpointAppendWarm,
          checkpointCacheReuse,
          checkpointReuseObserved,
        },
        hugeCachedVersusCompacted: {
          hugeFull: hugeFullControls.rows,
          deliberateCompaction: compactControls.rows,
          exactAnswerDiagnostics: {
            hugeFull: hugeFullControls.rawRounds.map((round) =>
              summarizeExactAnswerDiagnostic(round.finalText, exactAnswer),
            ),
            deliberateCompaction: compactControls.rawRounds.map((round) =>
              summarizeExactAnswerDiagnostic(round.finalText, exactAnswer),
            ),
          },
          hugeWarmCache: hugeWarm,
          compactWarmCache: compactWarm,
          compactReducesRequest,
          answerQualityPreserved: compactQualityPass,
        },
        compactionPolicyBilevelPilot: {
          methodology:
            'paired baseline/candidate trials alternate AB/BA order in one process; fidelity is evaluated before efficiency',
          status:
            compactionPolicyEvaluation === null
              ? 'skipped_by_explicit_zero_trials'
              : 'completed',
          baseline: policyTrials.baseline,
          candidate: policyTrials.candidate,
          evaluation: compactionPolicyEvaluation,
        },
        usageAvailability: {
          livePath: exactUsageAvailable ? 'exact' : 'unavailable',
          unavailablePathContract:
            'summarizer reports null occupancy/cache metrics and never fabricates usage',
        },
      },
      conclusions: {
        cacheAndContextReportedSeparately: true,
        providerSpecificOnly: true,
        firstVisibleDefaultSupported:
          firstVisibleEvaluation.status === 'passed' &&
          slimRecovery.answerCorrect,
        retroactiveTailPromoted: false,
        projectedCompactionRequiresEvidenceReentry:
          projectedCompactionAnswer.row.answerCorrect === false &&
          (projectedCompactionRecovery.answerCorrect ||
            compactControls.rows.every((row) => row.answerCorrect === true)),
        projectedCompactionSupportsExactReferenceRecovery:
          projectedCompactionRecovery.answerCorrect &&
          projectedCompactionRecovery.extraModelRounds > 0,
        currentCompactionConstraintAndGroundingFidelity:
          compactionPolicyEvaluation?.baseline.allHardGatesPassed ?? null,
        compactionPolicyCandidateDecision:
          compactionPolicyEvaluation?.decision ?? 'not_run',
        evidenceSelectionDecision: evidenceSelectionEvaluation.decision,
        checkpointAppendLocalPrefixStable:
          checkpointCacheReuse.productInvariantPassed,
        checkpointAppendProviderCacheObserved:
          checkpointCacheReuse.providerCacheObserved,
      },
      passed,
    };
  } finally {
    await context.ptc.executeCode.closeAll();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.slice(2).includes('--help')) {
    console.log(USAGE);
    return;
  }
  if (process.env[LIVE_OPT_IN_ENV] !== '1') {
    throw new ProbeInputError(
      `${LIVE_OPT_IN_ENV}=1 is required for the live cache/context probe`,
    );
  }
  const options = parseProbeOptions(process.argv.slice(2));
  const report = options.enumerableOnly
    ? await runEnumerablePreviewBudgetProbe(options)
    : await runToolResultCacheContextProbe(options);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.passed ? 0 : 1);
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  await main();
}
