import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  sha256StableJson,
  stableStringify,
} from '@geulbat/content-identity/stable-json';
import {
  parseHarnessToolCapabilityPolicy,
  type HarnessToolCapabilityPolicy,
} from '@geulbat/xharness/harness-snapshot';

import { publishProductXHarnessImmutableBytes } from './product-xharness-immutable-publication.js';
import {
  assertExactPlainRecord,
  assertPlainRecord,
  isErrorCode,
} from './product-xharness-cli-support.js';

const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export interface ProductXHarnessToolPolicyCriticShippingReceipt {
  readonly schemaVersion: 1;
  readonly receiptKind: 'xharness_tool_choice_policy';
  readonly candidateId: string;
  readonly packetDigest: `sha256:${string}`;
  readonly gateEvidenceDigest: `sha256:${string}`;
  readonly decisionDigest: `sha256:${string}`;
  readonly previousShippingReceiptDigest: `sha256:${string}` | null;
  readonly baselineHarnessSnapshotId: `sha256:${string}`;
  readonly candidateHarnessSnapshotId: `sha256:${string}`;
  readonly baselineToolCapabilityPolicyId: `sha256:${string}`;
  readonly candidateToolCapabilityPolicy: HarnessToolCapabilityPolicy;
  readonly shippingReceiptDigest: `sha256:${string}`;
}

export interface ProductXHarnessToolPolicyCrossRoundShippingReceipt {
  readonly schemaVersion: 2;
  readonly receiptKind: 'xharness_tool_choice_policy';
  readonly authorizationKind: 'xharness_tool_choice_cross_round';
  readonly transitionAction: 'select_winner' | 'rollback_to_predecessor';
  readonly authorityDigest: `sha256:${string}`;
  readonly scoreboardDigest: `sha256:${string}`;
  readonly sourceShippingReceiptDigest: `sha256:${string}` | null;
  readonly candidateId: string | null;
  readonly packetDigest: `sha256:${string}` | null;
  readonly previousShippingReceiptDigest: `sha256:${string}`;
  readonly baselineHarnessSnapshotId: `sha256:${string}`;
  readonly candidateHarnessSnapshotId: `sha256:${string}`;
  readonly baselineToolCapabilityPolicyId: `sha256:${string}`;
  readonly candidateToolCapabilityPolicy: HarnessToolCapabilityPolicy;
  readonly shippingReceiptDigest: `sha256:${string}`;
}

export type ProductXHarnessToolPolicyShippingReceipt =
  | ProductXHarnessToolPolicyCriticShippingReceipt
  | ProductXHarnessToolPolicyCrossRoundShippingReceipt;

export interface ProductXHarnessToolPolicyShippingAuthority {
  readonly candidateId: string;
  readonly packetDigest: string;
  readonly gateEvidenceDigest: string;
  readonly decisionDigest: string;
  readonly baselineHarnessSnapshotId: string;
  readonly candidateHarnessSnapshotId: string;
  readonly baselineToolCapabilityPolicyId: string;
  readonly candidateToolCapabilityPolicy: HarnessToolCapabilityPolicy;
}

export interface ProductXHarnessToolPolicyCrossRoundTransitionAuthority {
  readonly transitionAction: 'select_winner' | 'rollback_to_predecessor';
  readonly authorityDigest: string;
  readonly scoreboardDigest: string;
  readonly observedShippingHeadDigest: string;
  readonly sourceShippingReceiptDigest: string | null;
  readonly candidateId: string | null;
  readonly packetDigest: string | null;
  readonly candidateHarnessSnapshotId: string;
  readonly candidateToolCapabilityPolicy: HarnessToolCapabilityPolicy;
}

export interface ProductXHarnessToolCapabilityPolicyAdmissionResolution {
  readonly toolCapabilityPolicy: HarnessToolCapabilityPolicy;
  readonly appliedShippingReceiptDigest: `sha256:${string}` | null;
}

