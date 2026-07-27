import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { resolveProductXHarnessToolCapabilityPolicyAdmission } from '@geulbat/product/tool-policy-promotion';

import {
  buildProductXHarnessToolPolicyScoreboard,
  createProductXHarnessToolPolicyCrossRoundAuthority,
  parseProductXHarnessToolPolicyScoreboard,
} from './product-xharness-tool-policy-scoreboard.js';
import {
  applyProductXHarnessToolPolicyCrossRoundAuthority,
  publishProductXHarnessToolPolicyCrossRoundAuthority,
  publishProductXHarnessToolPolicyScoreboard,
  readProductXHarnessToolPolicyCrossRoundAuthority,
} from './product-xharness-tool-policy-scoreboard-publication.js';
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

void test('publishes, re-enters, and applies one prior-winner authority idempotently', async (t) => {
  const {
    stateRoot,
    baseline,
    firstCandidate,
    first,
    second,
    scoreboardPublication,
    authority,
    authorityPublication,
  } = await createPublishedPriorWinnerScenario(t, 'apply');

  assert.equal(scoreboardPublication.created, true);
  assert.equal(authority.action, 'select_winner');
  assert.equal(authority.selectedCandidateId, 'C-R1-01');
  assert.equal(
    authority.target.sourceShippingReceiptDigest,
    first.receipt.shippingReceiptDigest,
  );
  assert.equal(authorityPublication.created, true);

  const applied = await applyProductXHarnessToolPolicyCrossRoundAuthority(
    stateRoot,
    authority.authorityDigest,
  );
  assert.equal(applied.transition?.created, true);
  assert.equal(applied.transition?.receipt.schemaVersion, 2);
  assert.equal(
    applied.transition?.receipt.previousShippingReceiptDigest,
    second.receipt.shippingReceiptDigest,
  );
  assert.deepEqual(
    await resolveProductXHarnessToolCapabilityPolicyAdmission({
      stateRoot,
      requestedToolCapabilityPolicy: baseline,
    }),
    {
      toolCapabilityPolicy: firstCandidate,
      appliedShippingReceiptDigest:
        applied.transition?.receipt.shippingReceiptDigest,
    },
  );

  const repeated = await applyProductXHarnessToolPolicyCrossRoundAuthority(
    stateRoot,
    authority.authorityDigest,
  );
  assert.equal(repeated.transition?.created, false);
  assert.equal(
    repeated.transition?.receipt.shippingReceiptDigest,
    applied.transition?.receipt.shippingReceiptDigest,
  );
  assert.deepEqual(
    await readProductXHarnessToolPolicyCrossRoundAuthority(
      stateRoot,
      authority.authorityDigest,
    ),
    authority,
  );
});

void test('includes an applied prior winner in later scoreboard evidence', async (t) => {
  const { stateRoot, scoreboard, authority } =
    await createPublishedPriorWinnerScenario(t, 'later-evidence');
  const applied = await applyProductXHarnessToolPolicyCrossRoundAuthority(
    stateRoot,
    authority.authorityDigest,
  );
  await publishTestScoreboardOutcome(stateRoot, {
    shippingReceiptDigest:
      applied.transition?.receipt.shippingReceiptDigest ?? '',
    taskReferenceId: FIRST_TASK_REFERENCE_ID,
    attemptMarker: 'c',
    harnessSnapshotId: FIRST_SNAPSHOT_ID,
    evidenceMarker: 'd',
    passed: true,
  });

  const nextScoreboard = await buildProductXHarnessToolPolicyScoreboard({
    stateRoot,
    policy: scoreboard.policy,
  });
  const firstReputation = nextScoreboard.candidateReputations.find(
    (candidate) => candidate.candidateId === 'C-R1-01',
  );

  assert.equal(firstReputation?.shippingReceiptDigests.length, 2);
  assert.equal(firstReputation?.taskScores[0]?.attemptReferences.length, 2);
  assert.deepEqual(firstReputation?.hitRate, {
    passedTasks: 1,
    observedTasks: 1,
  });
});

void test('applies an exact root-baseline rollback without candidate provenance', async (t) => {
  const stateRoot = await createScoreboardTestStateRoot(t, 'root-rollback');
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
  await publishProductXHarnessToolPolicyScoreboard(
    stateRoot,
    rootRollbackScoreboard,
  );
  await publishProductXHarnessToolPolicyCrossRoundAuthority(
    stateRoot,
    rootRollbackAuthority,
  );

  const applied = await applyProductXHarnessToolPolicyCrossRoundAuthority(
    stateRoot,
    rootRollbackAuthority.authorityDigest,
  );

  assert.equal(
    applied.transition?.receipt.transitionAction,
    'rollback_to_predecessor',
  );
  assert.equal(applied.transition?.receipt.candidateId, null);
  await assert.rejects(
    publishTestScoreboardOutcome(stateRoot, {
      shippingReceiptDigest:
        applied.transition?.receipt.shippingReceiptDigest ?? '',
      taskReferenceId: FIRST_TASK_REFERENCE_ID,
      attemptMarker: '0',
      harnessSnapshotId: BASELINE_SNAPSHOT_ID,
      evidenceMarker: '1',
      passed: true,
    }),
    /root-baseline rollback has no candidate outcome provenance/u,
  );
  assert.deepEqual(
    await resolveProductXHarnessToolCapabilityPolicyAdmission({
      stateRoot,
      requestedToolCapabilityPolicy: baseline,
    }),
    {
      toolCapabilityPolicy: baseline,
      appliedShippingReceiptDigest:
        applied.transition?.receipt.shippingReceiptDigest,
    },
  );
});

