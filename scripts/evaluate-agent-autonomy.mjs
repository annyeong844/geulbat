import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_:-]{0,127}$/u;

const AGENT_AUTONOMY_INTERVENTION_REASONS = Object.freeze([
  'approval_or_authority',
  'consequential_user_decision',
  'provider_auth',
  'provider_transition',
  'infrastructure_unavailable',
  'no_progress',
  'budget_or_resource_limit',
  'user_cancel',
]);

const INTERVENTION_REASON_SET = new Set(AGENT_AUTONOMY_INTERVENTION_REASONS);
const ORACLE_OUTCOMES = new Set([
  'verified_completed',
  'verified_failed',
  'unresolved',
]);
const TERMINAL_OUTCOMES = new Set(['completed', 'failed', 'cancelled']);
const COUNT_FIELDS = Object.freeze([
  'count',
  'justified',
  'avoidable',
  'unresolved',
  'observedLatencyMs',
  'unresolvedLatencyCount',
]);
const OBSERVATION_FIELDS = Object.freeze({
  run_started: {},
  progress_verified: { evidenceReferenceId: digest },
  intervention_required: {
    interventionReferenceId: digest,
    reason: interventionReason,
  },
  intervention_resolved: { interventionReferenceId: digest },
  recovery_started: { recoveryReferenceId: digest },
  recovery_completed: { recoveryReferenceId: digest },
  side_effect_committed: { sideEffectReferenceId: digest },
  provider_usage: {
    providerReferenceId: safeCode,
    inputTokens: nonNegativeInteger,
    cachedInputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    costMicrousd: nullableNonNegativeInteger,
  },
  tool_usage: {
    toolInvocationCount: nonNegativeInteger,
    toolFailureCount: nonNegativeInteger,
    observedDurationMs: nonNegativeInteger,
  },
  run_terminal: { outcome: terminalOutcome },
});

export function createAgentAutonomyWorkloadDeclaration(value) {
  const source = exactRecord(value, 'agent autonomy workload declaration', [
    'schemaVersion',
    'workloadKind',
    'registeredAt',
    'tasks',
  ]);
  if (
    source.schemaVersion !== 1 ||
    source.workloadKind !== 'agent_autonomy_workload_declaration'
  ) {
    throw new Error('unsupported agent autonomy workload declaration');
  }
  const declaration = {
    schemaVersion: 1,
    workloadKind: 'agent_autonomy_workload_declaration',
    registeredAt: timestamp(source.registeredAt, 'registeredAt'),
    tasks: array(source.tasks, 'tasks').map(parseTask),
  };
  if (declaration.tasks.length === 0) {
    throw new Error('agent autonomy workload declaration requires a task');
  }
  assertUnique(
    declaration.tasks.map((task) => task.taskReferenceId),
    'taskReferenceId',
  );
  const attemptReferences = declaration.tasks.flatMap(
    (task) => task.attemptReferences,
  );
  assertUnique(attemptReferences, 'attemptReference');
  const body = Object.freeze({
    ...declaration,
    tasks: Object.freeze(declaration.tasks),
  });
  return Object.freeze({
    ...body,
    workloadReferenceId: `sha256:${sha256StableJson(body)}`,
  });
}

