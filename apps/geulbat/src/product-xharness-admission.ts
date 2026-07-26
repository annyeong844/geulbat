import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  sha256StableJson,
  stableStringify,
} from '@geulbat/content-identity/stable-json';
import {
  createAgentLoopImplementationAdmission,
  type AgentLoopImplementationAdmission,
} from '@geulbat/daemon/loop-implementation-admission';
import { AGENT_LOOP_PROMPT_COMPONENT_IDENTITY } from '@geulbat/daemon/prompt-component-identity';
import {
  createDurableRunEvidenceReader,
  type DurableRunEvidence,
  type DurableRunEvidenceReader,
} from '@geulbat/daemon/run-evidence';
import {
  createXHarnessFileRunStore,
  type XHarnessRunReader,
  type XHarnessRunStore,
  type XHarnessStoredRunAttempt,
} from '@geulbat/xharness/harness-run-store';
import {
  createHarnessConfigSnapshot,
  parseHarnessToolCapabilityPolicy,
  serializeHarnessToolCapabilityPolicy,
  type HarnessConfigSnapshot,
  type HarnessToolCapabilityPolicy,
} from '@geulbat/xharness/harness-snapshot';
import type { HarnessRunTrace } from '@geulbat/xharness/run-trace';

import {
  resolveProductXHarnessToolCapabilityPolicyAdmission,
  type ProductXHarnessToolCapabilityPolicyAdmissionResolution,
} from './product-xharness-tool-policy-promotion.js';
import { isErrorCode } from './product-xharness-cli-support.js';

const PRODUCT_HARNESS_ID = 'geulbat.live-run';
const PRODUCT_HARNESS_VERSION = '3';
const PRODUCT_EVIDENCE_SOURCE = 'geulbat.daemon.run-event-journal';

interface ProductXHarnessEvidenceLocatorV1 {
  readonly schemaVersion: 1;
  readonly evidenceReferenceId: string;
  readonly source: typeof PRODUCT_EVIDENCE_SOURCE;
  readonly threadId: string;
  readonly runId: string;
}

interface ProductXHarnessEvidenceLocatorV2 {
  readonly schemaVersion: 2;
  readonly evidenceReferenceId: string;
  readonly source: typeof PRODUCT_EVIDENCE_SOURCE;
  readonly threadId: string;
  readonly runId: string;
  readonly appliedShippingReceiptDigest: `sha256:${string}` | null;
}

type ProductXHarnessEvidenceLocator =
  | ProductXHarnessEvidenceLocatorV1
  | ProductXHarnessEvidenceLocatorV2;

type ProductXHarnessEvidenceLocatorV2Payload = Omit<
  ProductXHarnessEvidenceLocatorV2,
  'evidenceReferenceId'
>;

export interface ProductXHarnessAttemptEvidence {
  readonly attemptReference: string;
  readonly taskReferenceId: string;
  readonly evidenceReferenceId: string;
  readonly evidenceDigest: string;
  readonly appliedShippingReceiptDigest: `sha256:${string}` | null;
  readonly harnessSnapshot: HarnessConfigSnapshot;
  readonly portableTrace: HarnessRunTrace;
  readonly events: DurableRunEvidence['events'];
}

export interface ProductXHarnessAttemptEvidenceReader {
  listAttemptEvidence(input: {
    readonly harnessSnapshotIds: readonly string[];
  }): Promise<readonly ProductXHarnessAttemptEvidence[]>;
  readAttemptEvidence(
    attemptReference: string,
  ): Promise<ProductXHarnessAttemptEvidence | undefined>;
}

function createProductXHarnessRunStore(stateRoot: string): XHarnessRunStore {
  return createXHarnessFileRunStore(join(stateRoot, '.geulbat', 'xharness'));
}

function createProductEvidenceLocator(input: {
  readonly threadId: string;
  readonly runId: string;
  readonly appliedShippingReceiptDigest: `sha256:${string}` | null;
}): ProductXHarnessEvidenceLocator {
  const payload: ProductXHarnessEvidenceLocatorV2Payload = {
    schemaVersion: 2 as const,
    source: PRODUCT_EVIDENCE_SOURCE,
    threadId: input.threadId,
    runId: input.runId,
    appliedShippingReceiptDigest: input.appliedShippingReceiptDigest,
  };
  return Object.freeze({
    ...payload,
    evidenceReferenceId: `sha256:${sha256StableJson(payload)}`,
  });
}

