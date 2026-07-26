import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHarnessToolCapabilityPolicy } from '@geulbat/xharness/harness-snapshot';

import {
  createProductXHarnessToolPolicyShippingReceipt,
  parseProductXHarnessToolPolicyShippingReceipt,
  publishProductXHarnessToolPolicyShippingReceipt,
  readActiveProductXHarnessToolPolicyShippingReceipt,
  resolveProductXHarnessToolCapabilityPolicy,
  resolveProductXHarnessToolCapabilityPolicyAdmission,
  type ProductXHarnessToolPolicyShippingAuthority,
} from './product-xharness-tool-policy-promotion.js';

const PACKET_DIGEST = `sha256:${'1'.repeat(64)}`;
const GATE_EVIDENCE_DIGEST = `sha256:${'2'.repeat(64)}`;
const DECISION_DIGEST = `sha256:${'3'.repeat(64)}`;
const BASELINE_SNAPSHOT_ID = `sha256:${'4'.repeat(64)}`;
const CANDIDATE_SNAPSHOT_ID = `sha256:${'5'.repeat(64)}`;

function toolPolicy(names: readonly string[]) {
  return createHarnessToolCapabilityPolicy({
    directRegistryNames: names,
    allowedRegistryNames: names,
    callbackRegistryNames: names,
    writeCallbackEnabled: false,
  });
}

function shippingAuthority(
  baselineToolCapabilityPolicyId: string,
  candidateToolCapabilityPolicy: ReturnType<typeof toolPolicy>,
  overrides: Partial<ProductXHarnessToolPolicyShippingAuthority> = {},
): ProductXHarnessToolPolicyShippingAuthority {
  return {
    candidateId: 'C-R1-01',
    packetDigest: PACKET_DIGEST,
    gateEvidenceDigest: GATE_EVIDENCE_DIGEST,
    decisionDigest: DECISION_DIGEST,
    baselineHarnessSnapshotId: BASELINE_SNAPSHOT_ID,
    candidateHarnessSnapshotId: CANDIDATE_SNAPSHOT_ID,
    baselineToolCapabilityPolicyId,
    candidateToolCapabilityPolicy,
    ...overrides,
  };
}

void test('publishes one immutable policy transition and resolves only its exact baseline', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-tool-policy-'),
  );
  try {
    const baseline = toolPolicy(['read_file']);
    const candidate = toolPolicy(['read_file', 'search_files']);
    const authority = shippingAuthority(
      baseline.toolCapabilityPolicyId,
      candidate,
    );

    const first = await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      authority,
    );
    const repeated = await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      authority,
    );

    assert.equal(first.created, true);
    assert.equal(repeated.created, false);
    assert.deepEqual(repeated.receipt, first.receipt);
    assert.deepEqual(
      await resolveProductXHarnessToolCapabilityPolicyAdmission({
        stateRoot,
        requestedToolCapabilityPolicy: baseline,
      }),
      {
        toolCapabilityPolicy: candidate,
        appliedShippingReceiptDigest: first.receipt.shippingReceiptDigest,
      },
    );
    assert.deepEqual(
      await resolveProductXHarnessToolCapabilityPolicy({
        stateRoot,
        requestedToolCapabilityPolicy: baseline,
      }),
      candidate,
    );
    const unrelated = toolPolicy(['list_files']);
    assert.deepEqual(
      await resolveProductXHarnessToolCapabilityPolicyAdmission({
        stateRoot,
        requestedToolCapabilityPolicy: unrelated,
      }),
      {
        toolCapabilityPolicy: unrelated,
        appliedShippingReceiptDigest: null,
      },
    );
    assert.deepEqual(
      await resolveProductXHarnessToolCapabilityPolicy({
        stateRoot,
        requestedToolCapabilityPolicy: unrelated,
      }),
      unrelated,
    );
    assert.deepEqual(
      await readActiveProductXHarnessToolPolicyShippingReceipt(
        stateRoot,
        first.receipt.shippingReceiptDigest,
      ),
      first.receipt,
    );

    const receiptPath = join(
      stateRoot,
      '.geulbat',
      'xharness',
      'tool-policy-shipping',
      'receipts',
      `${first.receipt.shippingReceiptDigest.slice('sha256:'.length)}.json`,
    );
    assert.deepEqual(
      parseProductXHarnessToolPolicyShippingReceipt(
        JSON.parse(await readFile(receiptPath, 'utf8')),
      ),
      first.receipt,
    );
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