export function parseAgentAutonomyWorkload(value) {
  const source = exactRecord(value, 'agent autonomy workload', [
    'schemaVersion',
    'workloadKind',
    'workloadReferenceId',
    'registeredAt',
    'tasks',
    'attempts',
  ]);
  if (
    source.schemaVersion !== 1 ||
    source.workloadKind !== 'agent_autonomy_workload'
  ) {
    throw new Error('unsupported agent autonomy workload');
  }
  const declaration = createAgentAutonomyWorkloadDeclaration({
    schemaVersion: source.schemaVersion,
    workloadKind: 'agent_autonomy_workload_declaration',
    registeredAt: source.registeredAt,
    tasks: source.tasks,
  });
  const workloadReferenceId = digest(
    source.workloadReferenceId,
    'workloadReferenceId',
  );
  if (workloadReferenceId !== declaration.workloadReferenceId) {
    throw new Error(
      'agent autonomy workload does not match its content-addressed declaration',
    );
  }
  const workload = {
    schemaVersion: 1,
    workloadKind: 'agent_autonomy_workload',
    workloadReferenceId,
    registeredAt: declaration.registeredAt,
    tasks: declaration.tasks,
    attempts: array(source.attempts, 'attempts').map(parseAttempt),
  };
  assertUnique(
    workload.attempts.map((attempt) => attempt.attemptReference),
    'attemptReference',
  );
  const expectedAttempts = new Map();
  for (const task of workload.tasks) {
    for (const attemptReference of task.attemptReferences) {
      if (expectedAttempts.has(attemptReference)) {
        throw new Error(
          `agent autonomy workload repeats attemptReference ${attemptReference}`,
        );
      }
      expectedAttempts.set(attemptReference, task.taskReferenceId);
    }
  }
  if (workload.attempts.length !== expectedAttempts.size) {
    throw new Error(
      'agent autonomy workload attempts do not cover the registered attempt set',
    );
  }
  for (const attempt of workload.attempts) {
    if (
      expectedAttempts.get(attempt.attemptReference) !== attempt.taskReferenceId
    ) {
      throw new Error(
        `agent autonomy attempt ${attempt.attemptReference} does not match its registered task`,
      );
    }
    if (
      Date.parse(workload.registeredAt) > Date.parse(attempt.observations[0].at)
    ) {
      throw new Error(
        `agent autonomy workload was registered after attempt ${attempt.attemptReference} started`,
      );
    }
  }
  return Object.freeze({
    ...workload,
    tasks: Object.freeze(workload.tasks),
    attempts: Object.freeze(workload.attempts),
  });
}

export function evaluateAgentAutonomyWorkload(value) {
  const workload = parseAgentAutonomyWorkload(value);
  const attemptsByReference = new Map(
    workload.attempts.map((attempt) => [attempt.attemptReference, attempt]),
  );
  const attemptResults = new Map();
  const tasks = workload.tasks.map((task) => {
    const policy = new Map(
      task.interventionRules.map((rule) => [rule.reason, rule.necessity]),
    );
    const attempts = task.attemptReferences.map((reference) => {
      const result = evaluateAttempt(
        attemptsByReference.get(reference),
        policy,
      );
      attemptResults.set(reference, result);
      return result;
    });
    return Object.freeze({
      taskReferenceId: task.taskReferenceId,
      eligibility: task.eligibility,
      eligibilityReason: task.eligibilityReason,
      attemptReferences: task.attemptReferences,
      passed:
        task.eligibility === 'eligible' &&
        attempts.every((attempt) => attempt.passed),
    });
  });
  const attempts = workload.attempts.map((attempt) =>
    attemptResults.get(attempt.attemptReference),
  );
  const eligibleTasks = tasks.filter((task) => task.eligibility === 'eligible');
  const passedTaskCount = eligibleTasks.filter((task) => task.passed).length;
  return Object.freeze({
    schemaVersion: 1,
    reportKind: 'agent_autonomy_workload_report',
    workloadReferenceId: workload.workloadReferenceId,
    registeredAt: workload.registeredAt,
    primary: Object.freeze({
      metric: 'verified_task_completion_without_avoidable_human_intervention',
      eligibleTaskCount: eligibleTasks.length,
      passedTaskCount,
      rate: Object.freeze({
        numerator: passedTaskCount,
        denominator: eligibleTasks.length,
      }),
    }),
    supporting: aggregateAttempts(attempts),
    tasks: Object.freeze(tasks),
    attempts: Object.freeze(attempts),
  });
}

