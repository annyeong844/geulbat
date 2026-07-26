import { join } from 'node:path';

import {
  sha256StableJson,
  stableStringify,
} from '@geulbat/content-identity/stable-json';
import {
  parseHarnessToolCapabilityPolicy,
  type HarnessToolCapabilityPolicy,
} from '@geulbat/xharness/harness-snapshot';

import { publishProductXHarnessImmutableJson } from '@geulbat/product/immutable-publication';
import {
  listAllProductXHarnessToolPolicyOutcomeReceipts,
  type ProductXHarnessToolPolicyOutcomeReceipt,
} from './product-xharness-tool-policy-outcome.js';
import {
  listProductXHarnessToolPolicyShippingReceipts,
  publishProductXHarnessToolPolicyCrossRoundTransition,
  type ProductXHarnessToolPolicyCrossRoundShippingReceipt,
} from '@geulbat/product/tool-policy-promotion';
import {
  assertExactPlainRecord,
  assertPlainRecord,
  readRequiredJson,
} from '@geulbat/product/cli-support';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

type Sha256Digest = `sha256:${string}`;

interface ProductXHarnessToolPolicyHitRate {
  readonly passedTasks: number;
  readonly observedTasks: number;
}

interface ProductXHarnessToolPolicyRootBaselineRollbackTarget {
  readonly harnessSnapshotId: Sha256Digest;
  readonly toolCapabilityPolicy: HarnessToolCapabilityPolicy;
}

interface ProductXHarnessToolPolicyScoreboardPolicy {
  readonly schemaVersion: 1;
  readonly policyKind: 'xharness_tool_choice_scoreboard';
  readonly attemptAggregation:
    | 'all_attempts_must_pass'
    | 'any_attempt_may_pass';
  readonly minimumObservedTasks: number;
  readonly minimumHitRate: {
    readonly numerator: number;
    readonly denominator: number;
  };
  readonly tieBreak:
    | 'earliest_shipping'
    | 'latest_shipping'
    | 'active_then_earliest_shipping'
    | 'active_then_latest_shipping';
  readonly noEligibleCandidateAction: 'hold_active' | 'rollback_to_predecessor';
  readonly rootBaselineRollbackTarget: ProductXHarnessToolPolicyRootBaselineRollbackTarget | null;
  readonly policyId: Sha256Digest;
}

interface ProductXHarnessToolPolicyTaskScore {
  readonly taskReferenceId: Sha256Digest;
  readonly evaluationRuleId: string;
  readonly outcomeReceiptDigests: readonly Sha256Digest[];
  readonly attemptReferences: readonly string[];
  readonly passed: boolean;
}

interface ProductXHarnessToolPolicyRoundScore {
  readonly shippingReceiptDigest: Sha256Digest;
  readonly previousShippingReceiptDigest: Sha256Digest | null;
  readonly candidateId: string | null;
  readonly packetDigest: Sha256Digest | null;
  readonly baselineHarnessSnapshotId: Sha256Digest;
  readonly candidateHarnessSnapshotId: Sha256Digest;
  readonly baselineToolCapabilityPolicyId: Sha256Digest;
  readonly candidateToolCapabilityPolicy: HarnessToolCapabilityPolicy;
  readonly outcomeReceiptDigests: readonly Sha256Digest[];
  readonly taskScores: readonly ProductXHarnessToolPolicyTaskScore[];
}

interface ProductXHarnessToolPolicyCandidateReputation {
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly candidateHarnessSnapshotId: Sha256Digest;
  readonly candidateToolCapabilityPolicy: HarnessToolCapabilityPolicy;
  readonly shippingReceiptDigests: readonly Sha256Digest[];
  readonly firstShippingOrdinal: number;
  readonly lastShippingOrdinal: number;
  readonly taskScores: readonly ProductXHarnessToolPolicyTaskScore[];
  readonly observedTaskCount: number;
  readonly passedTaskCount: number;
  readonly failedTaskCount: number;
  readonly hitRate: ProductXHarnessToolPolicyHitRate;
}

interface ProductXHarnessToolPolicyScoreboard {
  readonly schemaVersion: 1;
  readonly scoreboardKind: 'xharness_tool_choice_cross_round';
  readonly policy: ProductXHarnessToolPolicyScoreboardPolicy;
  readonly shippingHeadDigest: Sha256Digest;
  readonly shippingReceiptDigests: readonly Sha256Digest[];
  readonly rounds: readonly ProductXHarnessToolPolicyRoundScore[];
  readonly candidateReputations: readonly ProductXHarnessToolPolicyCandidateReputation[];
  readonly scoreboardDigest: Sha256Digest;
}

interface ProductXHarnessToolPolicyCrossRoundTarget {
  readonly sourceShippingReceiptDigest: Sha256Digest | null;
  readonly candidateId: string | null;
  readonly packetDigest: Sha256Digest | null;
  readonly candidateHarnessSnapshotId: Sha256Digest;
  readonly candidateToolCapabilityPolicy: HarnessToolCapabilityPolicy;
}

interface ProductXHarnessToolPolicyCrossRoundAuthority {
  readonly schemaVersion: 1;
  readonly authorityKind: 'xharness_tool_choice_cross_round';
  readonly scoreboardDigest: Sha256Digest;
  readonly policyId: Sha256Digest;
  readonly observedShippingHeadDigest: Sha256Digest;
  readonly action: 'hold_active' | 'select_winner' | 'rollback_to_predecessor';
  readonly decisionReason:
    | 'eligible_winner_already_active'
    | 'eligible_winner_selected'
    | 'selected_policy_already_active'
    | 'no_eligible_candidate_hold'
    | 'rollback_target_unavailable'
    | 'no_eligible_candidate_rollback';
  readonly activeCandidateId: string | null;
  readonly eligibleCandidateIds: readonly string[];
  readonly selectedCandidateId: string | null;
  readonly target: ProductXHarnessToolPolicyCrossRoundTarget;
  readonly authorityDigest: Sha256Digest;
}