function evidenceLocatorPath(
  stateRoot: string,
  evidenceReferenceId: string,
): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(evidenceReferenceId);
  if (match?.[1] === undefined) {
    throw new Error('product xHarness evidence reference is invalid');
  }
  return join(stateRoot, '.geulbat', 'xharness-evidence', `${match[1]}.json`);
}

async function publishProductEvidenceLocator(
  stateRoot: string,
  locator: ProductXHarnessEvidenceLocator,
): Promise<void> {
  const path = evidenceLocatorPath(stateRoot, locator.evidenceReferenceId);
  const pendingDirectory = join(
    stateRoot,
    '.geulbat',
    'xharness-evidence',
    '.pending',
  );
  const temporaryPath = join(pendingDirectory, `${randomUUID()}.pending`);
  const bytes = Buffer.from(`${stableStringify(locator)}\n`, 'utf8');
  await mkdir(pendingDirectory, { recursive: true });

  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporaryPath, path);
    } catch (error: unknown) {
      if (!isErrorCode(error, 'EEXIST')) {
        throw error;
      }
      const existingBytes = await readFile(path);
      if (!existingBytes.equals(bytes)) {
        throw new Error('product xHarness evidence locator conflicts');
      }
    }
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isErrorCode(error, 'ENOENT')) {
        throw error;
      }
    });
  }
}

function parseProductEvidenceLocator(
  value: unknown,
): ProductXHarnessEvidenceLocator {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('product xHarness evidence locator must be an object');
  }
  const record = value as Record<string, unknown>;
  const commonKeys = [
    'schemaVersion',
    'evidenceReferenceId',
    'source',
    'threadId',
    'runId',
  ];
  if (
    record.source !== PRODUCT_EVIDENCE_SOURCE ||
    typeof record.threadId !== 'string' ||
    typeof record.runId !== 'string'
  ) {
    throw new Error('product xHarness evidence locator is invalid');
  }
  let payload:
    | Omit<ProductXHarnessEvidenceLocatorV1, 'evidenceReferenceId'>
    | ProductXHarnessEvidenceLocatorV2Payload;
  if (
    record.schemaVersion === 1 &&
    Object.keys(record).length === commonKeys.length &&
    commonKeys.every((key) => Object.hasOwn(record, key))
  ) {
    payload = {
      schemaVersion: 1,
      source: PRODUCT_EVIDENCE_SOURCE,
      threadId: record.threadId,
      runId: record.runId,
    };
  } else {
    const expectedKeys = [...commonKeys, 'appliedShippingReceiptDigest'];
    const appliedShippingReceiptDigest = record.appliedShippingReceiptDigest;
    if (
      record.schemaVersion !== 2 ||
      Object.keys(record).length !== expectedKeys.length ||
      !expectedKeys.every((key) => Object.hasOwn(record, key)) ||
      (appliedShippingReceiptDigest !== null &&
        (typeof appliedShippingReceiptDigest !== 'string' ||
          !/^sha256:[0-9a-f]{64}$/u.test(appliedShippingReceiptDigest)))
    ) {
      throw new Error('product xHarness evidence locator is invalid');
    }
    payload = {
      schemaVersion: 2,
      source: PRODUCT_EVIDENCE_SOURCE,
      threadId: record.threadId,
      runId: record.runId,
      appliedShippingReceiptDigest: appliedShippingReceiptDigest as
        | `sha256:${string}`
        | null,
    };
  }
  const evidenceReferenceId = `sha256:${sha256StableJson(payload)}`;
  if (record.evidenceReferenceId !== evidenceReferenceId) {
    throw new Error('product xHarness evidence locator digest mismatch');
  }
  return Object.freeze({ ...payload, evidenceReferenceId });
}

async function readProductEvidenceLocator(
  stateRoot: string,
  evidenceReferenceId: string,
): Promise<ProductXHarnessEvidenceLocator> {
  const path = evidenceLocatorPath(stateRoot, evidenceReferenceId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) {
      throw new Error('product xHarness evidence locator is unavailable');
    }
    throw error;
  }
  const locator = parseProductEvidenceLocator(parsed);
  if (locator.evidenceReferenceId !== evidenceReferenceId) {
    throw new Error('product xHarness evidence reference does not match');
  }
  return locator;
}

export function createProductXHarnessAttemptReader(
  stateRoot: string,
): XHarnessRunReader {
  const store = createProductXHarnessRunStore(stateRoot);
  return Object.freeze({
    listAttemptAdmissions: () => store.listAttemptAdmissions(),
    readAttemptByReference: (attemptKeyHash: string) =>
      store.readAttemptByReference(attemptKeyHash),
  });
}

