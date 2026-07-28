import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  createAgentAutonomyWorkloadDeclaration,
  evaluateAgentAutonomyWorkload,
  parseAgentAutonomyWorkload,
} from './evaluate-agent-autonomy.mjs';

const execFileAsync = promisify(execFile);

function digest(fill) {
  return `sha256:${fill.repeat(64)}`;
}

function observation(kind, seconds, extra = {}) {
  return {
    kind,
    at: new Date(Date.UTC(2026, 6, 28, 0, 0, seconds)).toISOString(),
    ...extra,
  };
}

function workload({
  registeredAt = '2026-07-27T23:59:59.000Z',
  eligibility = 'eligible',
  interventionRules = [
    { reason: 'approval_or_authority', necessity: 'justified' },
  ],
  oracleOutcome = 'verified_completed',
  observations,
} = {}) {
  const declaration = createAgentAutonomyWorkloadDeclaration({
    schemaVersion: 1,
    workloadKind: 'agent_autonomy_workload_declaration',
    registeredAt,
    tasks: [
      {
        taskReferenceId: digest('2'),
        eligibility,
        eligibilityReason:
          eligibility === 'eligible' ? 'representative_repo_task' : 'excluded',
        attemptReferences: [digest('3')],
        interventionRules,
      },
    ],
  });
  return {
    schemaVersion: 1,
    workloadKind: 'agent_autonomy_workload',
    workloadReferenceId: declaration.workloadReferenceId,
    registeredAt: declaration.registeredAt,
    tasks: declaration.tasks,
    attempts: [
      {
        attemptReference: digest('3'),
        taskReferenceId: digest('2'),
        oracle: {
          outcome: oracleOutcome,
          evidenceReferenceId: digest('4'),
        },
        observations: observations ?? [
          observation('run_started', 0),
          observation('run_terminal', 1, { outcome: 'completed' }),
        ],
      },
    ],
  };
}

void test('counts verified work around a justified intervention without counting its wait', () => {
  const report = evaluateAgentAutonomyWorkload(
    workload({
      observations: [
        observation('run_started', 0),
        observation('progress_verified', 10, {
          evidenceReferenceId: digest('5'),
        }),
        observation('intervention_required', 12, {
          interventionReferenceId: digest('6'),
          reason: 'approval_or_authority',
        }),
        observation('intervention_resolved', 20, {
          interventionReferenceId: digest('6'),
        }),
        observation('recovery_started', 25, {
          recoveryReferenceId: digest('7'),
        }),
        observation('provider_usage', 27, {
          providerReferenceId: 'codex_oauth',
          inputTokens: 100,
          cachedInputTokens: 80,
          outputTokens: 20,
          costMicrousd: null,
        }),
        observation('tool_usage', 28, {
          toolInvocationCount: 2,
          toolFailureCount: 0,
          observedDurationMs: 40,
        }),
        observation('recovery_completed', 30, {
          recoveryReferenceId: digest('7'),
        }),
        observation('side_effect_committed', 31, {
          sideEffectReferenceId: digest('8'),
        }),
        observation('run_terminal', 35, { outcome: 'completed' }),
      ],
    }),
  );

  assert.deepEqual(report.primary, {
    metric: 'verified_task_completion_without_avoidable_human_intervention',
    eligibleTaskCount: 1,
    passedTaskCount: 1,
    rate: { numerator: 1, denominator: 1 },
  });
  assert.equal(report.supporting.usefulAutonomousDurationMs, 25_000);
  assert.equal(report.supporting.interventionWaitDurationMs, 8_000);
  assert.equal(report.supporting.unverifiedElapsedMs, 2_000);
  assert.deepEqual(report.supporting.recovery, {
    completedCount: 1,
    unresolvedCount: 0,
    observedLatencyMs: 5_000,
  });
  assert.deepEqual(report.supporting.providerUsage, [
    {
      providerReferenceId: 'codex_oauth',
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
      observedCostMicrousd: 0,
      missingCostObservationCount: 1,
    },
  ]);
  assert.deepEqual(report.supporting.toolUsage, {
    invocationCount: 2,
    failureCount: 0,
    observedDurationMs: 40,
  });
});

