import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  sha256StableJson,
  stableStringify,
} from '@geulbat/content-identity/stable-json';

import { publishProductXHarnessImmutableBytes } from '@geulbat/product/immutable-publication';
import {
  listProductXHarnessToolPolicyShippingReceipts,
  readActiveProductXHarnessToolPolicyShippingReceipt,
  type ProductXHarnessToolPolicyShippingReceipt,
} from '@geulbat/product/tool-policy-promotion';
import {
  assertExactPlainRecord,
  isErrorCode,
  readRequiredJson,
} from '@geulbat/product/cli-support';

const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u;
const ATTEMPT_REFERENCE_PATTERN = /^[0-9a-f]{64}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export interface ProductXHarnessToolPolicyOutcomeReceipt {
  readonly schemaVersion: 1;
  readonly receiptKind: 'xharness_tool_choice_policy_outcome';
  readonly shippingReceiptDigest: `sha256:${string}`;
  readonly candidateId: string;
  readonly packetDigest: `sha256:${string}`;
  readonly taskReferenceId: `sha256:${string}`;
  readonly attemptReference: string;
  readonly evidenceReferenceId: `sha256:${string}`;
  readonly evidenceDigest: `sha256:${string}`;
  readonly harnessSnapshotId: `sha256:${string}`;
  readonly evaluationRuleId: string;
  readonly evaluationDigest: `sha256:${string}`;
  readonly passed: boolean;
  readonly outcomeReceiptDigest: `sha256:${string}`;
}

interface ProductXHarnessToolPolicyOutcomeAuthority {
  readonly shippingReceiptDigest: string;
  readonly taskReferenceId: string;
  readonly attemptReference: string;
  readonly evidenceReferenceId: string;
  readonly evidenceDigest: string;
  readonly harnessSnapshotId: string;
  readonly evaluationRuleId: string;
  readonly evaluationDigest: string;
  readonly passed: boolean;
}

/**
 * 발행 입력. receipt 본문(authority)에 더해 평가 본문을 함께 받는다.
 *
 * receipt는 평가의 손실 투영이다 — `passed` 한 비트와 식별자 몇 개만 남고 라운드
 * 수·도구 호출·토큰·시간 같은 관측은 `evaluationDigest` 뒤로 사라진다. 본문을
 * 남기지 않으면 그 digest는 존재하지 않는 것을 가리킨다.
 *
 * 이 오너는 본문의 모양을 소유하지 않는다 — 규칙 평가자가 소유한다. 여기서는
 * canonical JSON으로 직렬화하고 선언된 digest와 일치하는지만 확인한다.
 */
export interface ProductXHarnessToolPolicyOutcomePublication extends ProductXHarnessToolPolicyOutcomeAuthority {
  readonly evaluation: unknown;
}

interface ProductXHarnessToolPolicyOutcomeClaim {
  readonly schemaVersion: 1;
  readonly shippingReceiptDigest: `sha256:${string}`;
  readonly attemptReference: string;
  readonly outcomeReceiptDigest: `sha256:${string}`;
}

function createProductXHarnessToolPolicyOutcomeReceipt(
  input: ProductXHarnessToolPolicyOutcomeAuthority & {
    readonly candidateId: string;
    readonly packetDigest: string;
  },
): ProductXHarnessToolPolicyOutcomeReceipt {
  const shippingReceiptDigest = parseDigest(
    input.shippingReceiptDigest,
    'shippingReceiptDigest',
  );
  const candidateId = parseOpaqueId(input.candidateId, 'candidateId');
  const packetDigest = parseDigest(input.packetDigest, 'packetDigest');
  const taskReferenceId = parseDigest(input.taskReferenceId, 'taskReferenceId');
  const attemptReference = parseAttemptReference(input.attemptReference);
  const evidenceReferenceId = parseDigest(
    input.evidenceReferenceId,
    'evidenceReferenceId',
  );
  const evidenceDigest = parseDigest(input.evidenceDigest, 'evidenceDigest');
  const harnessSnapshotId = parseDigest(
    input.harnessSnapshotId,
    'harnessSnapshotId',
  );
  const evaluationRuleId = parseOpaqueId(
    input.evaluationRuleId,
    'evaluationRuleId',
  );
  const evaluationDigest = parseDigest(
    input.evaluationDigest,
    'evaluationDigest',
  );
  if (typeof input.passed !== 'boolean') {
    throw new Error('product xHarness outcome passed must be a boolean');
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    receiptKind: 'xharness_tool_choice_policy_outcome' as const,
    shippingReceiptDigest,
    candidateId,
    packetDigest,
    taskReferenceId,
    attemptReference,
    evidenceReferenceId,
    evidenceDigest,
    harnessSnapshotId,
    evaluationRuleId,
    evaluationDigest,
    passed: input.passed,
  });
  const outcomeReceiptDigest: `sha256:${string}` = `sha256:${sha256StableJson(body)}`;
  return Object.freeze({ ...body, outcomeReceiptDigest });
}