function parseTask(value, index) {
  const label = `tasks[${index}]`;
  const source = exactRecord(value, label, [
    'taskReferenceId',
    'eligibility',
    'eligibilityReason',
    'attemptReferences',
    'interventionRules',
  ]);
  if (source.eligibility !== 'eligible' && source.eligibility !== 'excluded') {
    throw new Error(`${label}.eligibility is invalid`);
  }
  const attemptReferences = array(
    source.attemptReferences,
    `${label}.attemptReferences`,
  ).map((entry, entryIndex) =>
    digest(entry, `${label}.attemptReferences[${entryIndex}]`),
  );
  if (attemptReferences.length === 0) {
    throw new Error(`${label} requires at least one registered attempt`);
  }
  assertUnique(attemptReferences, `${label}.attemptReferences`);
  const interventionRules = array(
    source.interventionRules,
    `${label}.interventionRules`,
  ).map((rule, ruleIndex) => {
    const ruleLabel = `${label}.interventionRules[${ruleIndex}]`;
    const parsed = exactRecord(rule, ruleLabel, ['reason', 'necessity']);
    const reason = interventionReason(parsed.reason, `${ruleLabel}.reason`);
    if (parsed.necessity !== 'justified' && parsed.necessity !== 'avoidable') {
      throw new Error(`${ruleLabel}.necessity is invalid`);
    }
    return Object.freeze({ reason, necessity: parsed.necessity });
  });
  assertUnique(
    interventionRules.map((rule) => rule.reason),
    `${label}.interventionRules.reason`,
  );
  return Object.freeze({
    taskReferenceId: digest(source.taskReferenceId, `${label}.taskReferenceId`),
    eligibility: source.eligibility,
    eligibilityReason: safeCode(
      source.eligibilityReason,
      `${label}.eligibilityReason`,
    ),
    attemptReferences: Object.freeze(attemptReferences),
    interventionRules: Object.freeze(interventionRules),
  });
}

function parseAttempt(value, index) {
  const label = `attempts[${index}]`;
  const source = exactRecord(value, label, [
    'attemptReference',
    'taskReferenceId',
    'oracle',
    'observations',
  ]);
  const observations = array(source.observations, `${label}.observations`).map(
    (observation, observationIndex) =>
      parseObservation(
        observation,
        `${label}.observations[${observationIndex}]`,
      ),
  );
  if (
    observations.length < 2 ||
    observations[0].kind !== 'run_started' ||
    observations.at(-1).kind !== 'run_terminal'
  ) {
    throw new Error(
      `${label}.observations must start with run_started and end with run_terminal`,
    );
  }
  for (let cursor = 1; cursor < observations.length; cursor += 1) {
    if (
      Date.parse(observations[cursor].at) <
      Date.parse(observations[cursor - 1].at)
    ) {
      throw new Error(`${label}.observations are not time ordered`);
    }
  }
  const oracle = exactRecord(source.oracle, `${label}.oracle`, [
    'outcome',
    'evidenceReferenceId',
  ]);
  if (!ORACLE_OUTCOMES.has(oracle.outcome)) {
    throw new Error(`${label}.oracle.outcome is invalid`);
  }
  return Object.freeze({
    attemptReference: digest(
      source.attemptReference,
      `${label}.attemptReference`,
    ),
    taskReferenceId: digest(source.taskReferenceId, `${label}.taskReferenceId`),
    oracle: Object.freeze({
      outcome: oracle.outcome,
      evidenceReferenceId: digest(
        oracle.evidenceReferenceId,
        `${label}.oracle.evidenceReferenceId`,
      ),
    }),
    observations: Object.freeze(observations),
  });
}

function parseObservation(value, label) {
  const source = recordValue(value, label);
  const kind = safeCode(source.kind, `${label}.kind`);
  const fields = OBSERVATION_FIELDS[kind];
  if (fields === undefined) {
    throw new Error(`${label}.kind is unsupported`);
  }
  exactRecord(source, label, ['kind', 'at', ...Object.keys(fields)]);
  const observation = { kind, at: timestamp(source.at, `${label}.at`) };
  for (const [field, parse] of Object.entries(fields)) {
    observation[field] = parse(source[field], `${label}.${field}`);
  }
  if (
    kind === 'provider_usage' &&
    observation.cachedInputTokens > observation.inputTokens
  ) {
    throw new Error(`${label}.cachedInputTokens exceeds inputTokens`);
  }
  if (
    kind === 'tool_usage' &&
    observation.toolFailureCount > observation.toolInvocationCount
  ) {
    throw new Error(`${label}.toolFailureCount exceeds toolInvocationCount`);
  }
  return Object.freeze(observation);
}

