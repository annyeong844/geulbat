import assert from 'node:assert/strict';
import test from 'node:test';

import { listProductXHarnessToolPolicyShippingReceipts } from '@geulbat/product/tool-policy-promotion';

import {
  buildProductXHarnessToolPolicyScoreboard,
  createProductXHarnessToolPolicyCrossRoundAuthority,
} from './product-xharness-tool-policy-scoreboard.js';
import {
  applyProductXHarnessToolPolicyCrossRoundAuthority,
  publishProductXHarnessToolPolicyCrossRoundAuthority,
  publishProductXHarnessToolPolicyScoreboard,
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

void test('admits only one concurrent authority for the same active head', async (t) => {
  const stateRoot = await createScoreboardTestStateRoot(t, 'race');
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
    evidenceMarker: '4',
    passed: true,
  });
  await publishTestScoreboardOutcome(stateRoot, {
    shippingReceiptDigest: first.receipt.shippingReceiptDigest,
    taskReferenceId: SECOND_TASK_REFERENCE_ID,
    attemptMarker: '2',
    harnessSnapshotId: FIRST_SNAPSHOT_ID,
    evidenceMarker: '7',
    passed: false,
  });
  const second = await publishTestScoreboardShippingRound(stateRoot, {
    candidateId: 'C-R2-01',
    baselinePolicyId: firstCandidate.toolCapabilityPolicyId,
    candidatePolicy: secondCandidate,
    baselineSnapshotId: FIRST_SNAPSHOT_ID,
    candidateSnapshotId: SECOND_SNAPSHOT_ID,
    marker: 'a',
  });
  await publishTestScoreboardOutcome(stateRoot, {
    shippingReceiptDigest: second.receipt.shippingReceiptDigest,
    taskReferenceId: SECOND_TASK_REFERENCE_ID,
    attemptMarker: '3',
    harnessSnapshotId: SECOND_SNAPSHOT_ID,
    evidenceMarker: 'd',
    passed: false,
  });

  const selectScoreboard = await buildProductXHarnessToolPolicyScoreboard({
    stateRoot,
    policy: scoreboardPolicy({
      minimumHitRate: { numerator: 1, denominator: 2 },
      tieBreak: 'earliest_shipping',
      noEligibleCandidateAction: 'hold_active',
      rootBaselineRollbackTarget: null,
    }),
  });
  const rollbackScoreboard = await buildProductXHarnessToolPolicyScoreboard({
    stateRoot,
    policy: scoreboardPolicy({
      minimumHitRate: { numerator: 1, denominator: 1 },
      noEligibleCandidateAction: 'rollback_to_predecessor',
    }),
  });
  const selectAuthority =
    createProductXHarnessToolPolicyCrossRoundAuthority(selectScoreboard);
  const rollbackAuthority =
    createProductXHarnessToolPolicyCrossRoundAuthority(rollbackScoreboard);
  assert.equal(selectAuthority.action, 'select_winner');
  assert.equal(rollbackAuthority.action, 'rollback_to_predecessor');
  await publishProductXHarnessToolPolicyScoreboard(stateRoot, selectScoreboard);
  await publishProductXHarnessToolPolicyScoreboard(
    stateRoot,
    rollbackScoreboard,
  );
  await publishProductXHarnessToolPolicyCrossRoundAuthority(
    stateRoot,
    selectAuthority,
  );
  await publishProductXHarnessToolPolicyCrossRoundAuthority(
    stateRoot,
    rollbackAuthority,
  );

  const results = await Promise.allSettled([
    applyProductXHarnessToolPolicyCrossRoundAuthority(
      stateRoot,
      selectAuthority.authorityDigest,
    ),
    applyProductXHarnessToolPolicyCrossRoundAuthority(
      stateRoot,
      rollbackAuthority.authorityDigest,
    ),
  ]);

  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === 'rejected').length,
    1,
  );
  const chain = await listProductXHarnessToolPolicyShippingReceipts(stateRoot);
  assert.equal(chain.length, 3);
  assert.equal(chain.at(-1)?.schemaVersion, 2);
});

void test('rejects a retained authority after an explicit newer shipping head', async (t) => {
  const stateRoot = await createScoreboardTestStateRoot(t, 'stale');
  const baseline = toolPolicy(['read_file']);
  const firstCandidate = toolPolicy(['read_file', 'search_files']);
  const secondCandidate = toolPolicy([
    'read_file',
    'search_files',
    'list_directory',
  ]);
  await publishTestScoreboardShippingRound(stateRoot, {
    candidateId: 'C-R1-01',
    baselinePolicyId: baseline.toolCapabilityPolicyId,
    candidatePolicy: firstCandidate,
    baselineSnapshotId: BASELINE_SNAPSHOT_ID,
    candidateSnapshotId: FIRST_SNAPSHOT_ID,
    marker: '5',
  });
  const scoreboard = await buildProductXHarnessToolPolicyScoreboard({
    stateRoot,
    policy: scoreboardPolicy({
      noEligibleCandidateAction: 'hold_active',
    }),
  });
  const authority =
    createProductXHarnessToolPolicyCrossRoundAuthority(scoreboard);
  await publishProductXHarnessToolPolicyScoreboard(stateRoot, scoreboard);
  await publishProductXHarnessToolPolicyCrossRoundAuthority(
    stateRoot,
    authority,
  );
  await publishTestScoreboardShippingRound(stateRoot, {
    candidateId: 'C-R2-01',
    baselinePolicyId: firstCandidate.toolCapabilityPolicyId,
    candidatePolicy: secondCandidate,
    baselineSnapshotId: FIRST_SNAPSHOT_ID,
    candidateSnapshotId: SECOND_SNAPSHOT_ID,
    marker: '8',
  });

  await assert.rejects(
    applyProductXHarnessToolPolicyCrossRoundAuthority(
      stateRoot,
      authority.authorityDigest,
    ),
    /evidence is stale or changed/u,
  );
});