export function createProductXHarnessAttemptEvidenceReader(
  stateRoot: string,
  options: {
    readonly runEvidenceReader?: DurableRunEvidenceReader;
  } = {},
): ProductXHarnessAttemptEvidenceReader {
  const attemptReader = createProductXHarnessAttemptReader(stateRoot);
  const runEvidenceReader =
    options.runEvidenceReader ?? createDurableRunEvidenceReader({ stateRoot });

  async function readTerminalAttemptEvidence(
    attemptReference: string,
    attempt: XHarnessStoredRunAttempt,
  ): Promise<ProductXHarnessAttemptEvidence> {
    const evidenceReferenceId = attempt.admission.evidenceReferenceId;
    if (evidenceReferenceId === null) {
      throw new Error(
        'product xHarness attempt has no durable evidence reference',
      );
    }
    const locator = await readProductEvidenceLocator(
      stateRoot,
      evidenceReferenceId,
    );
    if (attempt.admission.traceIdentity.taskId !== locator.threadId) {
      throw new Error(
        'product xHarness evidence locator belongs to another task',
      );
    }
    if (attempt.trace === undefined) {
      throw new Error(
        'product xHarness terminal attempt has no portable trace evidence',
      );
    }
    const evidence = await runEvidenceReader.readRun({
      threadId: locator.threadId,
      runId: locator.runId,
    });
    if (evidence === undefined) {
      throw new Error('referenced product run evidence is unavailable');
    }
    if (
      evidence.threadId !== locator.threadId ||
      evidence.runId !== locator.runId
    ) {
      throw new Error('referenced product run evidence does not match');
    }
    return Object.freeze({
      attemptReference,
      taskReferenceId: `sha256:${sha256StableJson({
        schemaVersion: 1,
        taskId: attempt.admission.traceIdentity.taskId,
      })}`,
      evidenceReferenceId,
      evidenceDigest: evidence.evidenceDigest,
      appliedShippingReceiptDigest:
        locator.schemaVersion === 2
          ? locator.appliedShippingReceiptDigest
          : null,
      harnessSnapshot: attempt.admission.harnessSnapshot,
      portableTrace: attempt.trace.trace,
      events: evidence.events,
    });
  }

  return Object.freeze({
    async listAttemptEvidence(input: {
      readonly harnessSnapshotIds: readonly string[];
    }) {
      const harnessSnapshotIds = new Set(
        input.harnessSnapshotIds.map((harnessSnapshotId) => {
          if (!/^sha256:[0-9a-f]{64}$/u.test(harnessSnapshotId)) {
            throw new Error(
              'product xHarness evidence query requires canonical harness snapshot references',
            );
          }
          return harnessSnapshotId;
        }),
      );
      if (harnessSnapshotIds.size === 0) {
        throw new Error(
          'product xHarness evidence query requires at least one harness snapshot reference',
        );
      }
      const admissions = await attemptReader.listAttemptAdmissions();
      const evidence: ProductXHarnessAttemptEvidence[] = [];
      for (const admission of admissions) {
        if (
          !harnessSnapshotIds.has(admission.harnessSnapshot.harnessSnapshotId)
        ) {
          continue;
        }
        const attempt = await attemptReader.readAttemptByReference(
          admission.attemptKeyHash,
        );
        if (attempt === undefined) {
          throw new Error(
            'published product xHarness admission became unavailable',
          );
        }
        if (attempt.state !== 'terminal') {
          continue;
        }
        evidence.push(
          await readTerminalAttemptEvidence(admission.attemptKeyHash, attempt),
        );
      }
      return Object.freeze(evidence);
    },

    async readAttemptEvidence(attemptReference: string) {
      const attempt =
        await attemptReader.readAttemptByReference(attemptReference);
      if (attempt === undefined) {
        return undefined;
      }
      if (attempt.state !== 'terminal') {
        throw new Error(
          'product xHarness attempt is not terminal and cannot be evaluated',
        );
      }
      return await readTerminalAttemptEvidence(attemptReference, attempt);
    },
  });
}