interface CandidateAccumulator {
  readonly candidateId: string;
  readonly packetDigest: Sha256Digest;
  readonly candidateHarnessSnapshotId: Sha256Digest;
  readonly candidateToolCapabilityPolicy: HarnessToolCapabilityPolicy;
  readonly shippingReceiptDigests: Sha256Digest[];
  readonly shippingOrdinals: number[];
  readonly outcomes: ProductXHarnessToolPolicyOutcomeReceipt[];
}

export function parseProductXHarnessToolPolicyScoreboardPolicy(
  value: unknown,
): ProductXHarnessToolPolicyScoreboardPolicy {
  const looseRecord = assertPlainRecord(
    value,
    'product xHarness scoreboard policy',
  );
  const expectedKeys = [
    'schemaVersion',
    'policyKind',
    'attemptAggregation',
    'minimumObservedTasks',
    'minimumHitRate',
    'tieBreak',
    'noEligibleCandidateAction',
    'rootBaselineRollbackTarget',
  ];
  if (Object.hasOwn(looseRecord, 'policyId')) {
    expectedKeys.push('policyId');
  }
  const record = assertExactPlainRecord(
    value,
    expectedKeys,
    'product xHarness scoreboard policy',
  );
  if (
    record.schemaVersion !== 1 ||
    record.policyKind !== 'xharness_tool_choice_scoreboard'
  ) {
    throw new Error('unsupported product xHarness scoreboard policy');
  }
  const attemptAggregation = readAttemptAggregation(record.attemptAggregation);
  const minimumObservedTasks = readPositiveSafeInteger(
    record.minimumObservedTasks,
    'minimumObservedTasks',
  );
  const minimumHitRateRecord = assertExactPlainRecord(
    record.minimumHitRate,
    ['numerator', 'denominator'],
    'product xHarness scoreboard minimumHitRate',
  );
  const numerator = readNonNegativeSafeInteger(
    minimumHitRateRecord.numerator,
    'minimumHitRate.numerator',
  );
  const denominator = readPositiveSafeInteger(
    minimumHitRateRecord.denominator,
    'minimumHitRate.denominator',
  );
  if (numerator > denominator) {
    throw new Error(
      'product xHarness scoreboard minimum hit rate must be between zero and one',
    );
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    policyKind: 'xharness_tool_choice_scoreboard' as const,
    attemptAggregation,
    minimumObservedTasks,
    minimumHitRate: Object.freeze({ numerator, denominator }),
    tieBreak: readTieBreak(record.tieBreak),
    noEligibleCandidateAction: readNoEligibleCandidateAction(
      record.noEligibleCandidateAction,
    ),
    rootBaselineRollbackTarget: parseRootBaselineRollbackTarget(
      record.rootBaselineRollbackTarget,
    ),
  });
  const policyId: Sha256Digest = `sha256:${sha256StableJson(body)}`;
  if (Object.hasOwn(record, 'policyId') && record.policyId !== policyId) {
    throw new Error(
      'product xHarness scoreboard policy digest does not match its body',
    );
  }
  return Object.freeze({ ...body, policyId });
}

