import { join } from 'node:path';

import { stableStringify } from '@geulbat/content-identity/stable-json';

import { publishProductXHarnessImmutableJson } from '@geulbat/product/immutable-publication';
import {
  listProductXHarnessToolPolicyShippingReceipts,
  publishProductXHarnessToolPolicyCrossRoundTransition,
  type ProductXHarnessToolPolicyCrossRoundShippingReceipt,
} from '@geulbat/product/tool-policy-promotion';
import {
  assertExactPlainRecord,
  assertPlainRecord,
  readDigest,
  readRequiredJson,
  type Sha256Digest,
} from '@geulbat/product/cli-support';
import {
  buildProductXHarnessToolPolicyScoreboard,
  createProductXHarnessToolPolicyCrossRoundAuthority,
  parseProductXHarnessToolPolicyScoreboard,
} from './product-xharness-tool-policy-scoreboard.js';

type ProductXHarnessToolPolicyScoreboard = ReturnType<
  typeof parseProductXHarnessToolPolicyScoreboard
>;
type ProductXHarnessToolPolicyCrossRoundAuthority = ReturnType<
  typeof createProductXHarnessToolPolicyCrossRoundAuthority
>;

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