function evaluateAttempt(attempt, interventionPolicy) {
  const startMs = Date.parse(attempt.observations[0].at);
  const terminal = attempt.observations.at(-1);
  const terminalMs = Date.parse(terminal.at);
  const openInterventions = new Map();
  const interventions = createInterventionTotals();
  const openRecoveries = new Map();
  const recoveryLatencies = [];
  const sideEffects = new Set();
  const providerUsage = new Map();
  const toolUsage = {
    invocationCount: 0,
    failureCount: 0,
    observedDurationMs: 0,
  };
  let duplicateSideEffectCount = 0;
  let usefulAutonomousDurationMs = 0;
  let activeWindowStartMs = startMs;
  let interventionWaitStartMs = null;
  let interventionWaitDurationMs = 0;

  for (const observation of attempt.observations.slice(1, -1)) {
    const atMs = Date.parse(observation.at);
    if (observation.kind === 'progress_verified') {
      if (openInterventions.size === 0 && activeWindowStartMs !== null) {
        usefulAutonomousDurationMs += atMs - activeWindowStartMs;
        activeWindowStartMs = atMs;
      }
    } else if (observation.kind === 'intervention_required') {
      if (openInterventions.has(observation.interventionReferenceId)) {
        throw new Error(
          `agent autonomy attempt repeats intervention ${observation.interventionReferenceId}`,
        );
      }
      const necessity =
        interventionPolicy.get(observation.reason) ?? 'unresolved';
      openInterventions.set(observation.interventionReferenceId, {
        reason: observation.reason,
        necessity,
        startedAtMs: atMs,
      });
      const totals = interventions[observation.reason];
      totals.count += 1;
      totals[necessity] += 1;
      if (openInterventions.size === 1) {
        activeWindowStartMs = null;
        interventionWaitStartMs = atMs;
      }
    } else if (observation.kind === 'intervention_resolved') {
      const opened = openInterventions.get(observation.interventionReferenceId);
      if (opened === undefined) {
        throw new Error(
          `agent autonomy attempt resolves unknown intervention ${observation.interventionReferenceId}`,
        );
      }
      interventions[opened.reason].observedLatencyMs +=
        atMs - opened.startedAtMs;
      openInterventions.delete(observation.interventionReferenceId);
      if (openInterventions.size === 0) {
        interventionWaitDurationMs += atMs - interventionWaitStartMs;
        interventionWaitStartMs = null;
        activeWindowStartMs = atMs;
      }
    } else if (observation.kind === 'recovery_started') {
      if (openRecoveries.has(observation.recoveryReferenceId)) {
        throw new Error(
          `agent autonomy attempt repeats recovery ${observation.recoveryReferenceId}`,
        );
      }
      openRecoveries.set(observation.recoveryReferenceId, atMs);
    } else if (observation.kind === 'recovery_completed') {
      const recoveryStartMs = openRecoveries.get(
        observation.recoveryReferenceId,
      );
      if (recoveryStartMs === undefined) {
        throw new Error(
          `agent autonomy attempt completes unknown recovery ${observation.recoveryReferenceId}`,
        );
      }
      recoveryLatencies.push(atMs - recoveryStartMs);
      openRecoveries.delete(observation.recoveryReferenceId);
    } else if (observation.kind === 'side_effect_committed') {
      duplicateSideEffectCount += Number(
        sideEffects.has(observation.sideEffectReferenceId),
      );
      sideEffects.add(observation.sideEffectReferenceId);
    } else if (observation.kind === 'provider_usage') {
      mergeProviderUsage(providerUsage, {
        providerReferenceId: observation.providerReferenceId,
        inputTokens: observation.inputTokens,
        cachedInputTokens: observation.cachedInputTokens,
        outputTokens: observation.outputTokens,
        observedCostMicrousd: observation.costMicrousd ?? 0,
        missingCostObservationCount: Number(observation.costMicrousd === null),
      });
    } else if (observation.kind === 'tool_usage') {
      toolUsage.invocationCount += observation.toolInvocationCount;
      toolUsage.failureCount += observation.toolFailureCount;
      toolUsage.observedDurationMs += observation.observedDurationMs;
    }
  }

  if (openInterventions.size > 0) {
    interventionWaitDurationMs += terminalMs - interventionWaitStartMs;
    for (const opened of openInterventions.values()) {
      interventions[opened.reason].unresolvedLatencyCount += 1;
    }
  }
  const correctlyCompleted =
    terminal.outcome === 'completed' &&
    attempt.oracle.outcome === 'verified_completed';
  if (
    correctlyCompleted &&
    openInterventions.size === 0 &&
    activeWindowStartMs !== null
  ) {
    usefulAutonomousDurationMs += terminalMs - activeWindowStartMs;
  }
  const interventionSummary = summarizeInterventions(interventions);
  const totalElapsedMs = terminalMs - startMs;
  const timelineComplete =
    openInterventions.size === 0 && openRecoveries.size === 0;
  return Object.freeze({
    attemptReference: attempt.attemptReference,
    taskReferenceId: attempt.taskReferenceId,
    oracleOutcome: attempt.oracle.outcome,
    oracleEvidenceReferenceId: attempt.oracle.evidenceReferenceId,
    terminalOutcome: terminal.outcome,
    correctlyCompleted,
    passed:
      correctlyCompleted &&
      timelineComplete &&
      interventionSummary.avoidableCount === 0 &&
      interventionSummary.unresolvedCount === 0 &&
      duplicateSideEffectCount === 0,
    timelineComplete,
    totalElapsedMs,
    usefulAutonomousDurationMs,
    interventionWaitDurationMs,
    unverifiedElapsedMs: Math.max(
      0,
      totalElapsedMs - usefulAutonomousDurationMs - interventionWaitDurationMs,
    ),
    interventions: interventionSummary,
    recovery: Object.freeze({
      completedCount: recoveryLatencies.length,
      unresolvedCount: openRecoveries.size,
      observedLatencyMs: recoveryLatencies.reduce(sumNumbers, 0),
    }),
    sideEffects: Object.freeze({
      committedCount: sideEffects.size + duplicateSideEffectCount,
      uniqueCount: sideEffects.size,
      duplicateCount: duplicateSideEffectCount,
    }),
    providerUsage: sortedProviderUsage(providerUsage),
    toolUsage: Object.freeze(toolUsage),
  });
}

