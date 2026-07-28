import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  evaluateProviderSemanticVerification,
  parseProviderSemanticVerificationSubmission,
  runProviderSemanticVerificationProbe,
} from './probe-provider-semantic-verification.mjs';

const OUTPUT = '.audit/provider-semantic-verification-live/test-comparison';
const SOURCE = {
  'apps/daemon/src/daemon/sessions/goal-store.ts': [
    'completionRunId: assertRunId(runId),',
    'current.completionRunId !== runId',
    "current?.snapshot.state !== 'verifying' ||",
    'liveCompletionThreadIds.has(threadId)',
    "state: 'verification_unavailable',",
    "current.snapshot.state !== 'verifying' ||",
    'current.completionRunId !== runId',
    "throw goalConflict('Goal completion request is no longer current');",
    'completionAdmissions: [',
    '...current.completionAdmissions,',
    '],',
    'legacyVerificationAttempts: current.legacyVerificationAttempts,',
  ].join('\n'),
  'apps/daemon/src/daemon/agent/run-completion-policy.ts': [
    'return {',
    "kind: 'verification_unavailable',",
    'message: args.userMessage,',
    '};',
    'await args.planningWorkflows.assessExecutionCompletion({',
    'ref: args.approvedPlan.ref,',
    '});',
    'await args.goals.admitCompletion({',
    '});',
    "operation: 'goal_completion_admission',",
    "userMessage: 'Goal completion admission is unavailable.',",
  ].join('\n'),
  'apps/daemon/src/daemon/tools/builtin/update-goal.ts':
    'await ctx.runtimeServices.goals.requestCompletion({});\n',
  'docs/current/spec/phase7-goal-mode/geulbat-phase7-goal-mode-completion-admission-spec-v1-codex-direct.md':
    '`completed`는 별도 모델이 objective의 의미적 달성을 독립 검증했다는 뜻이 아니다.\n' +
    'agent의 명시적 완료 요청과 host가 직접 판정할 수 있는 obligation의 충족을 뜻한다.\n',
};
const SUBMISSION = {
  taskId: 'goal_completion_admission_audit_v1',
  claims: [
    {
      id: 'H1',
      status: 'supported',
      evidence: [
        {
          path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
          startLine: 1,
          endLine: 1,
        },
        {
          path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
          startLine: 2,
          endLine: 2,
        },
      ],
      rationale: 'TEST_WORKER_SECRET_MARKER exact run correlation is stored.',
    },
    {
      id: 'H2',
      status: 'supported',
      evidence: [
        {
          path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
          startLine: 3,
          endLine: 4,
        },
        {
          path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
          startLine: 5,
          endLine: 5,
        },
      ],
      rationale: 'Restart recovery fails closed.',
    },
    {
      id: 'H3',
      status: 'contradicted',
      evidence: [
        {
          path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
          startLine: 6,
          endLine: 7,
        },
        {
          path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
          startLine: 8,
          endLine: 8,
        },
      ],
      rationale: 'The stored run identity is checked.',
    },
    {
      id: 'H4',
      status: 'supported',
      evidence: [
        {
          path: 'apps/daemon/src/daemon/agent/run-completion-policy.ts',
          startLine: 5,
          endLine: 6,
        },
        {
          path: 'apps/daemon/src/daemon/agent/run-completion-policy.ts',
          startLine: 8,
          endLine: 8,
        },
      ],
      rationale: 'Plan assessment precedes admission.',
    },
    {
      id: 'H5',
      status: 'contradicted',
      evidence: [
        {
          path: 'docs/current/spec/phase7-goal-mode/geulbat-phase7-goal-mode-completion-admission-spec-v1-codex-direct.md',
          startLine: 1,
          endLine: 2,
        },
      ],
      rationale: 'The public state is not a semantic model guarantee.',
    },
    {
      id: 'H6',
      status: 'supported',
      evidence: [
        {
          path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
          startLine: 9,
          endLine: 10,
        },
        {
          path: 'apps/daemon/src/daemon/sessions/goal-store.ts',
          startLine: 12,
          endLine: 12,
        },
      ],
      rationale: 'Legacy evidence is preserved.',
    },
    {
      id: 'H7',
      status: 'supported',
      evidence: [
        {
          path: 'apps/daemon/src/daemon/agent/run-completion-policy.ts',
          startLine: 1,
          endLine: 4,
        },
        {
          path: 'apps/daemon/src/daemon/agent/run-completion-policy.ts',
          startLine: 10,
          endLine: 11,
        },
      ],
      rationale: 'Failures stay visible.',
    },
  ],
};