interface ProductXHarnessToolPolicySuccessor {
  readonly schemaVersion: 1;
  readonly previousShippingReceiptDigest: `sha256:${string}` | null;
  readonly shippingReceiptDigest: `sha256:${string}`;
}

export function createProductXHarnessToolPolicyShippingReceipt(
  input: ProductXHarnessToolPolicyShippingAuthority & {
    readonly previousShippingReceiptDigest: string | null;
  },
): ProductXHarnessToolPolicyCriticShippingReceipt {
  if (
    typeof input.candidateId !== 'string' ||
    !CANDIDATE_ID_PATTERN.test(input.candidateId)
  ) {
    throw new Error('product xHarness shipping candidateId is invalid');
  }
  const packetDigest = parseDigest(input.packetDigest, 'packetDigest');
  const gateEvidenceDigest = parseDigest(
    input.gateEvidenceDigest,
    'gateEvidenceDigest',
  );
  const decisionDigest = parseDigest(input.decisionDigest, 'decisionDigest');
  const previousShippingReceiptDigest =
    input.previousShippingReceiptDigest === null
      ? null
      : parseDigest(
          input.previousShippingReceiptDigest,
          'previousShippingReceiptDigest',
        );
  const baselineHarnessSnapshotId = parseDigest(
    input.baselineHarnessSnapshotId,
    'baselineHarnessSnapshotId',
  );
  const candidateHarnessSnapshotId = parseDigest(
    input.candidateHarnessSnapshotId,
    'candidateHarnessSnapshotId',
  );
  const baselineToolCapabilityPolicyId = parseDigest(
    input.baselineToolCapabilityPolicyId,
    'baselineToolCapabilityPolicyId',
  );
  const candidateToolCapabilityPolicy = parseHarnessToolCapabilityPolicy(
    JSON.stringify(input.candidateToolCapabilityPolicy),
  );
  if (candidateToolCapabilityPolicy.writeCallbackEnabled) {
    throw new Error('product xHarness shipping cannot enable write callbacks');
  }
  if (baselineHarnessSnapshotId === candidateHarnessSnapshotId) {
    throw new Error(
      'product xHarness shipping requires distinct harness snapshots',
    );
  }
  if (
    baselineToolCapabilityPolicyId ===
    candidateToolCapabilityPolicy.toolCapabilityPolicyId
  ) {
    throw new Error(
      'product xHarness shipping requires a changed tool capability policy',
    );
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    receiptKind: 'xharness_tool_choice_policy' as const,
    candidateId: input.candidateId,
    packetDigest,
    gateEvidenceDigest,
    decisionDigest,
    previousShippingReceiptDigest,
    baselineHarnessSnapshotId,
    candidateHarnessSnapshotId,
    baselineToolCapabilityPolicyId,
    candidateToolCapabilityPolicy,
  });
  const shippingReceiptDigest: `sha256:${string}` = `sha256:${sha256StableJson(body)}`;
  return Object.freeze({ ...body, shippingReceiptDigest });
}