export function parseProductXHarnessToolPolicyOutcomeReceipt(
  value: unknown,
): ProductXHarnessToolPolicyOutcomeReceipt {
  const record = assertExactPlainRecord(
    value,
    [
      'schemaVersion',
      'receiptKind',
      'shippingReceiptDigest',
      'candidateId',
      'packetDigest',
      'taskReferenceId',
      'attemptReference',
      'evidenceReferenceId',
      'evidenceDigest',
      'harnessSnapshotId',
      'evaluationRuleId',
      'evaluationDigest',
      'passed',
      'outcomeReceiptDigest',
    ],
    'product xHarness tool-policy outcome receipt',
  );
  if (
    record.schemaVersion !== 1 ||
    record.receiptKind !== 'xharness_tool_choice_policy_outcome'
  ) {
    throw new Error('unsupported product xHarness tool-policy outcome receipt');
  }
  if (typeof record.passed !== 'boolean') {
    throw new Error('product xHarness outcome passed must be a boolean');
  }
  const receipt = createProductXHarnessToolPolicyOutcomeReceipt({
    shippingReceiptDigest: readString(
      record.shippingReceiptDigest,
      'shippingReceiptDigest',
    ),
    candidateId: readString(record.candidateId, 'candidateId'),
    packetDigest: readString(record.packetDigest, 'packetDigest'),
    taskReferenceId: readString(record.taskReferenceId, 'taskReferenceId'),
    attemptReference: readString(record.attemptReference, 'attemptReference'),
    evidenceReferenceId: readString(
      record.evidenceReferenceId,
      'evidenceReferenceId',
    ),
    evidenceDigest: readString(record.evidenceDigest, 'evidenceDigest'),
    harnessSnapshotId: readString(
      record.harnessSnapshotId,
      'harnessSnapshotId',
    ),
    evaluationRuleId: readString(record.evaluationRuleId, 'evaluationRuleId'),
    evaluationDigest: readString(record.evaluationDigest, 'evaluationDigest'),
    passed: record.passed,
  });
  if (record.outcomeReceiptDigest !== receipt.outcomeReceiptDigest) {
    throw new Error(
      'product xHarness outcome receipt digest does not match its body',
    );
  }
  return receipt;
}

export async function publishProductXHarnessToolPolicyOutcomeReceipt(
  stateRoot: string,
  authority: ProductXHarnessToolPolicyOutcomePublication,
): Promise<{
  readonly receipt: ProductXHarnessToolPolicyOutcomeReceipt;
  readonly created: boolean;
}> {
  const shippingReceipt =
    await readActiveProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      authority.shippingReceiptDigest,
    );
  if (
    shippingReceipt.candidateHarnessSnapshotId !== authority.harnessSnapshotId
  ) {
    throw new Error(
      'product xHarness outcome attempt does not use the shipped harness snapshot',
    );
  }
  if (
    shippingReceipt.candidateId === null ||
    shippingReceipt.packetDigest === null
  ) {
    throw new Error(
      'product xHarness root-baseline rollback has no candidate outcome provenance',
    );
  }
  const receipt = createProductXHarnessToolPolicyOutcomeReceipt({
    ...authority,
    candidateId: shippingReceipt.candidateId,
    packetDigest: shippingReceipt.packetDigest,
  });
  const evaluationBytes = canonicalEvaluationBytes(
    authority.evaluation,
    receipt.evaluationDigest,
  );
  // 평가 본문을 receipt보다 먼저 남긴다. 중간에 끊기면 주인 없는 평가 파일이
  // 남을 뿐이지만, 순서가 반대면 아무것도 가리키지 않는 receipt가 남는다.
  await publishProductXHarnessImmutableBytes({
    targetPath: outcomeEvaluationPath(stateRoot, receipt.evaluationDigest),
    pendingDirectory: outcomePendingDirectory(stateRoot),
    bytes: evaluationBytes,
    conflictMessage: 'product xHarness outcome evaluation conflicts',
  });
  await publishProductXHarnessImmutableBytes({
    targetPath: outcomeReceiptPath(stateRoot, receipt.outcomeReceiptDigest),
    pendingDirectory: outcomePendingDirectory(stateRoot),
    bytes: Buffer.from(`${stableStringify(receipt)}\n`, 'utf8'),
    conflictMessage: 'product xHarness outcome receipt conflicts',
  });
  const claim = createOutcomeClaim(receipt);
  const claimPublication = await publishProductXHarnessImmutableBytes({
    targetPath: outcomeClaimPath(
      stateRoot,
      receipt.shippingReceiptDigest,
      receipt.attemptReference,
    ),
    pendingDirectory: outcomePendingDirectory(stateRoot),
    bytes: Buffer.from(`${stableStringify(claim)}\n`, 'utf8'),
    conflictMessage:
      'product xHarness shipping attempt already has a different outcome',
  });
  return Object.freeze({
    receipt,
    created: claimPublication.created,
  });
}