void test('does not promote an avoidable intervention or duplicate side effect', () => {
  const report = evaluateAgentAutonomyWorkload(
    workload({
      interventionRules: [
        {
          reason: 'consequential_user_decision',
          necessity: 'avoidable',
        },
      ],
      observations: [
        observation('run_started', 0),
        observation('intervention_required', 1, {
          interventionReferenceId: digest('5'),
          reason: 'consequential_user_decision',
        }),
        observation('intervention_resolved', 2, {
          interventionReferenceId: digest('5'),
        }),
        observation('side_effect_committed', 3, {
          sideEffectReferenceId: digest('6'),
        }),
        observation('side_effect_committed', 4, {
          sideEffectReferenceId: digest('6'),
        }),
        observation('run_terminal', 5, { outcome: 'completed' }),
      ],
    }),
  );

  assert.equal(report.primary.passedTaskCount, 0);
  assert.equal(report.supporting.interventions.avoidableCount, 1);
  assert.equal(report.supporting.sideEffects.duplicateCount, 1);

  const duplicateOnly = evaluateAgentAutonomyWorkload(
    workload({
      observations: [
        observation('run_started', 0),
        observation('side_effect_committed', 1, {
          sideEffectReferenceId: digest('7'),
        }),
        observation('side_effect_committed', 2, {
          sideEffectReferenceId: digest('7'),
        }),
        observation('run_terminal', 3, { outcome: 'completed' }),
      ],
    }),
  );
  assert.equal(duplicateOnly.primary.passedTaskCount, 0);
});

void test('keeps a five-minute no-progress run out of useful autonomous time', () => {
  const report = evaluateAgentAutonomyWorkload(
    workload({
      interventionRules: [{ reason: 'no_progress', necessity: 'justified' }],
      oracleOutcome: 'verified_failed',
      observations: [
        observation('run_started', 0),
        {
          kind: 'intervention_required',
          at: '2026-07-28T00:05:00.000Z',
          interventionReferenceId: digest('5'),
          reason: 'no_progress',
        },
        {
          kind: 'run_terminal',
          at: '2026-07-28T00:05:00.000Z',
          outcome: 'failed',
        },
      ],
    }),
  );

  assert.equal(report.primary.passedTaskCount, 0);
  assert.equal(report.supporting.usefulAutonomousDurationMs, 0);
  assert.equal(report.supporting.unverifiedElapsedMs, 300_000);
});

void test('fails closed on post-hoc policy or content-bearing telemetry fields', () => {
  assert.throws(
    () =>
      parseAgentAutonomyWorkload(
        workload({
          registeredAt: '2026-07-28T00:00:01.000Z',
        }),
      ),
    /registered after attempt/u,
  );
  const withPrompt = workload();
  withPrompt.attempts[0].observations[0].prompt = 'must not be copied';
  assert.throws(
    () => parseAgentAutonomyWorkload(withPrompt),
    /unexpected fields/u,
  );

  const original = workload();
  const withReclassifiedIntervention = {
    ...original,
    tasks: original.tasks.map((task) => ({
      ...task,
      interventionRules: [
        { reason: 'approval_or_authority', necessity: 'avoidable' },
      ],
    })),
  };
  assert.throws(
    () => parseAgentAutonomyWorkload(withReclassifiedIntervention),
    /content-addressed declaration/u,
  );
});

void test('CLI fixes a declaration before emitting a content-redacted report', async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'geulbat-agent-autonomy-'),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policyPath = path.join(directory, 'policy.json');
  const inputPath = path.join(directory, 'workload.json');
  const source = workload();
  await writeFile(
    policyPath,
    JSON.stringify({
      schemaVersion: 1,
      workloadKind: 'agent_autonomy_workload_declaration',
      registeredAt: source.registeredAt,
      tasks: source.tasks,
    }),
    'utf8',
  );

  const declarationResult = await execFileAsync(
    process.execPath,
    [
      path.resolve('scripts/evaluate-agent-autonomy.mjs'),
      '--declare',
      policyPath,
    ],
    { cwd: path.resolve('.') },
  );
  const declaration = JSON.parse(declarationResult.stdout);
  assert.match(declaration.workloadReferenceId, /^sha256:[0-9a-f]{64}$/u);

  await writeFile(
    inputPath,
    JSON.stringify({
      ...source,
      workloadReferenceId: declaration.workloadReferenceId,
      registeredAt: declaration.registeredAt,
      tasks: declaration.tasks,
    }),
    'utf8',
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [path.resolve('scripts/evaluate-agent-autonomy.mjs'), '--input', inputPath],
    { cwd: path.resolve('.') },
  );
  const report = JSON.parse(stdout);

  assert.equal(report.primary.passedTaskCount, 1);
  assert.equal(JSON.stringify(report).includes('prompt'), false);
});
