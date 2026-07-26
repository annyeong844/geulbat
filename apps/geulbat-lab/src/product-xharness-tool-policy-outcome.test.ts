import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sha256StableJson } from '@geulbat/content-identity/stable-json';
import { createHarnessToolCapabilityPolicy } from '@geulbat/xharness/harness-snapshot';

import {
  listAllProductXHarnessToolPolicyOutcomeReceipts,
  listProductXHarnessToolPolicyOutcomeReceipts,
  parseProductXHarnessToolPolicyOutcomeReceipt,
  publishProductXHarnessToolPolicyOutcomeReceipt,
  readProductXHarnessToolPolicyOutcomeEvaluation,
  readProductXHarnessToolPolicyOutcomeReceipt,
  type ProductXHarnessToolPolicyOutcomePublication,
} from './product-xharness-tool-policy-outcome.js';
import {
  publishProductXHarnessToolPolicyShippingReceipt,
  type ProductXHarnessToolPolicyShippingAuthority,
} from '@geulbat/product/tool-policy-promotion';

const PACKET_DIGEST = `sha256:${'1'.repeat(64)}`;
const GATE_EVIDENCE_DIGEST = `sha256:${'2'.repeat(64)}`;
const DECISION_DIGEST = `sha256:${'3'.repeat(64)}`;
const BASELINE_SNAPSHOT_ID = `sha256:${'4'.repeat(64)}`;
const CANDIDATE_SNAPSHOT_ID = `sha256:${'5'.repeat(64)}`;
const TASK_REFERENCE_ID = `sha256:${'6'.repeat(64)}`;
const ATTEMPT_REFERENCE = '7'.repeat(64);
const EVIDENCE_REFERENCE_ID = `sha256:${'8'.repeat(64)}`;
const EVIDENCE_DIGEST = `sha256:${'9'.repeat(64)}`;
// 실제 평가 본문 모양을 따른다 — 이 오너가 지켜야 하는 것은 "digest가 실재하는
// 본문을 가리킨다"이므로, 합성 digest로는 그 계약을 시험할 수 없다.
function evaluationBody(passed = true) {
  return {
    schemaVersion: 3,
    ruleId: 'xharness_tool_choice_broad_filename_discovery_v1',
    attemptReference: ATTEMPT_REFERENCE,
    taskReferenceId: TASK_REFERENCE_ID,
    evidenceReferenceId: EVIDENCE_REFERENCE_ID,
    evidenceDigest: EVIDENCE_DIGEST,
    passed,
    observations: {
      toolCallCount: 3,
      measurements: {
        modelRoundCount: 2,
        toolCallCount: 3,
        inputTokens: 4096,
        cachedInputTokens: 3072,
        uncachedInputTokens: 1024,
        observedRunWallTimeMs: 8400,
      },
      violationCodes: [],
    },
  };
}

function evaluationDigestOf(evaluation: unknown): string {
  return `sha256:${sha256StableJson(evaluation)}`;
}

function toolPolicy(names: readonly string[]) {
  return createHarnessToolCapabilityPolicy({
    directRegistryNames: names,
    allowedRegistryNames: names,
    callbackRegistryNames: names,
    writeCallbackEnabled: false,
  });
}

function shippingAuthority(): ProductXHarnessToolPolicyShippingAuthority {
  const baseline = toolPolicy(['read_file']);
  const candidate = toolPolicy(['read_file', 'search_files']);
  return {
    candidateId: 'C-R1-01',
    packetDigest: PACKET_DIGEST,
    gateEvidenceDigest: GATE_EVIDENCE_DIGEST,
    decisionDigest: DECISION_DIGEST,
    baselineHarnessSnapshotId: BASELINE_SNAPSHOT_ID,
    candidateHarnessSnapshotId: CANDIDATE_SNAPSHOT_ID,
    baselineToolCapabilityPolicyId: baseline.toolCapabilityPolicyId,
    candidateToolCapabilityPolicy: candidate,
  };
}

function outcomeAuthority(
  shippingReceiptDigest: string,
  overrides: Partial<ProductXHarnessToolPolicyOutcomePublication> = {},
): ProductXHarnessToolPolicyOutcomePublication {
  const evaluation = overrides.evaluation ?? evaluationBody();
  return {
    shippingReceiptDigest,
    taskReferenceId: TASK_REFERENCE_ID,
    attemptReference: ATTEMPT_REFERENCE,
    evidenceReferenceId: EVIDENCE_REFERENCE_ID,
    evidenceDigest: EVIDENCE_DIGEST,
    harnessSnapshotId: CANDIDATE_SNAPSHOT_ID,
    evaluationRuleId: 'xharness_tool_choice_broad_filename_discovery_v1',
    evaluationDigest: evaluationDigestOf(evaluation),
    passed: true,
    ...overrides,
    evaluation,
  };
}

