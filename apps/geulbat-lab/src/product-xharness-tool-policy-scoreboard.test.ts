import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';
import { createHarnessToolCapabilityPolicy } from '@geulbat/xharness/harness-snapshot';

import {
  publishProductXHarnessToolPolicyOutcomeReceipt,
  type ProductXHarnessToolPolicyOutcomePublication,
} from './product-xharness-tool-policy-outcome.js';
import {
  listProductXHarnessToolPolicyShippingReceipts,
  publishProductXHarnessToolPolicyShippingReceipt,
  resolveProductXHarnessToolCapabilityPolicyAdmission,
  type ProductXHarnessToolPolicyShippingAuthority,
} from '@geulbat/product/tool-policy-promotion';
import {
  applyProductXHarnessToolPolicyCrossRoundAuthority,
  buildProductXHarnessToolPolicyScoreboard,
  createProductXHarnessToolPolicyCrossRoundAuthority,
  parseProductXHarnessToolPolicyScoreboard,
  parseProductXHarnessToolPolicyScoreboardPolicy,
  publishProductXHarnessToolPolicyCrossRoundAuthority,
  publishProductXHarnessToolPolicyScoreboard,
  readProductXHarnessToolPolicyCrossRoundAuthority,
} from './product-xharness-tool-policy-scoreboard.js';

const BASELINE_SNAPSHOT_ID = digest('1');
const FIRST_SNAPSHOT_ID = digest('2');
const SECOND_SNAPSHOT_ID = digest('3');
const FIRST_TASK_REFERENCE_ID = digest('4');
const SECOND_TASK_REFERENCE_ID = digest('5');

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function attempt(character: string): string {
  return character.repeat(64);
}

function nextHex(character: string): string {
  const digits = '0123456789abcdef';
  const index = digits.indexOf(character);
  if (index < 0) {
    throw new Error('test marker must be a lowercase hexadecimal digit');
  }
  return digits[(index + 1) % digits.length]!;
}

function toolPolicy(names: readonly string[]) {
  return createHarnessToolCapabilityPolicy({
    directRegistryNames: names,
    allowedRegistryNames: names,
    callbackRegistryNames: names,
    writeCallbackEnabled: false,
  });
}

function shippingAuthority(input: {
  readonly candidateId: string;
  readonly baselinePolicyId: string;
  readonly candidatePolicy: ReturnType<typeof toolPolicy>;
  readonly baselineSnapshotId: string;
  readonly candidateSnapshotId: string;
  readonly marker: string;
}): ProductXHarnessToolPolicyShippingAuthority {
  return {
    candidateId: input.candidateId,
    packetDigest: digest(input.marker),
    gateEvidenceDigest: digest(nextHex(input.marker)),
    decisionDigest: digest(nextHex(nextHex(input.marker))),
    baselineHarnessSnapshotId: input.baselineSnapshotId,
    candidateHarnessSnapshotId: input.candidateSnapshotId,
    baselineToolCapabilityPolicyId: input.baselinePolicyId,
    candidateToolCapabilityPolicy: input.candidatePolicy,
  };
}

function outcomeAuthority(input: {
  readonly shippingReceiptDigest: string;
  readonly taskReferenceId: string;
  readonly attemptReference: string;
  readonly harnessSnapshotId: string;
  readonly marker: string;
  readonly passed: boolean;
}): ProductXHarnessToolPolicyOutcomePublication {
  const evaluation = {
    schemaVersion: 3,
    ruleId: 'xharness_tool_choice_broad_filename_discovery_v1',
    attemptReference: input.attemptReference,
    taskReferenceId: input.taskReferenceId,
    evidenceReferenceId: digest(input.marker),
    evidenceDigest: digest(nextHex(input.marker)),
    passed: input.passed,
    observations: { toolCallCount: 1, violationCodes: [] },
  };
  return {
    shippingReceiptDigest: input.shippingReceiptDigest,
    taskReferenceId: input.taskReferenceId,
    attemptReference: input.attemptReference,
    evidenceReferenceId: digest(input.marker),
    evidenceDigest: digest(nextHex(input.marker)),
    harnessSnapshotId: input.harnessSnapshotId,
    evaluationRuleId: 'xharness_tool_choice_broad_filename_discovery_v1',
    evaluationDigest: `sha256:${sha256StableJson(evaluation)}`,
    passed: input.passed,
    evaluation,
  };
}