void test('applies an explicit predecessor rollback authority', async (t) => {
  const stateRoot = await createScoreboardTestStateRoot(
    t,
    'predecessor-rollback',
  );
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
    marker: '1',
  });
  await publishTestScoreboardOutcome(stateRoot, {
    shippingReceiptDigest: first.receipt.shippingReceiptDigest,
    taskReferenceId: FIRST_TASK_REFERENCE_ID,
    attemptMarker: '1',
    harnessSnapshotId: FIRST_SNAPSHOT_ID,
    evidenceMarker: '2',
    passed: false,
  });
  const second = await publishTestScoreboardShippingRound(stateRoot, {
    candidateId: 'C-R2-01',
    baselinePolicyId: firstCandidate.toolCapabilityPolicyId,
    candidatePolicy: secondCandidate,
    baselineSnapshotId: FIRST_SNAPSHOT_ID,
    candidateSnapshotId: SECOND_SNAPSHOT_ID,
    marker: '3',
  });
  await publishTestScoreboardOutcome(stateRoot, {
    shippingReceiptDigest: second.receipt.shippingReceiptDigest,
    taskReferenceId: SECOND_TASK_REFERENCE_ID,
    attemptMarker: '2',
    harnessSnapshotId: SECOND_SNAPSHOT_ID,
    evidenceMarker: '4',
    passed: false,
  });
  const policy = scoreboardPolicy({
    minimumHitRate: { numerator: 1, denominator: 1 },
    noEligibleCandidateAction: 'rollback_to_predecessor',
  });
  const scoreboard = await buildProductXHarnessToolPolicyScoreboard({
    stateRoot,
    policy,
  });
  const authority =
    createProductXHarnessToolPolicyCrossRoundAuthority(scoreboard);
  assert.equal(authority.action, 'rollback_to_predecessor');
  assert.equal(authority.selectedCandidateId, 'C-R1-01');
  await publishProductXHarnessToolPolicyScoreboard(stateRoot, scoreboard);
  await publishProductXHarnessToolPolicyCrossRoundAuthority(
    stateRoot,
    authority,
  );

  const applied = await applyProductXHarnessToolPolicyCrossRoundAuthority(
    stateRoot,
    authority.authorityDigest,
  );

  assert.equal(
    applied.transition?.receipt.transitionAction,
    'rollback_to_predecessor',
  );
  assert.deepEqual(
    await resolveProductXHarnessToolCapabilityPolicyAdmission({
      stateRoot,
      requestedToolCapabilityPolicy: baseline,
    }),
    {
      toolCapabilityPolicy: firstCandidate,
      appliedShippingReceiptDigest:
        applied.transition?.receipt.shippingReceiptDigest,
    },
  );
});

void test('round-trips one immutable stored scoreboard body', async (t) => {
  const stateRoot = await createScoreboardTestStateRoot(t, 'roundtrip');
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
  await publishProductXHarnessToolPolicyScoreboard(stateRoot, scoreboard);
  const storedPath = join(
    stateRoot,
    '.geulbat',
    'xharness',
    'tool-policy-scoreboards',
    'scoreboards',
    `${scoreboard.scoreboardDigest.slice('sha256:'.length)}.json`,
  );

  assert.deepEqual(
    parseProductXHarnessToolPolicyScoreboard(
      JSON.parse(await readFile(storedPath, 'utf8')),
    ),
    scoreboard,
  );
});

async function createPublishedPriorWinnerScenario(
  t: TestContext,
  label: string,
) {
  const stateRoot = await createScoreboardTestStateRoot(t, label);
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
  const scoreboardPublication =
    await publishProductXHarnessToolPolicyScoreboard(stateRoot, scoreboard);
  const authority =
    createProductXHarnessToolPolicyCrossRoundAuthority(scoreboard);
  const authorityPublication =
    await publishProductXHarnessToolPolicyCrossRoundAuthority(
      stateRoot,
      authority,
    );
  return {
    stateRoot,
    baseline,
    firstCandidate,
    first,
    second,
    scoreboard,
    scoreboardPublication,
    authority,
    authorityPublication,
  };
}