export function createProductXHarnessToolPolicyCrossRoundShippingReceipt(
  input: ProductXHarnessToolPolicyCrossRoundTransitionAuthority & {
    readonly previousShippingReceiptDigest: string;
    readonly baselineHarnessSnapshotId: string;
    readonly baselineToolCapabilityPolicyId: string;
  },
): ProductXHarnessToolPolicyCrossRoundShippingReceipt {
  if (
    input.transitionAction !== 'select_winner' &&
    input.transitionAction !== 'rollback_to_predecessor'
  ) {
    throw new Error(
      'product xHarness cross-round transition action is invalid',
    );
  }
  const authorityDigest = parseDigest(input.authorityDigest, 'authorityDigest');
  const scoreboardDigest = parseDigest(
    input.scoreboardDigest,
    'scoreboardDigest',
  );
  const observedShippingHeadDigest = parseDigest(
    input.observedShippingHeadDigest,
    'observedShippingHeadDigest',
  );
  const previousShippingReceiptDigest = parseDigest(
    input.previousShippingReceiptDigest,
    'previousShippingReceiptDigest',
  );
  if (observedShippingHeadDigest !== previousShippingReceiptDigest) {
    throw new Error(
      'product xHarness cross-round transition does not bind its predecessor',
    );
  }
  const sourceShippingReceiptDigest =
    input.sourceShippingReceiptDigest === null
      ? null
      : parseDigest(
          input.sourceShippingReceiptDigest,
          'sourceShippingReceiptDigest',
        );
  const candidateId =
    input.candidateId === null
      ? null
      : parseCandidateId(input.candidateId, 'candidateId');
  const packetDigest =
    input.packetDigest === null
      ? null
      : parseDigest(input.packetDigest, 'packetDigest');
  if ((candidateId === null) !== (packetDigest === null)) {
    throw new Error(
      'product xHarness cross-round candidate and packet provenance must both be present or absent',
    );
  }
  const baselineHarnessSnapshotId = parseDigest(
    input.baselineHarnessSnapshotId,
    'baselineHarnessSnapshotId',
  );
  const candidateHarnessSnapshotId = parseDigest(
    input.candidateHarnessSnapshotId,
    'candidateHarnessSnapshotId',
  );
  const baselineToolCapabilityPolicyId = parseDigest(
    input.baselineToolCapabilityPolicyId,
    'baselineToolCapabilityPolicyId',
  );
  const candidateToolCapabilityPolicy = parseHarnessToolCapabilityPolicy(
    JSON.stringify(input.candidateToolCapabilityPolicy),
  );
  if (candidateToolCapabilityPolicy.writeCallbackEnabled) {
    throw new Error(
      'product xHarness cross-round transition cannot enable write callbacks',
    );
  }
  if (baselineHarnessSnapshotId === candidateHarnessSnapshotId) {
    throw new Error(
      'product xHarness cross-round transition requires distinct harness snapshots',
    );
  }
  if (
    baselineToolCapabilityPolicyId ===
    candidateToolCapabilityPolicy.toolCapabilityPolicyId
  ) {
    throw new Error(
      'product xHarness cross-round transition requires a changed tool capability policy',
    );
  }
  const body = Object.freeze({
    schemaVersion: 2 as const,
    receiptKind: 'xharness_tool_choice_policy' as const,
    authorizationKind: 'xharness_tool_choice_cross_round' as const,
    transitionAction: input.transitionAction,
    authorityDigest,
    scoreboardDigest,
    sourceShippingReceiptDigest,
    candidateId,
    packetDigest,
    previousShippingReceiptDigest,
    baselineHarnessSnapshotId,
    candidateHarnessSnapshotId,
    baselineToolCapabilityPolicyId,
    candidateToolCapabilityPolicy,
  });
  const shippingReceiptDigest: `sha256:${string}` = `sha256:${sha256StableJson(body)}`;
  return Object.freeze({ ...body, shippingReceiptDigest });
}