export async function buildProductXHarnessToolPolicyScoreboard(input: {
  readonly stateRoot: string;
  readonly policy: unknown;
}): Promise<ProductXHarnessToolPolicyScoreboard> {
  const policy = parseProductXHarnessToolPolicyScoreboardPolicy(input.policy);
  const shippingReceipts = await listProductXHarnessToolPolicyShippingReceipts(
    input.stateRoot,
  );
  const shippingHead = shippingReceipts.at(-1);
  if (shippingHead === undefined) {
    throw new Error(
      'product xHarness scoreboard requires at least one active shipping receipt',
    );
  }
  const firstShippingReceipt = shippingReceipts[0]!;
  const rootBaselineRollbackTarget = policy.rootBaselineRollbackTarget;
  if (
    rootBaselineRollbackTarget !== null &&
    (rootBaselineRollbackTarget.harnessSnapshotId !==
      firstShippingReceipt.baselineHarnessSnapshotId ||
      rootBaselineRollbackTarget.toolCapabilityPolicy.toolCapabilityPolicyId !==
        firstShippingReceipt.baselineToolCapabilityPolicyId)
  ) {
    throw new Error(
      'product xHarness scoreboard root baseline rollback target does not match the shipping root',
    );
  }
  const outcomesByShippingReceipt = new Map<
    Sha256Digest,
    ProductXHarnessToolPolicyOutcomeReceipt[]
  >();
  for (const outcome of await listAllProductXHarnessToolPolicyOutcomeReceipts(
    input.stateRoot,
  )) {
    const outcomes = outcomesByShippingReceipt.get(
      outcome.shippingReceiptDigest,
    );
    if (outcomes === undefined) {
      outcomesByShippingReceipt.set(outcome.shippingReceiptDigest, [outcome]);
    } else {
      outcomes.push(outcome);
    }
  }
  const rounds: ProductXHarnessToolPolicyRoundScore[] = [];
  const candidateAccumulators = new Map<string, CandidateAccumulator>();
  for (const [ordinal, shippingReceipt] of shippingReceipts.entries()) {
    const outcomes = [
      ...(outcomesByShippingReceipt.get(
        shippingReceipt.shippingReceiptDigest,
      ) ?? []),
    ].sort((left, right) =>
      left.outcomeReceiptDigest.localeCompare(right.outcomeReceiptDigest),
    );
    const taskScores = aggregateTaskScores(outcomes, policy.attemptAggregation);
    rounds.push(
      Object.freeze({
        shippingReceiptDigest: shippingReceipt.shippingReceiptDigest,
        previousShippingReceiptDigest:
          shippingReceipt.previousShippingReceiptDigest,
        candidateId: shippingReceipt.candidateId,
        packetDigest: shippingReceipt.packetDigest,
        baselineHarnessSnapshotId: shippingReceipt.baselineHarnessSnapshotId,
        candidateHarnessSnapshotId: shippingReceipt.candidateHarnessSnapshotId,
        baselineToolCapabilityPolicyId:
          shippingReceipt.baselineToolCapabilityPolicyId,
        candidateToolCapabilityPolicy:
          shippingReceipt.candidateToolCapabilityPolicy,
        outcomeReceiptDigests: Object.freeze(
          outcomes.map((outcome) => outcome.outcomeReceiptDigest),
        ),
        taskScores,
      }),
    );
    if (
      shippingReceipt.candidateId === null ||
      shippingReceipt.packetDigest === null
    ) {
      if (outcomes.length > 0) {
        throw new Error(
          'product xHarness root-baseline transition unexpectedly has candidate outcomes',
        );
      }
      continue;
    }
    const current = candidateAccumulators.get(shippingReceipt.candidateId);
    if (current === undefined) {
      candidateAccumulators.set(shippingReceipt.candidateId, {
        candidateId: shippingReceipt.candidateId,
        packetDigest: shippingReceipt.packetDigest,
        candidateHarnessSnapshotId: shippingReceipt.candidateHarnessSnapshotId,
        candidateToolCapabilityPolicy:
          shippingReceipt.candidateToolCapabilityPolicy,
        shippingReceiptDigests: [shippingReceipt.shippingReceiptDigest],
        shippingOrdinals: [ordinal],
        outcomes,
      });
      continue;
    }
    if (
      current.packetDigest !== shippingReceipt.packetDigest ||
      current.candidateHarnessSnapshotId !==
        shippingReceipt.candidateHarnessSnapshotId ||
      current.candidateToolCapabilityPolicy.toolCapabilityPolicyId !==
        shippingReceipt.candidateToolCapabilityPolicy.toolCapabilityPolicyId
    ) {
      throw new Error(
        'product xHarness candidate identity maps to inconsistent executable evidence',
      );
    }
    current.shippingReceiptDigests.push(shippingReceipt.shippingReceiptDigest);
    current.shippingOrdinals.push(ordinal);
    current.outcomes.push(...outcomes);
  }
  const candidateReputations = Object.freeze(
    [...candidateAccumulators.values()]
      .map((candidate) => createCandidateReputation(candidate, policy))
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
  );
  const body = Object.freeze({
    schemaVersion: 1 as const,
    scoreboardKind: 'xharness_tool_choice_cross_round' as const,
    policy,
    shippingHeadDigest: shippingHead.shippingReceiptDigest,
    shippingReceiptDigests: Object.freeze(
      shippingReceipts.map((receipt) => receipt.shippingReceiptDigest),
    ),
    rounds: Object.freeze(rounds),
    candidateReputations,
  });
  const scoreboardDigest: Sha256Digest = `sha256:${sha256StableJson(body)}`;
  return Object.freeze({ ...body, scoreboardDigest });
}

export function createProductXHarnessToolPolicyCrossRoundAuthority(
  scoreboardValue: unknown,
): ProductXHarnessToolPolicyCrossRoundAuthority {
  const scoreboard = parseProductXHarnessToolPolicyScoreboard(scoreboardValue);
  const activeRound = scoreboard.rounds.at(-1)!;
  const eligible = scoreboard.candidateReputations.filter(
    (candidate) =>
      candidate.observedTaskCount >= scoreboard.policy.minimumObservedTasks &&
      rateMeetsThreshold(candidate.hitRate, scoreboard.policy.minimumHitRate),
  );
  const rankedEligible = [...eligible].sort((left, right) =>
    compareCandidateReputations(
      left,
      right,
      activeRound.candidateId,
      scoreboard.policy.tieBreak,
    ),
  );
  const eligibleCandidateIds = Object.freeze(
    rankedEligible.map((candidate) => candidate.candidateId),
  );
  const winner = rankedEligible[0];
  let action: ProductXHarnessToolPolicyCrossRoundAuthority['action'];
  let decisionReason: ProductXHarnessToolPolicyCrossRoundAuthority['decisionReason'];
  let selectedCandidateId: string | null;
  let target: ProductXHarnessToolPolicyCrossRoundTarget;
  if (winner !== undefined) {
    selectedCandidateId = winner.candidateId;
    const winnerRound = findLastCandidateRound(scoreboard.rounds, winner);
    if (
      winnerRound.shippingReceiptDigest === activeRound.shippingReceiptDigest
    ) {
      action = 'hold_active';
      decisionReason = 'eligible_winner_already_active';
      target = createTarget(activeRound);
    } else if (
      winner.candidateToolCapabilityPolicy.toolCapabilityPolicyId ===
      activeRound.candidateToolCapabilityPolicy.toolCapabilityPolicyId
    ) {
      action = 'hold_active';
      decisionReason = 'selected_policy_already_active';
      target = createTarget(activeRound);
    } else {
      action = 'select_winner';
      decisionReason = 'eligible_winner_selected';
      target = createTarget(winnerRound);
    }
  } else if (
    scoreboard.policy.noEligibleCandidateAction === 'rollback_to_predecessor'
  ) {
    selectedCandidateId = null;
    const predecessor =
      activeRound.previousShippingReceiptDigest === null
        ? undefined
        : scoreboard.rounds.find(
            (round) =>
              round.shippingReceiptDigest ===
              activeRound.previousShippingReceiptDigest,
          );
    if (predecessor === undefined) {
      const rootBaselineRollbackTarget =
        scoreboard.policy.rootBaselineRollbackTarget;
      if (rootBaselineRollbackTarget === null) {
        action = 'hold_active';
        decisionReason = 'rollback_target_unavailable';
        target = createTarget(activeRound);
      } else {
        action = 'rollback_to_predecessor';
        decisionReason = 'no_eligible_candidate_rollback';
        target = createRootBaselineTarget(rootBaselineRollbackTarget);
      }
    } else {
      action = 'rollback_to_predecessor';
      decisionReason = 'no_eligible_candidate_rollback';
      selectedCandidateId = predecessor.candidateId;
      target = createTarget(predecessor);
    }
  } else {
    action = 'hold_active';
    decisionReason = 'no_eligible_candidate_hold';
    selectedCandidateId = null;
    target = createTarget(activeRound);
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    authorityKind: 'xharness_tool_choice_cross_round' as const,
    scoreboardDigest: scoreboard.scoreboardDigest,
    policyId: scoreboard.policy.policyId,
    observedShippingHeadDigest: scoreboard.shippingHeadDigest,
    action,
    decisionReason,
    activeCandidateId: activeRound.candidateId,
    eligibleCandidateIds,
    selectedCandidateId,
    target,
  });
  const authorityDigest: Sha256Digest = `sha256:${sha256StableJson(body)}`;
  return Object.freeze({ ...body, authorityDigest });
}