function aggregateAttempts(attempts) {
  const interventions = createInterventionTotals();
  const providerUsage = new Map();
  const totals = {
    attemptCount: attempts.length,
    correctlyCompletedAttemptCount: 0,
    passedAttemptCount: 0,
    totalElapsedMs: 0,
    usefulAutonomousDurationMs: 0,
    interventionWaitDurationMs: 0,
    unverifiedElapsedMs: 0,
  };
  const recovery = {
    completedCount: 0,
    unresolvedCount: 0,
    observedLatencyMs: 0,
  };
  const sideEffects = { committedCount: 0, duplicateCount: 0 };
  const toolUsage = {
    invocationCount: 0,
    failureCount: 0,
    observedDurationMs: 0,
  };
  for (const attempt of attempts) {
    totals.correctlyCompletedAttemptCount += Number(attempt.correctlyCompleted);
    totals.passedAttemptCount += Number(attempt.passed);
    addNumericFields(totals, attempt, [
      'totalElapsedMs',
      'usefulAutonomousDurationMs',
      'interventionWaitDurationMs',
      'unverifiedElapsedMs',
    ]);
    addNumericFields(recovery, attempt.recovery, Object.keys(recovery));
    addNumericFields(
      sideEffects,
      attempt.sideEffects,
      Object.keys(sideEffects),
    );
    addNumericFields(toolUsage, attempt.toolUsage, Object.keys(toolUsage));
    for (const reason of attempt.interventions.byReason) {
      addNumericFields(interventions[reason.reason], reason, COUNT_FIELDS);
    }
    for (const usage of attempt.providerUsage) {
      mergeProviderUsage(providerUsage, usage);
    }
  }
  return Object.freeze({
    ...totals,
    interventions: summarizeInterventions(interventions),
    recovery: Object.freeze(recovery),
    sideEffects: Object.freeze(sideEffects),
    providerUsage: sortedProviderUsage(providerUsage),
    toolUsage: Object.freeze(toolUsage),
  });
}