export function parseProductXHarnessToolPolicyShippingReceipt(
  value: unknown,
): ProductXHarnessToolPolicyShippingReceipt {
  const looseRecord = assertPlainRecord(
    value,
    'product xHarness tool-policy shipping receipt',
  );
  let receipt: ProductXHarnessToolPolicyShippingReceipt;
  if (looseRecord.schemaVersion === 1) {
    const record = assertExactPlainRecord(
      value,
      [
        'schemaVersion',
        'receiptKind',
        'candidateId',
        'packetDigest',
        'gateEvidenceDigest',
        'decisionDigest',
        'previousShippingReceiptDigest',
        'baselineHarnessSnapshotId',
        'candidateHarnessSnapshotId',
        'baselineToolCapabilityPolicyId',
        'candidateToolCapabilityPolicy',
        'shippingReceiptDigest',
      ],
      'product xHarness tool-policy shipping receipt',
    );
    if (record.receiptKind !== 'xharness_tool_choice_policy') {
      throw new Error(
        'unsupported product xHarness tool-policy shipping receipt',
      );
    }
    receipt = createProductXHarnessToolPolicyShippingReceipt({
      candidateId: readString(record.candidateId, 'candidateId'),
      packetDigest: readString(record.packetDigest, 'packetDigest'),
      gateEvidenceDigest: readString(
        record.gateEvidenceDigest,
        'gateEvidenceDigest',
      ),
      decisionDigest: readString(record.decisionDigest, 'decisionDigest'),
      previousShippingReceiptDigest:
        record.previousShippingReceiptDigest === null
          ? null
          : readString(
              record.previousShippingReceiptDigest,
              'previousShippingReceiptDigest',
            ),
      baselineHarnessSnapshotId: readString(
        record.baselineHarnessSnapshotId,
        'baselineHarnessSnapshotId',
      ),
      candidateHarnessSnapshotId: readString(
        record.candidateHarnessSnapshotId,
        'candidateHarnessSnapshotId',
      ),
      baselineToolCapabilityPolicyId: readString(
        record.baselineToolCapabilityPolicyId,
        'baselineToolCapabilityPolicyId',
      ),
      candidateToolCapabilityPolicy: parseHarnessToolCapabilityPolicy(
        JSON.stringify(record.candidateToolCapabilityPolicy),
      ),
    });
  } else if (looseRecord.schemaVersion === 2) {
    const record = assertExactPlainRecord(
      value,
      [
        'schemaVersion',
        'receiptKind',
        'authorizationKind',
        'transitionAction',
        'authorityDigest',
        'scoreboardDigest',
        'sourceShippingReceiptDigest',
        'candidateId',
        'packetDigest',
        'previousShippingReceiptDigest',
        'baselineHarnessSnapshotId',
        'candidateHarnessSnapshotId',
        'baselineToolCapabilityPolicyId',
        'candidateToolCapabilityPolicy',
        'shippingReceiptDigest',
      ],
      'product xHarness tool-policy shipping receipt',
    );
    if (
      record.receiptKind !== 'xharness_tool_choice_policy' ||
      record.authorizationKind !== 'xharness_tool_choice_cross_round'
    ) {
      throw new Error(
        'unsupported product xHarness tool-policy shipping receipt',
      );
    }
    receipt = createProductXHarnessToolPolicyCrossRoundShippingReceipt({
      transitionAction: readTransitionAction(record.transitionAction),
      authorityDigest: readString(record.authorityDigest, 'authorityDigest'),
      scoreboardDigest: readString(record.scoreboardDigest, 'scoreboardDigest'),
      observedShippingHeadDigest: readString(
        record.previousShippingReceiptDigest,
        'previousShippingReceiptDigest',
      ),
      sourceShippingReceiptDigest:
        record.sourceShippingReceiptDigest === null
          ? null
          : readString(
              record.sourceShippingReceiptDigest,
              'sourceShippingReceiptDigest',
            ),
      candidateId:
        record.candidateId === null
          ? null
          : readString(record.candidateId, 'candidateId'),
      packetDigest:
        record.packetDigest === null
          ? null
          : readString(record.packetDigest, 'packetDigest'),
      previousShippingReceiptDigest: readString(
        record.previousShippingReceiptDigest,
        'previousShippingReceiptDigest',
      ),
      baselineHarnessSnapshotId: readString(
        record.baselineHarnessSnapshotId,
        'baselineHarnessSnapshotId',
      ),
      candidateHarnessSnapshotId: readString(
        record.candidateHarnessSnapshotId,
        'candidateHarnessSnapshotId',
      ),
      baselineToolCapabilityPolicyId: readString(
        record.baselineToolCapabilityPolicyId,
        'baselineToolCapabilityPolicyId',
      ),
      candidateToolCapabilityPolicy: parseHarnessToolCapabilityPolicy(
        JSON.stringify(record.candidateToolCapabilityPolicy),
      ),
    });
  } else {
    throw new Error(
      'unsupported product xHarness tool-policy shipping receipt',
    );
  }
  if (looseRecord.shippingReceiptDigest !== receipt.shippingReceiptDigest) {
    throw new Error(
      'product xHarness shipping receipt digest does not match its body',
    );
  }
  return receipt;
}