export function parseProductXHarnessToolPolicyScoreboard(
  value: unknown,
): ProductXHarnessToolPolicyScoreboard {
  const record = assertExactPlainRecord(
    value,
    [
      'schemaVersion',
      'scoreboardKind',
      'policy',
      'shippingHeadDigest',
      'shippingReceiptDigests',
      'rounds',
      'candidateReputations',
      'scoreboardDigest',
    ],
    'product xHarness scoreboard',
  );
  if (
    record.schemaVersion !== 1 ||
    record.scoreboardKind !== 'xharness_tool_choice_cross_round'
  ) {
    throw new Error('unsupported product xHarness scoreboard');
  }
  const policy = parseProductXHarnessToolPolicyScoreboardPolicy(record.policy);
  const shippingReceiptDigests = readDigestArray(
    record.shippingReceiptDigests,
    'shippingReceiptDigests',
  );
  if (shippingReceiptDigests.length === 0) {
    throw new Error(
      'product xHarness scoreboard requires at least one shipping receipt',
    );
  }
  const rounds = readArray(record.rounds, 'rounds').map((round, index) =>
    parseRoundScore(round, index),
  );
  if (
    rounds.length !== shippingReceiptDigests.length ||
    rounds.some(
      (round, index) =>
        round.shippingReceiptDigest !== shippingReceiptDigests[index] ||
        round.previousShippingReceiptDigest !==
          (index === 0 ? null : shippingReceiptDigests[index - 1]),
    )
  ) {
    throw new Error(
      'product xHarness scoreboard rounds do not reproduce the shipping chain',
    );
  }
  const shippingHeadDigest = readDigest(
    record.shippingHeadDigest,
    'shippingHeadDigest',
  );
  if (shippingHeadDigest !== shippingReceiptDigests.at(-1)) {
    throw new Error(
      'product xHarness scoreboard head does not match its shipping chain',
    );
  }
  const candidateReputations = Object.freeze(
    readArray(record.candidateReputations, 'candidateReputations').map(
      (candidate) => parseCandidateReputation(candidate),
    ),
  );
  assertCanonicalCandidateReputations(candidateReputations);
  const body = Object.freeze({
    schemaVersion: 1 as const,
    scoreboardKind: 'xharness_tool_choice_cross_round' as const,
    policy,
    shippingHeadDigest,
    shippingReceiptDigests,
    rounds: Object.freeze(rounds),
    candidateReputations,
  });
  const scoreboardDigest: Sha256Digest = `sha256:${sha256StableJson(body)}`;
  if (record.scoreboardDigest !== scoreboardDigest) {
    throw new Error(
      'product xHarness scoreboard digest does not match its body',
    );
  }
  return Object.freeze({ ...body, scoreboardDigest });
}

export async function publishProductXHarnessToolPolicyScoreboard(
  stateRoot: string,
  scoreboardValue: unknown,
): Promise<{
  readonly scoreboard: ProductXHarnessToolPolicyScoreboard;
  readonly created: boolean;
}> {
  const scoreboard = parseProductXHarnessToolPolicyScoreboard(scoreboardValue);
  const publication = await publishProductXHarnessImmutableJson({
    targetPath: scoreboardPath(stateRoot, scoreboard.scoreboardDigest),
    pendingDirectory: scoreboardPendingDirectory(stateRoot),
    value: scoreboard,
    conflictMessage: 'product xHarness scoreboard conflicts',
  });
  return Object.freeze({ scoreboard, created: publication.created });
}

export async function publishProductXHarnessToolPolicyCrossRoundAuthority(
  stateRoot: string,
  authorityValue: unknown,
): Promise<{
  readonly authority: ProductXHarnessToolPolicyCrossRoundAuthority;
  readonly created: boolean;
}> {
  const authorityRecord = assertPlainRecord(
    authorityValue,
    'product xHarness cross-round authority',
  );
  const scoreboardDigest = readDigest(
    authorityRecord.scoreboardDigest,
    'scoreboardDigest',
  );
  const scoreboard = await readProductXHarnessToolPolicyScoreboard(
    stateRoot,
    scoreboardDigest,
  );
  const expected =
    createProductXHarnessToolPolicyCrossRoundAuthority(scoreboard);
  if (stableStringify(authorityValue) !== stableStringify(expected)) {
    throw new Error(
      'product xHarness cross-round authority does not match its scoreboard',
    );
  }
  const publication = await publishProductXHarnessImmutableJson({
    targetPath: authorityPath(stateRoot, expected.authorityDigest),
    pendingDirectory: scoreboardPendingDirectory(stateRoot),
    value: expected,
    conflictMessage: 'product xHarness cross-round authority conflicts',
  });
  return Object.freeze({
    authority: expected,
    created: publication.created,
  });
}