function createInterventionTotals() {
  return Object.fromEntries(
    AGENT_AUTONOMY_INTERVENTION_REASONS.map((reason) => [
      reason,
      {
        reason,
        count: 0,
        justified: 0,
        avoidable: 0,
        unresolved: 0,
        observedLatencyMs: 0,
        unresolvedLatencyCount: 0,
      },
    ]),
  );
}

function summarizeInterventions(totals) {
  const byReason = AGENT_AUTONOMY_INTERVENTION_REASONS.map((reason) =>
    Object.freeze(totals[reason]),
  );
  return Object.freeze({
    totalCount: sumField(byReason, 'count'),
    justifiedCount: sumField(byReason, 'justified'),
    avoidableCount: sumField(byReason, 'avoidable'),
    unresolvedCount: sumField(byReason, 'unresolved'),
    observedLatencyMs: sumField(byReason, 'observedLatencyMs'),
    unresolvedLatencyCount: sumField(byReason, 'unresolvedLatencyCount'),
    byReason: Object.freeze(byReason),
  });
}

function mergeProviderUsage(usageByProvider, source) {
  let target = usageByProvider.get(source.providerReferenceId);
  if (target === undefined) {
    target = {
      providerReferenceId: source.providerReferenceId,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      observedCostMicrousd: 0,
      missingCostObservationCount: 0,
    };
    usageByProvider.set(source.providerReferenceId, target);
  }
  addNumericFields(target, source, [
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'observedCostMicrousd',
    'missingCostObservationCount',
  ]);
}

function sortedProviderUsage(usageByProvider) {
  return Object.freeze(
    [...usageByProvider.values()]
      .map((usage) => Object.freeze(usage))
      .sort((left, right) =>
        left.providerReferenceId.localeCompare(right.providerReferenceId),
      ),
  );
}

function addNumericFields(target, source, fields) {
  for (const field of fields) {
    target[field] += source[field];
  }
}

function sumField(entries, field) {
  return entries.reduce((total, entry) => total + entry[field], 0);
}

function sumNumbers(total, value) {
  return total + value;
}

function exactRecord(value, label, keys) {
  const record = recordValue(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
  return record;
}

function recordValue(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical digest reference`);
  }
  return value;
}

function safeCode(value, label) {
  if (typeof value !== 'string' || !SAFE_CODE_PATTERN.test(value)) {
    throw new Error(`${label} must be a safe code`);
  }
  return value;
}

function interventionReason(value, label) {
  if (!INTERVENTION_REASON_SET.has(value)) {
    throw new Error(`${label} is unsupported`);
  }
  return value;
}

function terminalOutcome(value, label) {
  if (!TERMINAL_OUTCOMES.has(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function timestamp(value, label) {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function nullableNonNegativeInteger(value, label) {
  return value === null ? null : nonNegativeInteger(value, label);
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`agent autonomy workload repeats ${label}`);
  }
}

function parseArgs(argv) {
  if (argv.length !== 2 || (argv[0] !== '--input' && argv[0] !== '--declare')) {
    throw new Error(
      'usage: node scripts/evaluate-agent-autonomy.mjs (--declare <policy.json> | --input <workload.json>)',
    );
  }
  return {
    mode: argv[0] === '--declare' ? 'declare' : 'evaluate',
    inputPath: path.resolve(argv[1]),
  };
}

async function main() {
  const { mode, inputPath } = parseArgs(process.argv.slice(2));
  const workload = JSON.parse(await readFile(inputPath, 'utf8'));
  const result =
    mode === 'declare'
      ? createAgentAutonomyWorkloadDeclaration(workload)
      : evaluateAgentAutonomyWorkload(workload);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