export async function publishProductXHarnessToolPolicyShippingReceipt(
  stateRoot: string,
  authority: ProductXHarnessToolPolicyShippingAuthority,
): Promise<{
  readonly receipt: ProductXHarnessToolPolicyCriticShippingReceipt;
  readonly created: boolean;
}> {
  const chain = await readProductXHarnessToolPolicyShippingChain(stateRoot);
  const previous = chain.at(-1);
  if (
    previous?.schemaVersion === 1 &&
    previous.decisionDigest === authority.decisionDigest
  ) {
    const repeated = createProductXHarnessToolPolicyShippingReceipt({
      ...authority,
      previousShippingReceiptDigest: previous.previousShippingReceiptDigest,
    });
    if (repeated.shippingReceiptDigest !== previous.shippingReceiptDigest) {
      throw new Error(
        'product xHarness shipping decision conflicts with its existing receipt',
      );
    }
    return Object.freeze({ receipt: previous, created: false });
  }
  if (
    previous !== undefined &&
    previous.candidateToolCapabilityPolicy.toolCapabilityPolicyId !==
      authority.baselineToolCapabilityPolicyId
  ) {
    throw new Error(
      'product xHarness shipping baseline does not continue the active policy chain',
    );
  }
  const receipt = createProductXHarnessToolPolicyShippingReceipt({
    ...authority,
    previousShippingReceiptDigest: previous?.shippingReceiptDigest ?? null,
  });
  const created = await publishShippingReceipt(stateRoot, receipt);
  return Object.freeze({ receipt, created });
}