async function writeSourceTree(root) {
  for (const [path, content] of Object.entries(SOURCE)) {
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }
}

void test('scores exact, narrow evidence against the frozen snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-semantic-score-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeSourceTree(root);

  const parsed = parseProviderSemanticVerificationSubmission(
    JSON.stringify(SUBMISSION),
  );
  const score = await evaluateProviderSemanticVerification(parsed, root);

  assert.equal(score.hardConstraintSatisfiedCount, 7);
  assert.equal(score.evidencePrecision, 1);
  assert.equal(score.unsupportedEvidenceCount, 0);
});

void test('runs both provider directions without refine or product admission', async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'geulbat-semantic-probe-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await writeSourceTree(repoRoot);
  const requests = [];
  let runNumber = 0;
  let clock = 0;

  const result = await runProviderSemanticVerificationProbe({
    argv: ['--output', OUTPUT, '--repeat', '1', '--timeout-ms', '10000'],
    env: { GEULBAT_PROVIDER_SEMANTIC_VERIFICATION_LIVE: '1' },
    repoRoot,
    runtimeLoader: async () => ({
      createProviderAuthRuntimeStore: () => ({}),
      createResponsesWebSocketSessionStore: () => ({
        closeAll: async () => ({ ok: true }),
      }),
      resolveProviderRequestOptions: () => ({}),
    }),
    readProviderAuthStatuses: async () => [
      {
        modelId: 'gpt-5.6-sol',
        providerId: 'openai_codex_direct',
        state: 'ready',
        ready: true,
      },
      {
        modelId: 'grok-4.5',
        providerId: 'grok_oauth',
        state: 'ready',
        ready: true,
      },
    ],
    runAttempt: async ({ modelId, prompt }) => {
      requests.push({ modelId, prompt });
      assert.equal(
        existsSync(join(repoRoot, OUTPUT, 'declaration.json')),
        true,
      );
      runNumber += 1;
      const submission = structuredClone(SUBMISSION);
      if (runNumber === 3) {
        submission.claims[0].status = 'contradicted';
      }
      return {
        answer: JSON.stringify(submission),
        providerSessionId: `provider-session-${runNumber}`,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 80,
          outputTokens: 20,
        },
      };
    },
    now: () => new Date('2026-07-29T00:00:00.000Z'),
    nowMs: () => (clock += 5),
    log: () => {},
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.attempts.length, 10);
  assert.equal(result.comparisons.length, 8);
  assert.equal(result.report.arms.single_pass.attemptCount, 2);
  assert.equal(
    result.report.comparisonSummary.distinct_provider_blind_snapshot
      .falseSupportedCount,
    0,
  );
  assert.equal(
    result.report.comparisonSummary.distinct_provider_submission_review
      .disagreementCount,
    1,
  );
  assert.equal(
    result.report.comparisonSummary.distinct_provider_submission_review
      .unresolvedCount,
    1,
  );
  assert.equal(
    result.report.comparisonSummary.distinct_provider_submission_review
      .verifierIntroducedHardFailureCount,
    1,
  );
  assert.equal(result.report.productizationAuthorized, false);
  const blindPrompts = requests
    .map((request) => request.prompt)
    .filter((prompt) =>
      prompt.includes('Do not ask for or infer a worker submission'),
    );
  assert.equal(blindPrompts.length, 4);
  assert.equal(
    blindPrompts.some((prompt) => prompt.includes('TEST_WORKER_SECRET_MARKER')),
    false,
  );
  assert.equal(result.declaration.execution.toolDefinitionCount, 0);
  assert.equal(
    (await readFile(join(repoRoot, OUTPUT, 'report.json'), 'utf8')).includes(
      '"productizationAuthorized": false',
    ),
    true,
  );
});