void test('chains later transitions and rejects a discontinuous baseline', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-tool-policy-chain-'),
  );
  try {
    const baseline = toolPolicy(['read_file']);
    const firstCandidate = toolPolicy(['read_file', 'search_files']);
    const secondCandidate = toolPolicy([
      'list_files',
      'read_file',
      'search_files',
    ]);
    const first = await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingAuthority(baseline.toolCapabilityPolicyId, firstCandidate),
    );
    const second = await publishProductXHarnessToolPolicyShippingReceipt(
      stateRoot,
      shippingAuthority(
        firstCandidate.toolCapabilityPolicyId,
        secondCandidate,
        {
          candidateId: 'C-R2-01',
          packetDigest: `sha256:${'6'.repeat(64)}`,
          gateEvidenceDigest: `sha256:${'7'.repeat(64)}`,
          decisionDigest: `sha256:${'8'.repeat(64)}`,
          baselineHarnessSnapshotId: first.receipt.candidateHarnessSnapshotId,
          candidateHarnessSnapshotId: `sha256:${'9'.repeat(64)}`,
        },
      ),
    );

    assert.equal(
      second.receipt.previousShippingReceiptDigest,
      first.receipt.shippingReceiptDigest,
    );
    assert.deepEqual(
      await resolveProductXHarnessToolCapabilityPolicy({
        stateRoot,
        requestedToolCapabilityPolicy: baseline,
      }),
      secondCandidate,
    );
    await assert.rejects(
      publishProductXHarnessToolPolicyShippingReceipt(
        stateRoot,
        shippingAuthority(
          baseline.toolCapabilityPolicyId,
          toolPolicy(['read_file', 'write_file']),
          {
            candidateId: 'C-R3-01',
            decisionDigest: `sha256:${'a'.repeat(64)}`,
          },
        ),
      ),
      /baseline does not continue/u,
    );
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

void test('admits only one concurrent successor for the same predecessor', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-xharness-tool-policy-race-'),
  );
  try {
    const baseline = toolPolicy(['read_file']);
    const results = await Promise.allSettled([
      publishProductXHarnessToolPolicyShippingReceipt(
        stateRoot,
        shippingAuthority(
          baseline.toolCapabilityPolicyId,
          toolPolicy(['read_file', 'search_files']),
        ),
      ),
      publishProductXHarnessToolPolicyShippingReceipt(
        stateRoot,
        shippingAuthority(
          baseline.toolCapabilityPolicyId,
          toolPolicy(['list_files', 'read_file']),
          {
            candidateId: 'C-R1-02',
            packetDigest: `sha256:${'b'.repeat(64)}`,
            gateEvidenceDigest: `sha256:${'c'.repeat(64)}`,
            decisionDigest: `sha256:${'d'.repeat(64)}`,
            candidateHarnessSnapshotId: `sha256:${'e'.repeat(64)}`,
          },
        ),
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
    const resolved = await resolveProductXHarnessToolCapabilityPolicy({
      stateRoot,
      requestedToolCapabilityPolicy: baseline,
    });
    assert.notEqual(
      resolved.toolCapabilityPolicyId,
      baseline.toolCapabilityPolicyId,
    );
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

void test('rejects tampered shipping receipts before they can enter a chain', () => {
  const baseline = toolPolicy(['read_file']);
  const candidate = toolPolicy(['read_file', 'search_files']);
  const receipt = createProductXHarnessToolPolicyShippingReceipt({
    ...shippingAuthority(baseline.toolCapabilityPolicyId, candidate),
    previousShippingReceiptDigest: null,
  });

  assert.throws(
    () =>
      parseProductXHarnessToolPolicyShippingReceipt({
        ...receipt,
        candidateId: 'C-FORGED',
      }),
    /digest does not match/u,
  );
  assert.throws(
    () =>
      createProductXHarnessToolPolicyShippingReceipt({
        ...shippingAuthority(
          baseline.toolCapabilityPolicyId,
          createHarnessToolCapabilityPolicy({
            directRegistryNames: ['read_file'],
            allowedRegistryNames: ['read_file'],
            callbackRegistryNames: ['read_file'],
            writeCallbackEnabled: true,
          }),
        ),
        previousShippingReceiptDigest: null,
      }),
    /cannot enable write callbacks/u,
  );
});
