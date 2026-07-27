import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  buildProductXHarnessToolPolicyScoreboard,
  createProductXHarnessToolPolicyCrossRoundAuthority,
  parseProductXHarnessToolPolicyScoreboard,
  parseProductXHarnessToolPolicyScoreboardPolicy,
} from './product-xharness-tool-policy-scoreboard.js';
import {
  BASELINE_SNAPSHOT_ID,
  FIRST_SNAPSHOT_ID,
  FIRST_TASK_REFERENCE_ID,
  SECOND_SNAPSHOT_ID,
  SECOND_TASK_REFERENCE_ID,
  createScoreboardTestStateRoot,
  publishTestScoreboardOutcome,
  publishTestScoreboardShippingRound,
  scoreboardPolicy,
  toolPolicy,
} from './test-support/product-xharness-tool-policy-scoreboard.js';

void test('aggregates exact task evidence by candidate', async (t) => {
  const stateRoot = await createScoreboardTestStateRoot(t, 'aggregation');
  const baseline = toolPolicy(['read_file']);
  const firstCandidate = toolPolicy(['read_file', 'search_files']);
  const secondCandidate = toolPolicy([
    'read_file',
    'search_files',
    'list_directory',
  ]);
  const first = await publishTestScoreboardShippingRound(stateRoot, {
    candidateId: 'C-R1-01',
    baselinePolicyId: baseline.toolCapabilityPolicyId,
    candidatePolicy: firstCandidate,
    baselineSnapshotId: BASELINE_SNAPSHOT_ID,
    candidateSnapshotId: FIRST_SNAPSHOT_ID,
    marker: '6',
  });
  await publishTestScoreboardOutcome(stateRoot, {
    shippingReceiptDigest: first.receipt.shippingReceiptDigest,
    taskReferenceId: FIRST_TASK_REFERENCE_ID,
    attemptMarker: '7',
    harnessSnapshotId: FIRST_SNAPSHOT_ID,
    evidenceMarker: '8',
    passed: true,
  });
  const second = await publishTestScoreboardShippingRound(stateRoot, {
    candidateId: 'C-R2-01',
    baselinePolicyId: firstCandidate.toolCapabilityPolicyId,
    candidatePolicy: secondCandidate,
    baselineSnapshotId: FIRST_SNAPSHOT_ID,
    candidateSnapshotId: SECOND_SNAPSHOT_ID,
    marker: '9',
  });
  await publishTestScoreboardOutcome(stateRoot, {
    shippingReceiptDigest: second.receipt.shippingReceiptDigest,
    taskReferenceId: SECOND_TASK_REFERENCE_ID,
    attemptMarker: 'a',
    harnessSnapshotId: SECOND_SNAPSHOT_ID,
    evidenceMarker: 'b',
    passed: false,
  });

  const scoreboard = await buildProductXHarnessToolPolicyScoreboard({
    stateRoot,
    policy: scoreboardPolicy(),
  });

  assert.deepEqual(
    scoreboard.candidateReputations.map((candidate) => ({
      candidateId: candidate.candidateId,
      observed: candidate.observedTaskCount,
      passed: candidate.passedTaskCount,
      hitRate: candidate.hitRate,
    })),
    [
      {
        candidateId: 'C-R1-01',
        observed: 1,
        passed: 1,
        hitRate: { passedTasks: 1, observedTasks: 1 },
      },
      {
        candidateId: 'C-R2-01',
        observed: 1,
        passed: 0,
        hitRate: { passedTasks: 0, observedTasks: 1 },
      },
    ],
  );
});

void test('applies the declared repeated-attempt rule before eligibility', async (t) => {
  const { stateRoot } = await publishMixedAttemptCandidate(
    t,
    'attempt-aggregation',
  );

  const allScoreboard = await buildProductXHarnessToolPolicyScoreboard({
    stateRoot,
    policy: scoreboardPolicy({
      attemptAggregation: 'all_attempts_must_pass',
      minimumHitRate: { numerator: 1, denominator: 1 },
    }),
  });
  assert.equal(allScoreboard.candidateReputations[0]?.passedTaskCount, 0);
  const allAuthority =
    createProductXHarnessToolPolicyCrossRoundAuthority(allScoreboard);
  assert.equal(allAuthority.action, 'hold_active');
  assert.equal(allAuthority.decisionReason, 'rollback_target_unavailable');

  const anyScoreboard = await buildProductXHarnessToolPolicyScoreboard({
    stateRoot,
    policy: scoreboardPolicy({
      attemptAggregation: 'any_attempt_may_pass',
      minimumHitRate: { numerator: 1, denominator: 1 },
    }),
  });
  assert.equal(anyScoreboard.candidateReputations[0]?.passedTaskCount, 1);
  const anyAuthority =
    createProductXHarnessToolPolicyCrossRoundAuthority(anyScoreboard);
  assert.equal(anyAuthority.action, 'hold_active');
  assert.equal(anyAuthority.decisionReason, 'eligible_winner_already_active');
});