export async function publishProductXHarnessToolPolicyCrossRoundTransition(
  stateRoot: string,
  authority: ProductXHarnessToolPolicyCrossRoundTransitionAuthority,
): Promise<{
  readonly receipt: ProductXHarnessToolPolicyCrossRoundShippingReceipt;
  readonly created: boolean;
}> {
  const chain = await readProductXHarnessToolPolicyShippingChain(stateRoot);
  const previous = chain.at(-1);
  if (previous === undefined) {
    throw new Error(
      'product xHarness cross-round transition requires an active shipping receipt',
    );
  }
  const authorityDigest = parseDigest(
    authority.authorityDigest,
    'authorityDigest',
  );
  if (
    previous.schemaVersion === 2 &&
    previous.authorityDigest === authorityDigest
  ) {
    const preceding = chain.at(-2);
    if (preceding === undefined) {
      throw new Error(
        'product xHarness cross-round transition has no predecessor receipt',
      );
    }
    const repeated = createProductXHarnessToolPolicyCrossRoundShippingReceipt({
      ...authority,
      previousShippingReceiptDigest: preceding.shippingReceiptDigest,
      observedShippingHeadDigest: preceding.shippingReceiptDigest,
      baselineHarnessSnapshotId: preceding.candidateHarnessSnapshotId,
      baselineToolCapabilityPolicyId:
        preceding.candidateToolCapabilityPolicy.toolCapabilityPolicyId,
    });
    if (repeated.shippingReceiptDigest !== previous.shippingReceiptDigest) {
      throw new Error(
        'product xHarness cross-round authority conflicts with its existing transition',
      );
    }
    return Object.freeze({ receipt: previous, created: false });
  }
  const observedShippingHeadDigest = parseDigest(
    authority.observedShippingHeadDigest,
    'observedShippingHeadDigest',
  );
  if (previous.shippingReceiptDigest !== observedShippingHeadDigest) {
    throw new Error(
      'product xHarness cross-round authority is stale for the active shipping head',
    );
  }
  const source =
    authority.sourceShippingReceiptDigest === null
      ? undefined
      : chain.find(
          (receipt) =>
            receipt.shippingReceiptDigest ===
            parseDigest(
              authority.sourceShippingReceiptDigest,
              'sourceShippingReceiptDigest',
            ),
        );
  if (authority.sourceShippingReceiptDigest !== null && source === undefined) {
    throw new Error(
      'product xHarness cross-round target is not in the active shipping chain',
    );
  }
  const candidatePolicy = parseHarnessToolCapabilityPolicy(
    JSON.stringify(authority.candidateToolCapabilityPolicy),
  );
  const candidateSnapshotId = parseDigest(
    authority.candidateHarnessSnapshotId,
    'candidateHarnessSnapshotId',
  );
  if (source === undefined) {
    const root = chain[0]!;
    if (
      authority.candidateId !== null ||
      authority.packetDigest !== null ||
      root.baselineHarnessSnapshotId !== candidateSnapshotId ||
      root.baselineToolCapabilityPolicyId !==
        candidatePolicy.toolCapabilityPolicyId
    ) {
      throw new Error(
        'product xHarness cross-round root-baseline target provenance is invalid',
      );
    }
  } else {
    if (
      authority.candidateId !== source.candidateId ||
      authority.packetDigest !== source.packetDigest ||
      source.candidateHarnessSnapshotId !== candidateSnapshotId ||
      source.candidateToolCapabilityPolicy.toolCapabilityPolicyId !==
        candidatePolicy.toolCapabilityPolicyId
    ) {
      throw new Error(
        'product xHarness cross-round target does not match its source shipping receipt',
      );
    }
  }
  const receipt = createProductXHarnessToolPolicyCrossRoundShippingReceipt({
    ...authority,
    previousShippingReceiptDigest: previous.shippingReceiptDigest,
    baselineHarnessSnapshotId: previous.candidateHarnessSnapshotId,
    baselineToolCapabilityPolicyId:
      previous.candidateToolCapabilityPolicy.toolCapabilityPolicyId,
  });
  const created = await publishShippingReceipt(stateRoot, receipt);
  return Object.freeze({ receipt, created });
}

async function publishShippingReceipt(
  stateRoot: string,
  receipt: ProductXHarnessToolPolicyShippingReceipt,
): Promise<boolean> {
  const receiptBytes = Buffer.from(`${stableStringify(receipt)}\n`, 'utf8');
  await publishProductXHarnessImmutableBytes({
    targetPath: shippingReceiptPath(stateRoot, receipt.shippingReceiptDigest),
    pendingDirectory: shippingPendingDirectory(stateRoot),
    bytes: receiptBytes,
    conflictMessage: 'product xHarness shipping receipt conflicts',
  });
  const successor = createSuccessor(receipt);
  const successorPublication = await publishProductXHarnessImmutableBytes({
    targetPath: shippingSuccessorPath(
      stateRoot,
      receipt.previousShippingReceiptDigest,
    ),
    pendingDirectory: shippingPendingDirectory(stateRoot),
    bytes: Buffer.from(`${stableStringify(successor)}\n`, 'utf8'),
    conflictMessage:
      'product xHarness shipping predecessor already has a different successor',
  });
  return successorPublication.created;
}

export async function resolveProductXHarnessToolCapabilityPolicy(input: {
  readonly stateRoot: string;
  readonly requestedToolCapabilityPolicy: HarnessToolCapabilityPolicy;
}): Promise<HarnessToolCapabilityPolicy> {
  return (await resolveProductXHarnessToolCapabilityPolicyAdmission(input))
    .toolCapabilityPolicy;
}