export function createProductXHarnessAdmission(
  options: {
    readonly baseAdmission?: AgentLoopImplementationAdmission;
    readonly resolveToolCapabilityPolicyAdmission?: (input: {
      readonly stateRoot: string;
      readonly requestedToolCapabilityPolicy: HarnessToolCapabilityPolicy;
    }) => Promise<ProductXHarnessToolCapabilityPolicyAdmissionResolution>;
  } = {},
): AgentLoopImplementationAdmission {
  const baseAdmission =
    options.baseAdmission ?? createAgentLoopImplementationAdmission();
  const resolveToolCapabilityPolicyAdmission =
    options.resolveToolCapabilityPolicyAdmission ??
    resolveProductXHarnessToolCapabilityPolicyAdmission;

  return {
    async admitRun(input) {
      const selected = await baseAdmission.admitRun(input);
      if (!selected.ok) {
        return selected;
      }
      if (input.toolCapabilityPolicy === undefined) {
        return {
          ok: false,
          reason: 'tool_capability_policy_unavailable',
          implementationId: selected.identity.implementationId,
          contractVersion: selected.identity.contractVersion,
          supportedContractVersion: selected.identity.contractVersion,
          message: 'product xHarness requires one valid tool capability policy',
        };
      }
      let toolCapabilityPolicy: HarnessToolCapabilityPolicy;
      try {
        toolCapabilityPolicy = parseHarnessToolCapabilityPolicy(
          serializeHarnessToolCapabilityPolicy(input.toolCapabilityPolicy),
        );
      } catch {
        return {
          ok: false,
          reason: 'tool_capability_policy_unavailable',
          implementationId: selected.identity.implementationId,
          contractVersion: selected.identity.contractVersion,
          supportedContractVersion: selected.identity.contractVersion,
          message: 'product xHarness requires one valid tool capability policy',
        };
      }
      let appliedShippingReceiptDigest: `sha256:${string}` | null = null;
      if (input.requiredIdentity === undefined) {
        try {
          const resolution = await resolveToolCapabilityPolicyAdmission({
            stateRoot: input.stateRoot,
            requestedToolCapabilityPolicy: toolCapabilityPolicy,
          });
          toolCapabilityPolicy = parseHarnessToolCapabilityPolicy(
            serializeHarnessToolCapabilityPolicy(
              resolution.toolCapabilityPolicy,
            ),
          );
          if (
            resolution.appliedShippingReceiptDigest !== null &&
            !/^sha256:[0-9a-f]{64}$/u.test(
              resolution.appliedShippingReceiptDigest,
            )
          ) {
            throw new Error(
              'shipping policy resolution returned an invalid receipt reference',
            );
          }
          appliedShippingReceiptDigest =
            resolution.appliedShippingReceiptDigest;
        } catch (error: unknown) {
          return {
            ok: false,
            reason: 'tool_capability_policy_unavailable',
            implementationId: selected.identity.implementationId,
            contractVersion: selected.identity.contractVersion,
            supportedContractVersion: selected.identity.contractVersion,
            message: `product xHarness could not resolve the shipped tool policy: ${
              error instanceof Error
                ? error.message
                : 'unknown shipping state failure'
            }`,
          };
        }
      }
      const attemptId = `${input.runId}:${randomUUID()}`;
      const modelConfigId = `sha256:${sha256StableJson({
        schemaVersion: 1,
        ...input.modelConfiguration,
      })}`;
      const harnessSnapshot = createHarnessConfigSnapshot({
        harnessId: PRODUCT_HARNESS_ID,
        harnessVersion: PRODUCT_HARNESS_VERSION,
        config: {
          loop: {
            implementationId: selected.identity.implementationId,
            contractVersion: selected.identity.contractVersion,
          },
          prompt: { ...AGENT_LOOP_PROMPT_COMPONENT_IDENTITY },
          tools: {
            componentId: 'geulbat.daemon.tool-ports',
            componentVersion: '2',
            toolCapabilityPolicy,
          },
          control: {
            componentId: 'geulbat.daemon.loop-control',
            componentVersion: '1',
          },
          trace: {
            componentId: 'geulbat.agent-loop.portable-events',
            componentVersion: '2',
          },
        },
      });
      const evidenceLocator = createProductEvidenceLocator({
        threadId: input.threadId,
        runId: input.runId,
        appliedShippingReceiptDigest,
      });
      await publishProductEvidenceLocator(input.stateRoot, evidenceLocator);
      const store = createProductXHarnessRunStore(input.stateRoot);
      const durableAdmission = await store.admitRun(attemptId, {
        harnessSnapshot,
        traceIdentity: {
          taskId: input.threadId,
          attemptId,
          modelConfigId,
        },
        evidenceReferenceId: evidenceLocator.evidenceReferenceId,
        implementation: selected.implementation,
      });
      return Object.freeze({
        ok: true,
        identity: selected.identity,
        implementation: durableAdmission.implementation,
        toolCapabilityPolicy,
      });
    },
  };
}