void test('requires an exact first-round root rollback target', async (t) => {
  const { stateRoot, baseline } = await publishMixedAttemptCandidate(
    t,
    'root-provenance',
  );

  await assert.rejects(
    buildProductXHarnessToolPolicyScoreboard({
      stateRoot,
      policy: scoreboardPolicy({
        minimumHitRate: { numerator: 1, denominator: 1 },
        rootBaselineRollbackTarget: {
          harnessSnapshotId: SECOND_SNAPSHOT_ID,
          toolCapabilityPolicy: baseline,
        },
      }),
    }),
    /root baseline rollback target does not match the shipping root/u,
  );

  const rootRollbackScoreboard = await buildProductXHarnessToolPolicyScoreboard(
    {
      stateRoot,
      policy: scoreboardPolicy({
        attemptAggregation: 'all_attempts_must_pass',
        minimumHitRate: { numerator: 1, denominator: 1 },
        rootBaselineRollbackTarget: {
          harnessSnapshotId: BASELINE_SNAPSHOT_ID,
          toolCapabilityPolicy: baseline,
        },
      }),
    },
  );
  const rootRollbackAuthority =
    createProductXHarnessToolPolicyCrossRoundAuthority(rootRollbackScoreboard);
  assert.equal(rootRollbackAuthority.action, 'rollback_to_predecessor');
  assert.equal(
    rootRollbackAuthority.decisionReason,
    'no_eligible_candidate_rollback',
  );
  assert.equal(rootRollbackAuthority.selectedCandidateId, null);
  assert.equal(rootRollbackAuthority.target.sourceShippingReceiptDigest, null);
});

void test('rejects hidden policy defaults and non-positive task minima', () => {
  assert.throws(
    () =>
      parseProductXHarnessToolPolicyScoreboardPolicy({
        schemaVersion: 1,
        policyKind: 'xharness_tool_choice_scoreboard',
        attemptAggregation: 'all_attempts_must_pass',
        minimumObservedTasks: 1,
        minimumHitRate: { numerator: 1, denominator: 2 },
        tieBreak: 'earliest_shipping',
        noEligibleCandidateAction: 'hold_active',
      }),
    /scoreboard policy has unexpected fields/u,
  );
  assert.throws(
    () =>
      parseProductXHarnessToolPolicyScoreboardPolicy({
        schemaVersion: 1,
        policyKind: 'xharness_tool_choice_scoreboard',
        attemptAggregation: 'all_attempts_must_pass',
        minimumObservedTasks: 0,
        minimumHitRate: { numerator: 1, denominator: 2 },
        tieBreak: 'earliest_shipping',
        noEligibleCandidateAction: 'hold_active',
        rootBaselineRollbackTarget: null,
      }),
    /minimumObservedTasks must be greater than zero/u,
  );
});

void test('rejects tampered candidate reputation counts', async (t) => {
  const stateRoot = await createScoreboardTestStateRoot(t, 'tamper');
  const baseline = toolPolicy(['read_file']);
  const candidate = toolPolicy(['read_file', 'search_files']);
  await publishTestScoreboardShippingRound(stateRoot, {
    candidateId: 'C-R1-01',
    baselinePolicyId: baseline.toolCapabilityPolicyId,
    candidatePolicy: candidate,
    baselineSnapshotId: BASELINE_SNAPSHOT_ID,
    candidateSnapshotId: FIRST_SNAPSHOT_ID,
    marker: '7',
  });
  const scoreboard = await buildProductXHarnessToolPolicyScoreboard({
    stateRoot,
    policy: scoreboardPolicy(),
  });
  const tampered = {
    ...scoreboard,
    candidateReputations: scoreboard.candidateReputations.map((reputation) => ({
      ...reputation,
      observedTaskCount: reputation.observedTaskCount + 1,
    })),
  };

  assert.throws(
    () => parseProductXHarnessToolPolicyScoreboard(tampered),
    /counts are inconsistent/u,
  );
});

async function publishMixedAttemptCandidate(t: TestContext, label: string) {
  const stateRoot = await createScoreboardTestStateRoot(t, label);
  const baseline = toolPolicy(['read_file']);
  const candidate = toolPolicy(['read_file', 'search_files']);
  const shipping = await publishTestScoreboardShippingRound(stateRoot, {
    candidateId: 'C-R1-01',
    baselinePolicyId: baseline.toolCapabilityPolicyId,
    candidatePolicy: candidate,
    baselineSnapshotId: BASELINE_SNAPSHOT_ID,
    candidateSnapshotId: FIRST_SNAPSHOT_ID,
    marker: 'c',
  });
  await publishTestScoreboardOutcome(stateRoot, {
    shippingReceiptDigest: shipping.receipt.shippingReceiptDigest,
    taskReferenceId: FIRST_TASK_REFERENCE_ID,
    attemptMarker: 'd',
    harnessSnapshotId: FIRST_SNAPSHOT_ID,
    evidenceMarker: 'e',
    passed: true,
  });
  await publishTestScoreboardOutcome(stateRoot, {
    shippingReceiptDigest: shipping.receipt.shippingReceiptDigest,
    taskReferenceId: FIRST_TASK_REFERENCE_ID,
    attemptMarker: 'f',
    harnessSnapshotId: FIRST_SNAPSHOT_ID,
    evidenceMarker: '0',
    passed: false,
  });
  return { stateRoot, baseline };
}