async function readProductXHarnessToolPolicyScoreboard(
  stateRoot: string,
  scoreboardDigest: string,
): Promise<ProductXHarnessToolPolicyScoreboard> {
  const digest = readDigest(scoreboardDigest, 'scoreboardDigest');
  const scoreboard = parseProductXHarnessToolPolicyScoreboard(
    await readRequiredJson(
      scoreboardPath(stateRoot, digest),
      'product xHarness scoreboard is unavailable',
    ),
  );
  if (scoreboard.scoreboardDigest !== digest) {
    throw new Error('product xHarness scoreboard path does not match its body');
  }
  return scoreboard;
}

export async function readProductXHarnessToolPolicyCrossRoundAuthority(
  stateRoot: string,
  authorityDigest: string,
): Promise<ProductXHarnessToolPolicyCrossRoundAuthority> {
  const digest = readDigest(authorityDigest, 'authorityDigest');
  const value = await readRequiredJson(
    authorityPath(stateRoot, digest),
    'product xHarness cross-round authority is unavailable',
  );
  const record = assertExactPlainRecord(
    value,
    [
      'schemaVersion',
      'authorityKind',
      'scoreboardDigest',
      'policyId',
      'observedShippingHeadDigest',
      'action',
      'decisionReason',
      'activeCandidateId',
      'eligibleCandidateIds',
      'selectedCandidateId',
      'target',
      'authorityDigest',
    ],
    'product xHarness cross-round authority',
  );
  const scoreboard = await readProductXHarnessToolPolicyScoreboard(
    stateRoot,
    readDigest(record.scoreboardDigest, 'scoreboardDigest'),
  );
  const expected =
    createProductXHarnessToolPolicyCrossRoundAuthority(scoreboard);
  if (
    expected.authorityDigest !== digest ||
    stableStringify(value) !== stableStringify(expected)
  ) {
    throw new Error(
      'product xHarness cross-round authority does not reproduce from its scoreboard',
    );
  }
  return expected;
}

export async function applyProductXHarnessToolPolicyCrossRoundAuthority(
  stateRoot: string,
  authorityDigest: string,
): Promise<{
  readonly authority: ProductXHarnessToolPolicyCrossRoundAuthority;
  readonly transition: {
    readonly receipt: ProductXHarnessToolPolicyCrossRoundShippingReceipt;
    readonly created: boolean;
  } | null;
}> {
  const authority = await readProductXHarnessToolPolicyCrossRoundAuthority(
    stateRoot,
    authorityDigest,
  );
  const scoreboard = await readProductXHarnessToolPolicyScoreboard(
    stateRoot,
    authority.scoreboardDigest,
  );
  const rebuilt = await buildProductXHarnessToolPolicyScoreboard({
    stateRoot,
    policy: scoreboard.policy,
  });
  if (rebuilt.scoreboardDigest !== scoreboard.scoreboardDigest) {
    const chain =
      await listProductXHarnessToolPolicyShippingReceipts(stateRoot);
    const currentHead = chain.at(-1);
    if (
      currentHead?.schemaVersion === 2 &&
      currentHead.authorityDigest === authority.authorityDigest
    ) {
      return Object.freeze({
        authority,
        transition: Object.freeze({
          receipt: currentHead,
          created: false,
        }),
      });
    }
    throw new Error(
      'product xHarness cross-round authority evidence is stale or changed',
    );
  }
  if (authority.action === 'hold_active') {
    return Object.freeze({ authority, transition: null });
  }
  const transition = await publishProductXHarnessToolPolicyCrossRoundTransition(
    stateRoot,
    {
      transitionAction: authority.action,
      authorityDigest: authority.authorityDigest,
      scoreboardDigest: authority.scoreboardDigest,
      observedShippingHeadDigest: authority.observedShippingHeadDigest,
      sourceShippingReceiptDigest: authority.target.sourceShippingReceiptDigest,
      candidateId: authority.target.candidateId,
      packetDigest: authority.target.packetDigest,
      candidateHarnessSnapshotId: authority.target.candidateHarnessSnapshotId,
      candidateToolCapabilityPolicy:
        authority.target.candidateToolCapabilityPolicy,
    },
  );
  return Object.freeze({ authority, transition });
}

function createCandidateReputation(
  candidate: CandidateAccumulator,
  policy: ProductXHarnessToolPolicyScoreboardPolicy,
): ProductXHarnessToolPolicyCandidateReputation {
  const taskScores = aggregateTaskScores(
    candidate.outcomes,
    policy.attemptAggregation,
  );
  const passedTaskCount = taskScores.filter((task) => task.passed).length;
  const observedTaskCount = taskScores.length;
  return Object.freeze({
    candidateId: candidate.candidateId,
    packetDigest: candidate.packetDigest,
    candidateHarnessSnapshotId: candidate.candidateHarnessSnapshotId,
    candidateToolCapabilityPolicy: candidate.candidateToolCapabilityPolicy,
    shippingReceiptDigests: Object.freeze([
      ...candidate.shippingReceiptDigests,
    ]),
    firstShippingOrdinal: candidate.shippingOrdinals[0]!,
    lastShippingOrdinal: candidate.shippingOrdinals.at(-1)!,
    taskScores,
    observedTaskCount,
    passedTaskCount,
    failedTaskCount: observedTaskCount - passedTaskCount,
    hitRate: Object.freeze({
      passedTasks: passedTaskCount,
      observedTasks: observedTaskCount,
    }),
  });
}