export async function readProductXHarnessToolPolicyOutcomeReceipt(
  stateRoot: string,
  outcomeReceiptDigest: string,
): Promise<ProductXHarnessToolPolicyOutcomeReceipt> {
  const digest = parseDigest(outcomeReceiptDigest, 'outcomeReceiptDigest');
  const parsed = await readRequiredJson(
    outcomeReceiptPath(stateRoot, digest),
    'product xHarness outcome receipt is unavailable',
  );
  const receipt = parseProductXHarnessToolPolicyOutcomeReceipt(parsed);
  if (receipt.outcomeReceiptDigest !== digest) {
    throw new Error(
      'product xHarness outcome receipt reference does not match',
    );
  }
  return receipt;
}

/**
 * receipt의 `evaluationDigest`가 가리키는 평가 본문을 되읽는다. 저장된 바이트가
 * 그 digest를 재현하지 못하면 실패한다 — 관측을 조용히 다른 것으로 바꿔치기할 수
 * 없다.
 */
export async function readProductXHarnessToolPolicyOutcomeEvaluation(
  stateRoot: string,
  evaluationDigest: string,
): Promise<unknown> {
  const digest = parseDigest(evaluationDigest, 'evaluationDigest');
  const evaluation = await readRequiredJson(
    outcomeEvaluationPath(stateRoot, digest),
    'product xHarness outcome evaluation is unavailable',
  );
  if (`sha256:${sha256StableJson(evaluation)}` !== digest) {
    throw new Error(
      'product xHarness outcome evaluation does not match its digest',
    );
  }
  return evaluation;
}

export async function listProductXHarnessToolPolicyOutcomeReceipts(
  stateRoot: string,
  shippingReceiptDigest: string,
): Promise<readonly ProductXHarnessToolPolicyOutcomeReceipt[]> {
  const shippingReceipt =
    await readActiveProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingReceiptDigest,
    );
  return await listOutcomeReceiptsForShippingReceipt(
    stateRoot,
    shippingReceipt,
  );
}

export async function listAllProductXHarnessToolPolicyOutcomeReceipts(
  stateRoot: string,
): Promise<readonly ProductXHarnessToolPolicyOutcomeReceipt[]> {
  const shippingReceipts =
    await listProductXHarnessToolPolicyShippingReceipts(stateRoot);
  const outcomes: ProductXHarnessToolPolicyOutcomeReceipt[] = [];
  for (const shippingReceipt of shippingReceipts) {
    outcomes.push(
      ...(await listOutcomeReceiptsForShippingReceipt(
        stateRoot,
        shippingReceipt,
      )),
    );
  }
  return Object.freeze(outcomes);
}

async function listOutcomeReceiptsForShippingReceipt(
  stateRoot: string,
  shippingReceipt: ProductXHarnessToolPolicyShippingReceipt,
): Promise<readonly ProductXHarnessToolPolicyOutcomeReceipt[]> {
  const claimsDirectory = outcomeClaimsDirectory(
    stateRoot,
    shippingReceipt.shippingReceiptDigest,
  );
  let entries;
  try {
    entries = await readdir(claimsDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return Object.freeze([]);
    }
    throw error;
  }
  const receipts: ProductXHarnessToolPolicyOutcomeReceipt[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const match = /^([0-9a-f]{64})\.json$/u.exec(entry.name);
    if (!entry.isFile() || match === null) {
      throw new Error(
        'product xHarness outcome claims directory contains an invalid entry',
      );
    }
    const attemptReference = match[1]!;
    const claim = parseOutcomeClaim(
      await readRequiredJson(
        join(claimsDirectory, entry.name),
        'product xHarness outcome claim is unavailable',
      ),
    );
    if (
      claim.shippingReceiptDigest !== shippingReceipt.shippingReceiptDigest ||
      claim.attemptReference !== attemptReference
    ) {
      throw new Error(
        'product xHarness outcome claim path does not match its body',
      );
    }
    const receipt = await readProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      claim.outcomeReceiptDigest,
    );
    if (
      receipt.shippingReceiptDigest !== claim.shippingReceiptDigest ||
      receipt.attemptReference !== claim.attemptReference
    ) {
      throw new Error(
        'product xHarness outcome claim does not match its receipt',
      );
    }
    receipts.push(receipt);
  }
  return Object.freeze(receipts);
}

