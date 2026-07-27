import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';
import { createHarnessToolCapabilityPolicy } from '@geulbat/xharness/harness-snapshot';

import {
  publishProductXHarnessToolPolicyOutcomeReceipt,
  type ProductXHarnessToolPolicyOutcomePublication,
} from '../product-xharness-tool-policy-outcome.js';
import {
  publishProductXHarnessToolPolicyShippingReceipt,
  type ProductXHarnessToolPolicyShippingAuthority,
} from '@geulbat/product/tool-policy-promotion';
import { parseProductXHarnessToolPolicyScoreboardPolicy } from '../product-xharness-tool-policy-scoreboard.js';

export const BASELINE_SNAPSHOT_ID = digest('1');
export const FIRST_SNAPSHOT_ID = digest('2');
export const SECOND_SNAPSHOT_ID = digest('3');
export const FIRST_TASK_REFERENCE_ID = digest('4');
export const SECOND_TASK_REFERENCE_ID = digest('5');

export async function createScoreboardTestStateRoot(
  t: TestContext,
  label: string,
): Promise<string> {
  const stateRoot = await mkdtemp(
    join(tmpdir(), `geulbat-xharness-scoreboard-${label}-`),
  );
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  return stateRoot;
}

export function toolPolicy(names: readonly string[]) {
  return createHarnessToolCapabilityPolicy({
    directRegistryNames: names,
    allowedRegistryNames: names,
    callbackRegistryNames: names,
    writeCallbackEnabled: false,
  });
}

export function scoreboardPolicy(
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
): ReturnType<typeof parseProductXHarnessToolPolicyScoreboardPolicy> {
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

export async function publishTestScoreboardShippingRound(
  stateRoot: string,
  input: {
    readonly candidateId: string;
    readonly baselinePolicyId: string;
    readonly candidatePolicy: ReturnType<typeof toolPolicy>;
    readonly baselineSnapshotId: string;
    readonly candidateSnapshotId: string;
    readonly marker: string;
  },
) {
  return publishProductXHarnessToolPolicyShippingReceipt(
    stateRoot,
    shippingAuthority(input),
  );
}

export async function publishTestScoreboardOutcome(
  stateRoot: string,
  input: {
    readonly shippingReceiptDigest: string;
    readonly taskReferenceId: string;
    readonly attemptMarker: string;
    readonly harnessSnapshotId: string;
    readonly evidenceMarker: string;
    readonly passed: boolean;
  },
) {
  return publishProductXHarnessToolPolicyOutcomeReceipt(
    stateRoot,
    outcomeAuthority({
      shippingReceiptDigest: input.shippingReceiptDigest,
      taskReferenceId: input.taskReferenceId,
      attemptReference: attempt(input.attemptMarker),
      harnessSnapshotId: input.harnessSnapshotId,
      marker: input.evidenceMarker,
      passed: input.passed,
    }),
  );
}

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