export async function resolveProductXHarnessToolCapabilityPolicyAdmission(input: {
  readonly stateRoot: string;
  readonly requestedToolCapabilityPolicy: HarnessToolCapabilityPolicy;
}): Promise<ProductXHarnessToolCapabilityPolicyAdmissionResolution> {
  const requestedToolCapabilityPolicy = parseHarnessToolCapabilityPolicy(
    JSON.stringify(input.requestedToolCapabilityPolicy),
  );
  const chain = await readProductXHarnessToolPolicyShippingChain(
    input.stateRoot,
  );
  const first = chain[0];
  if (
    first === undefined ||
    first.baselineToolCapabilityPolicyId !==
      requestedToolCapabilityPolicy.toolCapabilityPolicyId
  ) {
    return Object.freeze({
      toolCapabilityPolicy: requestedToolCapabilityPolicy,
      appliedShippingReceiptDigest: null,
    });
  }
  let resolved = requestedToolCapabilityPolicy;
  let appliedShippingReceiptDigest: `sha256:${string}` | null = null;
  for (const receipt of chain) {
    if (
      receipt.baselineToolCapabilityPolicyId !== resolved.toolCapabilityPolicyId
    ) {
      throw new Error(
        'product xHarness shipping policy chain is discontinuous',
      );
    }
    resolved = receipt.candidateToolCapabilityPolicy;
    appliedShippingReceiptDigest = receipt.shippingReceiptDigest;
  }
  return Object.freeze({
    toolCapabilityPolicy: resolved,
    appliedShippingReceiptDigest,
  });
}

export async function readActiveProductXHarnessToolPolicyShippingReceipt(
  stateRoot: string,
  shippingReceiptDigest: string,
): Promise<ProductXHarnessToolPolicyShippingReceipt> {
  const expectedDigest = parseDigest(
    shippingReceiptDigest,
    'shippingReceiptDigest',
  );
  const chain = await readProductXHarnessToolPolicyShippingChain(stateRoot);
  const receipt = chain.find(
    (entry) => entry.shippingReceiptDigest === expectedDigest,
  );
  if (receipt === undefined) {
    throw new Error(
      'product xHarness shipping receipt is not in the active policy chain',
    );
  }
  return receipt;
}

export async function listProductXHarnessToolPolicyShippingReceipts(
  stateRoot: string,
): Promise<readonly ProductXHarnessToolPolicyShippingReceipt[]> {
  return readProductXHarnessToolPolicyShippingChain(stateRoot);
}

async function readProductXHarnessToolPolicyShippingChain(
  stateRoot: string,
): Promise<readonly ProductXHarnessToolPolicyShippingReceipt[]> {
  const chain: ProductXHarnessToolPolicyShippingReceipt[] = [];
  const visited = new Set<string>();
  let previousShippingReceiptDigest: `sha256:${string}` | null = null;
  while (true) {
    const successor = await readSuccessor(
      stateRoot,
      previousShippingReceiptDigest,
    );
    if (successor === undefined) {
      return Object.freeze(chain);
    }
    if (visited.has(successor.shippingReceiptDigest)) {
      throw new Error(
        'product xHarness shipping receipt chain contains a cycle',
      );
    }
    visited.add(successor.shippingReceiptDigest);
    const receipt = await readShippingReceipt(
      stateRoot,
      successor.shippingReceiptDigest,
    );
    if (
      receipt.previousShippingReceiptDigest !== previousShippingReceiptDigest
    ) {
      throw new Error(
        'product xHarness shipping successor does not match its receipt',
      );
    }
    const precedingReceipt = chain.at(-1);
    if (
      precedingReceipt !== undefined &&
      receipt.baselineToolCapabilityPolicyId !==
        precedingReceipt.candidateToolCapabilityPolicy.toolCapabilityPolicyId
    ) {
      throw new Error(
        'product xHarness shipping receipt chain is discontinuous',
      );
    }
    chain.push(receipt);
    previousShippingReceiptDigest = receipt.shippingReceiptDigest;
  }
}