function createOutcomeClaim(
  receipt: ProductXHarnessToolPolicyOutcomeReceipt,
): ProductXHarnessToolPolicyOutcomeClaim {
  return Object.freeze({
    schemaVersion: 1,
    shippingReceiptDigest: receipt.shippingReceiptDigest,
    attemptReference: receipt.attemptReference,
    outcomeReceiptDigest: receipt.outcomeReceiptDigest,
  });
}

function parseOutcomeClaim(
  value: unknown,
): ProductXHarnessToolPolicyOutcomeClaim {
  const record = assertExactPlainRecord(
    value,
    [
      'schemaVersion',
      'shippingReceiptDigest',
      'attemptReference',
      'outcomeReceiptDigest',
    ],
    'product xHarness tool-policy outcome claim',
  );
  if (record.schemaVersion !== 1) {
    throw new Error('unsupported product xHarness tool-policy outcome claim');
  }
  return Object.freeze({
    schemaVersion: 1,
    shippingReceiptDigest: parseDigest(
      record.shippingReceiptDigest,
      'shippingReceiptDigest',
    ),
    attemptReference: parseAttemptReference(record.attemptReference),
    outcomeReceiptDigest: parseDigest(
      record.outcomeReceiptDigest,
      'outcomeReceiptDigest',
    ),
  });
}

function outcomeRoot(stateRoot: string): string {
  return join(stateRoot, '.geulbat', 'xharness', 'tool-policy-outcomes');
}

function outcomeReceiptPath(
  stateRoot: string,
  outcomeReceiptDigest: `sha256:${string}`,
): string {
  return join(
    outcomeRoot(stateRoot),
    'receipts',
    `${outcomeReceiptDigest.slice('sha256:'.length)}.json`,
  );
}

function outcomeEvaluationPath(
  stateRoot: string,
  evaluationDigest: `sha256:${string}`,
): string {
  return join(
    outcomeRoot(stateRoot),
    'evaluations',
    `${evaluationDigest.slice('sha256:'.length)}.json`,
  );
}

function canonicalEvaluationBytes(
  evaluation: unknown,
  evaluationDigest: `sha256:${string}`,
): Buffer {
  if (evaluation === undefined) {
    throw new Error('product xHarness outcome evaluation is required');
  }
  if (`sha256:${sha256StableJson(evaluation)}` !== evaluationDigest) {
    throw new Error(
      'product xHarness outcome evaluation does not match its declared digest',
    );
  }
  return Buffer.from(`${stableStringify(evaluation)}\n`, 'utf8');
}

function outcomeClaimsDirectory(
  stateRoot: string,
  shippingReceiptDigest: `sha256:${string}`,
): string {
  return join(
    outcomeRoot(stateRoot),
    'by-shipping',
    shippingReceiptDigest.slice('sha256:'.length),
  );
}

function outcomeClaimPath(
  stateRoot: string,
  shippingReceiptDigest: `sha256:${string}`,
  attemptReference: string,
): string {
  return join(
    outcomeClaimsDirectory(stateRoot, shippingReceiptDigest),
    `${attemptReference}.json`,
  );
}

function outcomePendingDirectory(stateRoot: string): string {
  return join(outcomeRoot(stateRoot), '.pending');
}

function parseDigest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`product xHarness outcome ${label} is invalid`);
  }
  return value as `sha256:${string}`;
}

function parseAttemptReference(value: unknown): string {
  if (typeof value !== 'string' || !ATTEMPT_REFERENCE_PATTERN.test(value)) {
    throw new Error('product xHarness outcome attemptReference is invalid');
  }
  return value;
}

function parseOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_ID_PATTERN.test(value)) {
    throw new Error(`product xHarness outcome ${label} is invalid`);
  }
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`product xHarness outcome ${label} must be a string`);
  }
  return value;
}