function scoreboardPolicy(
  overrides: Partial<{
    attemptAggregation: 'all_attempts_must_pass' | 'any_attempt_may_pass';
    minimumObservedTasks: number;
    minimumHitRate: {
      readonly numerator: number;
      readonly denominator: number;
    };
    tieBreak:
      | 'earliest_shipping'
      | 'latest_shipping'
      | 'active_then_earliest_shipping'
      | 'active_then_latest_shipping';
    noEligibleCandidateAction: 'hold_active' | 'rollback_to_predecessor';
    rootBaselineRollbackTarget: {
      readonly harnessSnapshotId: string;
      readonly toolCapabilityPolicy: ReturnType<typeof toolPolicy>;
    } | null;
  }> = {},
) {
  return parseProductXHarnessToolPolicyScoreboardPolicy({
    schemaVersion: 1,
    policyKind: 'xharness_tool_choice_scoreboard',
    attemptAggregation: 'all_attempts_must_pass',
    minimumObservedTasks: 1,
    minimumHitRate: { numerator: 1, denominator: 2 },
    tieBreak: 'active_then_earliest_shipping',
    noEligibleCandidateAction: 'rollback_to_predecessor',
    rootBaselineRollbackTarget: null,
    ...overrides,
  });
}

void test('aggregates exact task evidence and applies a prior cross-round winner without rewriting history', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-scoreboard-'),
  );
  try {
    const baseline = toolPolicy(['read_file']);
    const firstCandidate = toolPolicy(['read_file', 'search_files']);
    const secondCandidate = toolPolicy([
      'read_file',
      'search_files',
      'list_directory',
    ]);
    const first = await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingAuthority({
        candidateId: 'C-R1-01',
        baselinePolicyId: baseline.toolCapabilityPolicyId,
        candidatePolicy: firstCandidate,
        baselineSnapshotId: BASELINE_SNAPSHOT_ID,
        candidateSnapshotId: FIRST_SNAPSHOT_ID,
        marker: '6',
      }),
    );
    await publishProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      outcomeAuthority({
        shippingReceiptDigest: first.receipt.shippingReceiptDigest,
        taskReferenceId: FIRST_TASK_REFERENCE_ID,
        attemptReference: attempt('7'),
        harnessSnapshotId: FIRST_SNAPSHOT_ID,
        marker: '8',
        passed: true,
      }),
    );
    const second = await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingAuthority({
        candidateId: 'C-R2-01',
        baselinePolicyId: firstCandidate.toolCapabilityPolicyId,
        candidatePolicy: secondCandidate,
        baselineSnapshotId: FIRST_SNAPSHOT_ID,
        candidateSnapshotId: SECOND_SNAPSHOT_ID,
        marker: '9',
      }),
    );
    await publishProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      outcomeAuthority({
        shippingReceiptDigest: second.receipt.shippingReceiptDigest,
        taskReferenceId: SECOND_TASK_REFERENCE_ID,
        attemptReference: attempt('a'),
        harnessSnapshotId: SECOND_SNAPSHOT_ID,
        marker: 'b',
        passed: false,
      }),
    );

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
    const scoreboardPublication =
      await publishProductXHarnessToolPolicyScoreboard(stateRoot, scoreboard);
    assert.equal(scoreboardPublication.created, true);
    const authority =
      createProductXHarnessToolPolicyCrossRoundAuthority(scoreboard);
    assert.equal(authority.action, 'select_winner');
    assert.equal(authority.selectedCandidateId, 'C-R1-01');
    assert.equal(
      authority.target.sourceShippingReceiptDigest,
      first.receipt.shippingReceiptDigest,
    );
    const authorityPublication =
      await publishProductXHarnessToolPolicyCrossRoundAuthority(
        stateRoot,
        authority,
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
    await publishProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      outcomeAuthority({
        shippingReceiptDigest:
          applied.transition?.receipt.shippingReceiptDigest ?? '',
        taskReferenceId: FIRST_TASK_REFERENCE_ID,
        attemptReference: attempt('c'),
        harnessSnapshotId: FIRST_SNAPSHOT_ID,
        marker: 'd',
        passed: true,
      }),
    );
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
    assert.deepEqual(
      await readProductXHarnessToolPolicyCrossRoundAuthority(
        stateRoot,
        authority.authorityDigest,
      ),
      authority,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('attempt aggregation and first-round rollback provenance are explicit', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-scoreboard-attempts-'),
  );
  try {
    const baseline = toolPolicy(['read_file']);
    const candidate = toolPolicy(['read_file', 'search_files']);
    const shipping = await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingAuthority({
        candidateId: 'C-R1-01',
        baselinePolicyId: baseline.toolCapabilityPolicyId,
        candidatePolicy: candidate,
        baselineSnapshotId: BASELINE_SNAPSHOT_ID,
        candidateSnapshotId: FIRST_SNAPSHOT_ID,
        marker: 'c',
      }),
    );
    await publishProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      outcomeAuthority({
        shippingReceiptDigest: shipping.receipt.shippingReceiptDigest,
        taskReferenceId: FIRST_TASK_REFERENCE_ID,
        attemptReference: attempt('d'),
        harnessSnapshotId: FIRST_SNAPSHOT_ID,
        marker: 'e',
        passed: true,
      }),
    );
    await publishProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      outcomeAuthority({
        shippingReceiptDigest: shipping.receipt.shippingReceiptDigest,
        taskReferenceId: FIRST_TASK_REFERENCE_ID,
        attemptReference: attempt('f'),
        harnessSnapshotId: FIRST_SNAPSHOT_ID,
        marker: '0',
        passed: false,
      }),
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

    const rootRollbackScoreboard =
      await buildProductXHarnessToolPolicyScoreboard({
        stateRoot,
        policy: scoreboardPolicy({
          attemptAggregation: 'all_attempts_must_pass',
          minimumHitRate: { numerator: 1, denominator: 1 },
          rootBaselineRollbackTarget: {
            harnessSnapshotId: BASELINE_SNAPSHOT_ID,
            toolCapabilityPolicy: baseline,
          },
        }),
      });
    const rootRollbackAuthority =
      createProductXHarnessToolPolicyCrossRoundAuthority(
        rootRollbackScoreboard,
      );
    assert.equal(rootRollbackAuthority.action, 'rollback_to_predecessor');
    assert.equal(
      rootRollbackAuthority.decisionReason,
      'no_eligible_candidate_rollback',
    );
    assert.equal(rootRollbackAuthority.selectedCandidateId, null);
    assert.equal(
      rootRollbackAuthority.target.sourceShippingReceiptDigest,
      null,
    );

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
      publishProductXHarnessToolPolicyOutcomeReceipt(
        stateRoot,
        outcomeAuthority({
          shippingReceiptDigest:
            applied.transition?.receipt.shippingReceiptDigest ?? '',
          taskReferenceId: FIRST_TASK_REFERENCE_ID,
          attemptReference: attempt('0'),
          harnessSnapshotId: BASELINE_SNAPSHOT_ID,
          marker: '1',
          passed: true,
        }),
      ),
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
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('no eligible candidate applies the explicit predecessor rollback authority', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-scoreboard-rollback-'),
  );
  try {
    const baseline = toolPolicy(['read_file']);
    const firstCandidate = toolPolicy(['read_file', 'search_files']);
    const secondCandidate = toolPolicy([
      'read_file',
      'search_files',
      'list_directory',
    ]);
    const first = await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingAuthority({
        candidateId: 'C-R1-01',
        baselinePolicyId: baseline.toolCapabilityPolicyId,
        candidatePolicy: firstCandidate,
        baselineSnapshotId: BASELINE_SNAPSHOT_ID,
        candidateSnapshotId: FIRST_SNAPSHOT_ID,
        marker: '1',
      }),
    );
    await publishProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      outcomeAuthority({
        shippingReceiptDigest: first.receipt.shippingReceiptDigest,
        taskReferenceId: FIRST_TASK_REFERENCE_ID,
        attemptReference: attempt('1'),
        harnessSnapshotId: FIRST_SNAPSHOT_ID,
        marker: '2',
        passed: false,
      }),
    );
    const second = await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingAuthority({
        candidateId: 'C-R2-01',
        baselinePolicyId: firstCandidate.toolCapabilityPolicyId,
        candidatePolicy: secondCandidate,
        baselineSnapshotId: FIRST_SNAPSHOT_ID,
        candidateSnapshotId: SECOND_SNAPSHOT_ID,
        marker: '3',
      }),
    );
    await publishProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      outcomeAuthority({
        shippingReceiptDigest: second.receipt.shippingReceiptDigest,
        taskReferenceId: SECOND_TASK_REFERENCE_ID,
        attemptReference: attempt('2'),
        harnessSnapshotId: SECOND_SNAPSHOT_ID,
        marker: '4',
        passed: false,
      }),
    );
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
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('admits only one concurrent cross-round authority for the same active head', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-scoreboard-race-'),
  );
  try {
    const baseline = toolPolicy(['read_file']);
    const firstCandidate = toolPolicy(['read_file', 'search_files']);
    const secondCandidate = toolPolicy([
      'read_file',
      'search_files',
      'list_directory',
    ]);
    const first = await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingAuthority({
        candidateId: 'C-R1-01',
        baselinePolicyId: baseline.toolCapabilityPolicyId,
        candidatePolicy: firstCandidate,
        baselineSnapshotId: BASELINE_SNAPSHOT_ID,
        candidateSnapshotId: FIRST_SNAPSHOT_ID,
        marker: '1',
      }),
    );
    await publishProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      outcomeAuthority({
        shippingReceiptDigest: first.receipt.shippingReceiptDigest,
        taskReferenceId: FIRST_TASK_REFERENCE_ID,
        attemptReference: attempt('1'),
        harnessSnapshotId: FIRST_SNAPSHOT_ID,
        marker: '4',
        passed: true,
      }),
    );
    await publishProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      outcomeAuthority({
        shippingReceiptDigest: first.receipt.shippingReceiptDigest,
        taskReferenceId: SECOND_TASK_REFERENCE_ID,
        attemptReference: attempt('2'),
        harnessSnapshotId: FIRST_SNAPSHOT_ID,
        marker: '7',
        passed: false,
      }),
    );
    const second = await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingAuthority({
        candidateId: 'C-R2-01',
        baselinePolicyId: firstCandidate.toolCapabilityPolicyId,
        candidatePolicy: secondCandidate,
        baselineSnapshotId: FIRST_SNAPSHOT_ID,
        candidateSnapshotId: SECOND_SNAPSHOT_ID,
        marker: 'a',
      }),
    );
    await publishProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      outcomeAuthority({
        shippingReceiptDigest: second.receipt.shippingReceiptDigest,
        taskReferenceId: SECOND_TASK_REFERENCE_ID,
        attemptReference: attempt('3'),
        harnessSnapshotId: SECOND_SNAPSHOT_ID,
        marker: 'd',
        passed: false,
      }),
    );

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
    await publishProductXHarnessToolPolicyScoreboard(
      stateRoot,
      selectScoreboard,
    );
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
    const chain =
      await listProductXHarnessToolPolicyShippingReceipts(stateRoot);
    assert.equal(chain.length, 3);
    assert.equal(chain.at(-1)?.schemaVersion, 2);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('retained cross-round authority cannot cross a newer explicit shipping head', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-scoreboard-stale-'),
  );
  try {
    const baseline = toolPolicy(['read_file']);
    const firstCandidate = toolPolicy(['read_file', 'search_files']);
    const secondCandidate = toolPolicy([
      'read_file',
      'search_files',
      'list_directory',
    ]);
    await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingAuthority({
        candidateId: 'C-R1-01',
        baselinePolicyId: baseline.toolCapabilityPolicyId,
        candidatePolicy: firstCandidate,
        baselineSnapshotId: BASELINE_SNAPSHOT_ID,
        candidateSnapshotId: FIRST_SNAPSHOT_ID,
        marker: '5',
      }),
    );
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
    await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingAuthority({
        candidateId: 'C-R2-01',
        baselinePolicyId: firstCandidate.toolCapabilityPolicyId,
        candidatePolicy: secondCandidate,
        baselineSnapshotId: FIRST_SNAPSHOT_ID,
        candidateSnapshotId: SECOND_SNAPSHOT_ID,
        marker: '8',
      }),
    );
    await assert.rejects(
      applyProductXHarnessToolPolicyCrossRoundAuthority(
        stateRoot,
        authority.authorityDigest,
      ),
      /evidence is stale or changed/u,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('strict policy and scoreboard parsers reject hidden defaults and tampering', async () => {
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
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-scoreboard-tamper-'),
  );
  try {
    const baseline = toolPolicy(['read_file']);
    const candidate = toolPolicy(['read_file', 'search_files']);
    await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingAuthority({
        candidateId: 'C-R1-01',
        baselinePolicyId: baseline.toolCapabilityPolicyId,
        candidatePolicy: candidate,
        baselineSnapshotId: BASELINE_SNAPSHOT_ID,
        candidateSnapshotId: FIRST_SNAPSHOT_ID,
        marker: '7',
      }),
    );
    const scoreboard = await buildProductXHarnessToolPolicyScoreboard({
      stateRoot,
      policy: scoreboardPolicy(),
    });
    const tampered = {
      ...scoreboard,
      candidateReputations: scoreboard.candidateReputations.map(
        (reputation) => ({
          ...reputation,
          observedTaskCount: reputation.observedTaskCount + 1,
        }),
      ),
    };
    assert.throws(
      () => parseProductXHarnessToolPolicyScoreboard(tampered),
      /counts are inconsistent/u,
    );
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
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