void test('publishes one idempotent next-round outcome for an active shipping receipt', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-tool-policy-outcome-'),
  );
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const shipping = await publishProductXHarnessToolPolicyShippingReceipt(
    stateRoot,
    shippingAuthority(),
  );
  const authority = outcomeAuthority(shipping.receipt.shippingReceiptDigest);

  const first = await publishProductXHarnessToolPolicyOutcomeReceipt(
    stateRoot,
    authority,
  );
  const repeated = await publishProductXHarnessToolPolicyOutcomeReceipt(
    stateRoot,
    authority,
  );

  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.receipt, first.receipt);
  // receipt가 버린 관측 — 라운드 수, 토큰, 벽시계 시간 — 을 그 digest로 되찾을 수
  // 있어야 한다. 이것이 안 되면 승격 이후 비용은 영영 복원 불가능하다.
  assert.deepEqual(
    await readProductXHarnessToolPolicyOutcomeEvaluation(
      stateRoot,
      first.receipt.evaluationDigest,
    ),
    evaluationBody(),
  );
  assert.deepEqual(
    parseProductXHarnessToolPolicyOutcomeReceipt(
      JSON.parse(JSON.stringify(first.receipt)),
    ),
    first.receipt,
  );
  assert.deepEqual(
    await readProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      first.receipt.outcomeReceiptDigest,
    ),
    first.receipt,
  );
  assert.deepEqual(
    await listProductXHarnessToolPolicyOutcomeReceipts(
      stateRoot,
      shipping.receipt.shippingReceiptDigest,
    ),
    [first.receipt],
  );
  assert.deepEqual(
    await listAllProductXHarnessToolPolicyOutcomeReceipts(stateRoot),
    [first.receipt],
  );
});

void test('rejects inactive shipping authority, snapshot drift, and a second outcome for one attempt', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-tool-policy-outcome-'),
  );
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const shipping = await publishProductXHarnessToolPolicyShippingReceipt(
    stateRoot,
    shippingAuthority(),
  );
  const authority = outcomeAuthority(shipping.receipt.shippingReceiptDigest);

  await assert.rejects(
    publishProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      outcomeAuthority(`sha256:${'b'.repeat(64)}`),
    ),
    /not in the active policy chain/u,
  );
  await assert.rejects(
    publishProductXHarnessToolPolicyOutcomeReceipt(stateRoot, {
      ...authority,
      harnessSnapshotId: `sha256:${'c'.repeat(64)}`,
    }),
    /does not use the shipped harness snapshot/u,
  );
  await publishProductXHarnessToolPolicyOutcomeReceipt(stateRoot, authority);
  await assert.rejects(
    publishProductXHarnessToolPolicyOutcomeReceipt(
      stateRoot,
      outcomeAuthority(shipping.receipt.shippingReceiptDigest, {
        evaluation: evaluationBody(false),
        passed: false,
      }),
    ),
    /already has a different outcome/u,
  );
  await assert.rejects(
    publishProductXHarnessToolPolicyOutcomeReceipt(stateRoot, {
      ...authority,
      evaluationDigest: `sha256:${'d'.repeat(64)}`,
    }),
    /evaluation does not match its declared digest/u,
  );
});

void test('admits only one concurrent outcome for the same shipping attempt', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-tool-policy-outcome-'),
  );
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const shipping = await publishProductXHarnessToolPolicyShippingReceipt(
    stateRoot,
    shippingAuthority(),
  );
  const firstAuthority = outcomeAuthority(
    shipping.receipt.shippingReceiptDigest,
  );
  const secondAuthority = outcomeAuthority(
    shipping.receipt.shippingReceiptDigest,
    { evaluation: evaluationBody(false), passed: false },
  );

  const settled = await Promise.allSettled([
    publishProductXHarnessToolPolicyOutcomeReceipt(stateRoot, firstAuthority),
    publishProductXHarnessToolPolicyOutcomeReceipt(stateRoot, secondAuthority),
  ]);
  assert.equal(
    settled.filter((entry) => entry.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    settled.filter((entry) => entry.status === 'rejected').length,
    1,
  );
  assert.equal(
    (
      await listProductXHarnessToolPolicyOutcomeReceipts(
        stateRoot,
        shipping.receipt.shippingReceiptDigest,
      )
    ).length,
    1,
  );
});

void test('fails closed when a claimed outcome receipt is tampered', async (t) => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-tool-policy-outcome-'),
  );
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const shipping = await publishProductXHarnessToolPolicyShippingReceipt(
    stateRoot,
    shippingAuthority(),
  );
  const published = await publishProductXHarnessToolPolicyOutcomeReceipt(
    stateRoot,
    outcomeAuthority(shipping.receipt.shippingReceiptDigest),
  );
  const receiptPath = join(
    stateRoot,
    '.geulbat',
    'xharness',
    'tool-policy-outcomes',
    'receipts',
    `${published.receipt.outcomeReceiptDigest.slice('sha256:'.length)}.json`,
  );
  await writeFile(
    receiptPath,
    `${JSON.stringify({
      ...published.receipt,
      passed: !published.receipt.passed,
    })}\n`,
  );

  await assert.rejects(
    listProductXHarnessToolPolicyOutcomeReceipts(
      stateRoot,
      shipping.receipt.shippingReceiptDigest,
    ),
    /digest does not match its body/u,
  );
});