function aggregateTaskScores(
  outcomes: readonly ProductXHarnessToolPolicyOutcomeReceipt[],
  attemptAggregation: 'all_attempts_must_pass' | 'any_attempt_may_pass',
): readonly ProductXHarnessToolPolicyTaskScore[] {
  const byTask = new Map<
    Sha256Digest,
    ProductXHarnessToolPolicyOutcomeReceipt[]
  >();
  for (const outcome of outcomes) {
    const entries = byTask.get(outcome.taskReferenceId);
    if (entries === undefined) {
      byTask.set(outcome.taskReferenceId, [outcome]);
    } else {
      entries.push(outcome);
    }
  }
  return Object.freeze(
    [...byTask.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([taskReferenceId, taskOutcomes]) => {
        taskOutcomes.sort((left, right) =>
          left.outcomeReceiptDigest.localeCompare(right.outcomeReceiptDigest),
        );
        const evaluationRuleId = taskOutcomes[0]!.evaluationRuleId;
        if (
          taskOutcomes.some(
            (outcome) => outcome.evaluationRuleId !== evaluationRuleId,
          )
        ) {
          throw new Error(
            'product xHarness task outcomes use inconsistent evaluation rules',
          );
        }
        const outcomeReceiptDigests = Object.freeze(
          taskOutcomes.map((outcome) => outcome.outcomeReceiptDigest),
        );
        const attemptReferences = Object.freeze(
          taskOutcomes.map((outcome) => outcome.attemptReference).sort(),
        );
        assertUniqueStrings(
          outcomeReceiptDigests,
          'product xHarness task outcome receipt',
        );
        assertUniqueStrings(attemptReferences, 'product xHarness task attempt');
        return Object.freeze({
          taskReferenceId,
          evaluationRuleId,
          outcomeReceiptDigests,
          attemptReferences,
          passed:
            attemptAggregation === 'all_attempts_must_pass'
              ? taskOutcomes.every((outcome) => outcome.passed)
              : taskOutcomes.some((outcome) => outcome.passed),
        });
      }),
  );
}

function compareCandidateReputations(
  left: ProductXHarnessToolPolicyCandidateReputation,
  right: ProductXHarnessToolPolicyCandidateReputation,
  activeCandidateId: string | null,
  tieBreak: ProductXHarnessToolPolicyScoreboardPolicy['tieBreak'],
): number {
  const hitRateComparison = compareHitRates(right.hitRate, left.hitRate);
  if (hitRateComparison !== 0) {
    return hitRateComparison;
  }
  if (
    tieBreak === 'active_then_earliest_shipping' ||
    tieBreak === 'active_then_latest_shipping'
  ) {
    const leftActive = left.candidateId === activeCandidateId;
    const rightActive = right.candidateId === activeCandidateId;
    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1;
    }
  }
  const preferLatest =
    tieBreak === 'latest_shipping' ||
    tieBreak === 'active_then_latest_shipping';
  const ordinalComparison = preferLatest
    ? right.lastShippingOrdinal - left.lastShippingOrdinal
    : left.firstShippingOrdinal - right.firstShippingOrdinal;
  return ordinalComparison === 0
    ? left.candidateId.localeCompare(right.candidateId)
    : ordinalComparison;
}

function compareHitRates(
  left: ProductXHarnessToolPolicyHitRate,
  right: ProductXHarnessToolPolicyHitRate,
): number {
  const leftProduct = BigInt(left.passedTasks) * BigInt(right.observedTasks);
  const rightProduct = BigInt(right.passedTasks) * BigInt(left.observedTasks);
  return leftProduct < rightProduct ? -1 : leftProduct > rightProduct ? 1 : 0;
}

function rateMeetsThreshold(
  rate: ProductXHarnessToolPolicyHitRate,
  threshold: ProductXHarnessToolPolicyScoreboardPolicy['minimumHitRate'],
): boolean {
  return (
    BigInt(rate.passedTasks) * BigInt(threshold.denominator) >=
    BigInt(rate.observedTasks) * BigInt(threshold.numerator)
  );
}

function findLastCandidateRound(
  rounds: readonly ProductXHarnessToolPolicyRoundScore[],
  candidate: ProductXHarnessToolPolicyCandidateReputation,
): ProductXHarnessToolPolicyRoundScore {
  const digest = candidate.shippingReceiptDigests.at(-1)!;
  const round = rounds.find(
    (candidateRound) => candidateRound.shippingReceiptDigest === digest,
  );
  if (round === undefined) {
    throw new Error(
      'product xHarness candidate reputation references an unavailable round',
    );
  }
  return round;
}

function createTarget(
  round: ProductXHarnessToolPolicyRoundScore,
): ProductXHarnessToolPolicyCrossRoundTarget {
  return Object.freeze({
    sourceShippingReceiptDigest: round.shippingReceiptDigest,
    candidateId: round.candidateId,
    packetDigest: round.packetDigest,
    candidateHarnessSnapshotId: round.candidateHarnessSnapshotId,
    candidateToolCapabilityPolicy: round.candidateToolCapabilityPolicy,
  });
}

function createRootBaselineTarget(
  target: ProductXHarnessToolPolicyRootBaselineRollbackTarget,
): ProductXHarnessToolPolicyCrossRoundTarget {
  return Object.freeze({
    sourceShippingReceiptDigest: null,
    candidateId: null,
    packetDigest: null,
    candidateHarnessSnapshotId: target.harnessSnapshotId,
    candidateToolCapabilityPolicy: target.toolCapabilityPolicy,
  });
}