function createSuccessor(
  receipt: ProductXHarnessToolPolicyShippingReceipt,
): ProductXHarnessToolPolicySuccessor {
  return Object.freeze({
    schemaVersion: 1,
    previousShippingReceiptDigest: receipt.previousShippingReceiptDigest,
    shippingReceiptDigest: receipt.shippingReceiptDigest,
  });
}

async function readSuccessor(
  stateRoot: string,
  previousShippingReceiptDigest: `sha256:${string}` | null,
): Promise<ProductXHarnessToolPolicySuccessor | undefined> {
  const value = await readOptionalJson(
    shippingSuccessorPath(stateRoot, previousShippingReceiptDigest),
  );
  if (value === undefined) {
    return undefined;
  }
  const record = assertExactPlainRecord(
    value,
    ['schemaVersion', 'previousShippingReceiptDigest', 'shippingReceiptDigest'],
    'product xHarness tool-policy shipping successor',
  );
  if (record.schemaVersion !== 1) {
    throw new Error('unsupported product xHarness shipping successor');
  }
  const parsedPrevious =
    record.previousShippingReceiptDigest === null
      ? null
      : parseDigest(
          record.previousShippingReceiptDigest,
          'previousShippingReceiptDigest',
        );
  if (parsedPrevious !== previousShippingReceiptDigest) {
    throw new Error(
      'product xHarness shipping successor path does not match its body',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    previousShippingReceiptDigest: parsedPrevious,
    shippingReceiptDigest: parseDigest(
      record.shippingReceiptDigest,
      'shippingReceiptDigest',
    ),
  });
}

async function readShippingReceipt(
  stateRoot: string,
  shippingReceiptDigest: `sha256:${string}`,
): Promise<ProductXHarnessToolPolicyShippingReceipt> {
  const value = await readOptionalJson(
    shippingReceiptPath(stateRoot, shippingReceiptDigest),
  );
  if (value === undefined) {
    throw new Error(
      'product xHarness shipping successor references a missing receipt',
    );
  }
  const receipt = parseProductXHarnessToolPolicyShippingReceipt(value);
  if (receipt.shippingReceiptDigest !== shippingReceiptDigest) {
    throw new Error(
      'product xHarness shipping receipt path does not match its body',
    );
  }
  return receipt;
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

function shippingRoot(stateRoot: string): string {
  return join(stateRoot, '.geulbat', 'xharness', 'tool-policy-shipping');
}

function shippingReceiptPath(
  stateRoot: string,
  shippingReceiptDigest: string,
): string {
  const digest = parseDigest(shippingReceiptDigest, 'shippingReceiptDigest');
  return join(
    shippingRoot(stateRoot),
    'receipts',
    `${digest.slice('sha256:'.length)}.json`,
  );
}

function shippingSuccessorPath(
  stateRoot: string,
  previousShippingReceiptDigest: string | null,
): string {
  const name =
    previousShippingReceiptDigest === null
      ? 'root'
      : parseDigest(
          previousShippingReceiptDigest,
          'previousShippingReceiptDigest',
        ).slice('sha256:'.length);
  return join(shippingRoot(stateRoot), 'successors', `${name}.json`);
}

function shippingPendingDirectory(stateRoot: string): string {
  return join(shippingRoot(stateRoot), '.pending');
}

function parseDigest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`product xHarness shipping ${label} is invalid`);
  }
  return value as `sha256:${string}`;
}

function parseCandidateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CANDIDATE_ID_PATTERN.test(value)) {
    throw new Error(`product xHarness shipping ${label} is invalid`);
  }
  return value;
}

function readTransitionAction(
  value: unknown,
): 'select_winner' | 'rollback_to_predecessor' {
  if (value !== 'select_winner' && value !== 'rollback_to_predecessor') {
    throw new Error(
      'product xHarness cross-round transition action is invalid',
    );
  }
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`product xHarness shipping ${label} must be a string`);
  }
  return value;
}