function parseRoundScore(
  value: unknown,
  ordinal: number,
): ProductXHarnessToolPolicyRoundScore {
  const record = assertExactPlainRecord(
    value,
    [
      'shippingReceiptDigest',
      'previousShippingReceiptDigest',
      'candidateId',
      'packetDigest',
      'baselineHarnessSnapshotId',
      'candidateHarnessSnapshotId',
      'baselineToolCapabilityPolicyId',
      'candidateToolCapabilityPolicy',
      'outcomeReceiptDigests',
      'taskScores',
    ],
    `product xHarness scoreboard round ${ordinal}`,
  );
  const candidateId =
    record.candidateId === null
      ? null
      : readCandidateId(record.candidateId, 'candidateId');
  const packetDigest =
    record.packetDigest === null
      ? null
      : readDigest(record.packetDigest, 'packetDigest');
  if ((candidateId === null) !== (packetDigest === null)) {
    throw new Error(
      'product xHarness scoreboard round candidate provenance is incomplete',
    );
  }
  const outcomeReceiptDigests = readDigestArray(
    record.outcomeReceiptDigests,
    'outcomeReceiptDigests',
  );
  const taskScores = Object.freeze(
    readArray(record.taskScores, 'taskScores').map((task) =>
      parseTaskScore(task),
    ),
  );
  const flattened = taskScores
    .flatMap((task) => task.outcomeReceiptDigests)
    .sort();
  if (
    flattened.length !== outcomeReceiptDigests.length ||
    flattened.some(
      (digest, index) => digest !== [...outcomeReceiptDigests].sort()[index],
    )
  ) {
    throw new Error(
      'product xHarness scoreboard round task scores do not cover its outcomes',
    );
  }
  return Object.freeze({
    shippingReceiptDigest: readDigest(
      record.shippingReceiptDigest,
      'shippingReceiptDigest',
    ),
    previousShippingReceiptDigest:
      record.previousShippingReceiptDigest === null
        ? null
        : readDigest(
            record.previousShippingReceiptDigest,
            'previousShippingReceiptDigest',
          ),
    candidateId,
    packetDigest,
    baselineHarnessSnapshotId: readDigest(
      record.baselineHarnessSnapshotId,
      'baselineHarnessSnapshotId',
    ),
    candidateHarnessSnapshotId: readDigest(
      record.candidateHarnessSnapshotId,
      'candidateHarnessSnapshotId',
    ),
    baselineToolCapabilityPolicyId: readDigest(
      record.baselineToolCapabilityPolicyId,
      'baselineToolCapabilityPolicyId',
    ),
    candidateToolCapabilityPolicy: parseHarnessToolCapabilityPolicy(
      JSON.stringify(record.candidateToolCapabilityPolicy),
    ),
    outcomeReceiptDigests,
    taskScores,
  });
}

function parseCandidateReputation(
  value: unknown,
): ProductXHarnessToolPolicyCandidateReputation {
  const record = assertExactPlainRecord(
    value,
    [
      'candidateId',
      'packetDigest',
      'candidateHarnessSnapshotId',
      'candidateToolCapabilityPolicy',
      'shippingReceiptDigests',
      'firstShippingOrdinal',
      'lastShippingOrdinal',
      'taskScores',
      'observedTaskCount',
      'passedTaskCount',
      'failedTaskCount',
      'hitRate',
    ],
    'product xHarness candidate reputation',
  );
  const taskScores = Object.freeze(
    readArray(record.taskScores, 'taskScores').map((task) =>
      parseTaskScore(task),
    ),
  );
  const observedTaskCount = readNonNegativeSafeInteger(
    record.observedTaskCount,
    'observedTaskCount',
  );
  const passedTaskCount = readNonNegativeSafeInteger(
    record.passedTaskCount,
    'passedTaskCount',
  );
  const failedTaskCount = readNonNegativeSafeInteger(
    record.failedTaskCount,
    'failedTaskCount',
  );
  const hitRateRecord = assertExactPlainRecord(
    record.hitRate,
    ['passedTasks', 'observedTasks'],
    'product xHarness candidate hit rate',
  );
  const hitRate = Object.freeze({
    passedTasks: readNonNegativeSafeInteger(
      hitRateRecord.passedTasks,
      'hitRate.passedTasks',
    ),
    observedTasks: readNonNegativeSafeInteger(
      hitRateRecord.observedTasks,
      'hitRate.observedTasks',
    ),
  });
  if (
    observedTaskCount !== taskScores.length ||
    passedTaskCount !== taskScores.filter((task) => task.passed).length ||
    failedTaskCount !== observedTaskCount - passedTaskCount ||
    hitRate.passedTasks !== passedTaskCount ||
    hitRate.observedTasks !== observedTaskCount
  ) {
    throw new Error(
      'product xHarness candidate reputation counts are inconsistent',
    );
  }
  const firstShippingOrdinal = readNonNegativeSafeInteger(
    record.firstShippingOrdinal,
    'firstShippingOrdinal',
  );
  const lastShippingOrdinal = readNonNegativeSafeInteger(
    record.lastShippingOrdinal,
    'lastShippingOrdinal',
  );
  if (firstShippingOrdinal > lastShippingOrdinal) {
    throw new Error(
      'product xHarness candidate reputation shipping ordinals are invalid',
    );
  }
  return Object.freeze({
    candidateId: readCandidateId(record.candidateId, 'candidateId'),
    packetDigest: readDigest(record.packetDigest, 'packetDigest'),
    candidateHarnessSnapshotId: readDigest(
      record.candidateHarnessSnapshotId,
      'candidateHarnessSnapshotId',
    ),
    candidateToolCapabilityPolicy: parseHarnessToolCapabilityPolicy(
      JSON.stringify(record.candidateToolCapabilityPolicy),
    ),
    shippingReceiptDigests: readDigestArray(
      record.shippingReceiptDigests,
      'shippingReceiptDigests',
    ),
    firstShippingOrdinal,
    lastShippingOrdinal,
    taskScores,
    observedTaskCount,
    passedTaskCount,
    failedTaskCount,
    hitRate,
  });
}

function parseTaskScore(value: unknown): ProductXHarnessToolPolicyTaskScore {
  const record = assertExactPlainRecord(
    value,
    [
      'taskReferenceId',
      'evaluationRuleId',
      'outcomeReceiptDigests',
      'attemptReferences',
      'passed',
    ],
    'product xHarness task score',
  );
  const outcomeReceiptDigests = readDigestArray(
    record.outcomeReceiptDigests,
    'outcomeReceiptDigests',
  );
  const attemptReferences = readStringArray(
    record.attemptReferences,
    'attemptReferences',
  );
  if (
    outcomeReceiptDigests.length === 0 ||
    outcomeReceiptDigests.length !== attemptReferences.length
  ) {
    throw new Error(
      'product xHarness task score must bind one attempt per outcome',
    );
  }
  if (typeof record.passed !== 'boolean') {
    throw new Error('product xHarness task score passed must be a boolean');
  }
  return Object.freeze({
    taskReferenceId: readDigest(record.taskReferenceId, 'taskReferenceId'),
    evaluationRuleId: readNonEmptyString(
      record.evaluationRuleId,
      'evaluationRuleId',
    ),
    outcomeReceiptDigests,
    attemptReferences,
    passed: record.passed,
  });
}

function assertCanonicalCandidateReputations(
  candidates: readonly ProductXHarnessToolPolicyCandidateReputation[],
): void {
  const ids = candidates.map((candidate) => candidate.candidateId);
  assertUniqueStrings(ids, 'product xHarness candidate reputation');
  const sorted = [...ids].sort();
  if (ids.some((id, index) => id !== sorted[index])) {
    throw new Error(
      'product xHarness candidate reputations must be canonically ordered',
    );
  }
}

function readAttemptAggregation(
  value: unknown,
): ProductXHarnessToolPolicyScoreboardPolicy['attemptAggregation'] {
  if (value !== 'all_attempts_must_pass' && value !== 'any_attempt_may_pass') {
    throw new Error(
      'product xHarness scoreboard attempt aggregation is invalid',
    );
  }
  return value;
}

function readTieBreak(
  value: unknown,
): ProductXHarnessToolPolicyScoreboardPolicy['tieBreak'] {
  if (
    value !== 'earliest_shipping' &&
    value !== 'latest_shipping' &&
    value !== 'active_then_earliest_shipping' &&
    value !== 'active_then_latest_shipping'
  ) {
    throw new Error('product xHarness scoreboard tie break is invalid');
  }
  return value;
}

function readNoEligibleCandidateAction(
  value: unknown,
): ProductXHarnessToolPolicyScoreboardPolicy['noEligibleCandidateAction'] {
  if (value !== 'hold_active' && value !== 'rollback_to_predecessor') {
    throw new Error(
      'product xHarness scoreboard no-eligible action is invalid',
    );
  }
  return value;
}

function parseRootBaselineRollbackTarget(
  value: unknown,
): ProductXHarnessToolPolicyRootBaselineRollbackTarget | null {
  if (value === null) {
    return null;
  }
  const record = assertExactPlainRecord(
    value,
    ['harnessSnapshotId', 'toolCapabilityPolicy'],
    'product xHarness scoreboard root baseline rollback target',
  );
  const toolCapabilityPolicy = parseHarnessToolCapabilityPolicy(
    JSON.stringify(record.toolCapabilityPolicy),
  );
  if (toolCapabilityPolicy.writeCallbackEnabled) {
    throw new Error(
      'product xHarness scoreboard root baseline rollback target cannot enable write callbacks',
    );
  }
  return Object.freeze({
    harnessSnapshotId: readDigest(
      record.harnessSnapshotId,
      'rootBaselineRollbackTarget.harnessSnapshotId',
    ),
    toolCapabilityPolicy,
  });
}

function readCandidateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CANDIDATE_ID_PATTERN.test(value)) {
    throw new Error(`product xHarness scoreboard ${label} is invalid`);
  }
  return value;
}

function readDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`product xHarness scoreboard ${label} is invalid`);
  }
  return value as Sha256Digest;
}

function readDigestArray(
  value: unknown,
  label: string,
): readonly Sha256Digest[] {
  const values = Object.freeze(
    readArray(value, label).map((entry) => readDigest(entry, label)),
  );
  assertUniqueStrings(values, `product xHarness scoreboard ${label}`);
  return values;
}

function readStringArray(value: unknown, label: string): readonly string[] {
  const values = Object.freeze(
    readArray(value, label).map((entry) => readNonEmptyString(entry, label)),
  );
  assertUniqueStrings(values, `product xHarness scoreboard ${label}`);
  return values;
}

function readArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`product xHarness scoreboard ${label} must be an array`);
  }
  return value;
}

function readPositiveSafeInteger(value: unknown, label: string): number {
  const number = readNonNegativeSafeInteger(value, label);
  if (number === 0) {
    throw new Error(
      `product xHarness scoreboard ${label} must be greater than zero`,
    );
  }
  return number;
}

function readNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `product xHarness scoreboard ${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `product xHarness scoreboard ${label} must be a non-empty string`,
    );
  }
  return value;
}

function assertUniqueStrings(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicates`);
  }
}

function scoreboardRoot(stateRoot: string): string {
  return join(stateRoot, '.geulbat', 'xharness', 'tool-policy-scoreboards');
}

function scoreboardPendingDirectory(stateRoot: string): string {
  return join(scoreboardRoot(stateRoot), '.pending');
}

function scoreboardPath(
  stateRoot: string,
  scoreboardDigest: Sha256Digest,
): string {
  return join(
    scoreboardRoot(stateRoot),
    'scoreboards',
    `${scoreboardDigest.slice('sha256:'.length)}.json`,
  );
}

function authorityPath(
  stateRoot: string,
  authorityDigest: Sha256Digest,
): string {
  return join(
    scoreboardRoot(stateRoot),
    'authorities',
    `${authorityDigest.slice('sha256:'.length)}.json`,
  );
}
