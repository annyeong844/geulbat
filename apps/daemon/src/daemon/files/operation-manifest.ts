import { createHash } from 'node:crypto';
import { isJsonValue, isRecord, type JsonValue } from '../runtime-json.js';
import { isSameOrDescendantPath } from './normalize-path.js';

const OPERATION_KINDS = [
  'create_file',
  'create_directory',
  'delete',
  'rename',
  'move',
  'overwrite',
  'binary_replace',
  'generated_artifact_export',
  'derived_store_update',
] as const;
type OperationKind = (typeof OPERATION_KINDS)[number];

const OPERATION_ACTOR_KINDS = [
  'human',
  'assistant',
  'subagent',
  'process_worker',
  'daemon',
] as const;
type OperationActorKind = (typeof OPERATION_ACTOR_KINDS)[number];

const OPERATION_TARGET_ROLES = [
  'single',
  'source',
  'destination',
  'derived_store',
] as const;
type OperationTargetRole = (typeof OPERATION_TARGET_ROLES)[number];

const OPERATION_TARGET_EXISTENCE = [
  'must_exist',
  'must_not_exist',
  'may_exist',
] as const;
type OperationTargetExistence = (typeof OPERATION_TARGET_EXISTENCE)[number];

const OPERATION_ATOMICITIES = [
  'atomic',
  'best_effort',
  'partial_allowed',
] as const;
type OperationAtomicity = (typeof OPERATION_ATOMICITIES)[number];

export interface OperationActor {
  kind: OperationActorKind;
  subagentRole?: 'explorer' | 'worker';
  runId?: string;
  jobId?: string;
  attemptId?: string;
}

interface OperationApproval {
  required: boolean;
  reason?: string;
  approvalId?: string;
  approvedManifestHash?: string;
}

interface OperationLease {
  leaseId: string;
  fencingToken: string;
  acquiredAt: string;
  expiresAt?: string;
  ownerActorId: string;
}

interface OperationPayloadDigest {
  kind: 'patch' | 'content' | 'binary_artifact' | 'topology_candidate';
  digest: string;
}

type OperationTargetPreconditionReasonCode =
  | 'source_missing'
  | 'target_missing'
  | 'destination_already_exists'
  | 'target_already_exists'
  | 'kind_mismatch'
  | 'path_alias_violation';

type OperationRelocationPreconditionReasonCode =
  | 'same_canonical_target'
  | 'destination_inside_source'
  | OperationTargetPreconditionReasonCode;

type OperationCommitOutcomeStatus =
  | 'not_applicable'
  | 'pending'
  | 'committed'
  | 'conflicted'
  | 'rejected'
  | 'partially_applied'
  | 'failed';

type OperationCommitOutcomeReasonCode =
  | OperationRelocationPreconditionReasonCode
  | 'conflict_stale_write'
  | 'approval_denied'
  | 'lease_conflict'
  | 'atomicity_unsupported'
  | 'execution_error';

interface OperationCommitOutcome {
  status: OperationCommitOutcomeStatus;
  reasonCode?: OperationCommitOutcomeReasonCode;
  message?: string;
}

interface OperationTargetObservation {
  canonicalTargetId?: string;
  exists: boolean;
  kind?: 'file' | 'directory';
}

type OperationTargetPreconditionResult =
  | { ok: true }
  | { ok: false; reasonCode: OperationTargetPreconditionReasonCode };

type OperationManifestPreconditionResult =
  | { ok: true }
  | {
      ok: false;
      reasonCode: OperationTargetPreconditionReasonCode;
      targetIndex: number;
    };

type OperationRelocationPreconditionResult =
  | { ok: true }
  | { ok: false; reasonCode: OperationRelocationPreconditionReasonCode };

interface OperationTargetDraft {
  role: OperationTargetRole;
  path?: string;
  canonicalTargetId?: string;
  expectedIdentityToken?: string;
  expectedVersionToken?: string;
  existence?: OperationTargetExistence;
  expectedKind?: 'file' | 'directory';
  storeNamespace?: string;
  storeKey?: string;
  expectedStoreRevision?: string;
}

interface OperationTarget extends OperationTargetDraft {
  existence: OperationTargetExistence;
}

export interface OperationManifestDraft {
  operationId: string;
  manifestRevision: string;
  manifestHash?: string;
  operationKind: OperationKind;
  authorityId: string;
  actor: OperationActor;
  targets: OperationTargetDraft[];
  approval: OperationApproval;
  lease?: OperationLease;
  payloadDigest?: OperationPayloadDigest;
  atomicity: OperationAtomicity;
  createdAt: string;
}

export interface OperationManifest extends Omit<
  OperationManifestDraft,
  'manifestHash' | 'targets'
> {
  manifestHash: string;
  targets: OperationTarget[];
}

interface ManifestHashSnapshot {
  operationKind: OperationKind;
  authorityId: string;
  targets: ManifestHashTarget[];
  approval: {
    required: boolean;
    reason?: string;
  };
  atomicity: OperationAtomicity;
  leaseRequired: boolean;
  payloadDigest?: OperationPayloadDigest;
}

interface ManifestHashTarget {
  role: OperationTargetRole;
  path?: string;
  canonicalTargetId?: string;
  expectedIdentityToken?: string;
  expectedVersionToken?: string;
  existence: OperationTargetExistence;
  expectedKind?: 'file' | 'directory';
  storeNamespace?: string;
  storeKey?: string;
  expectedStoreRevision?: string;
}

export function prepareOperationManifest(
  draft: OperationManifestDraft,
): OperationManifest {
  const targets = draft.targets.map((target) =>
    prepareOperationTarget(draft.operationKind, target),
  );
  const hashSnapshot = buildManifestHashSnapshot(draft, targets);

  return {
    operationId: draft.operationId,
    manifestRevision: draft.manifestRevision,
    manifestHash: hashManifestSnapshot(hashSnapshot),
    operationKind: draft.operationKind,
    authorityId: draft.authorityId,
    actor: { ...draft.actor },
    targets,
    approval: { ...draft.approval },
    ...(draft.lease ? { lease: { ...draft.lease } } : {}),
    ...(draft.payloadDigest
      ? { payloadDigest: { ...draft.payloadDigest } }
      : {}),
    atomicity: draft.atomicity,
    createdAt: draft.createdAt,
  };
}

export function operationManifestToJsonValue(
  manifest: OperationManifest,
): JsonValue {
  const snapshot: unknown = JSON.parse(JSON.stringify(manifest));
  if (!isJsonValue(snapshot)) {
    throw new Error('operation manifest is not JSON-serializable');
  }
  return snapshot;
}

export function parseOperationManifest(
  value: unknown,
): OperationManifest | null {
  if (
    !isRecord(value) ||
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    typeof value.manifestRevision !== 'string' ||
    value.manifestRevision.length === 0 ||
    typeof value.manifestHash !== 'string' ||
    !isStringMember(value.operationKind, OPERATION_KINDS) ||
    typeof value.authorityId !== 'string' ||
    value.authorityId.length === 0 ||
    !isStringMember(value.atomicity, OPERATION_ATOMICITIES) ||
    typeof value.createdAt !== 'string'
  ) {
    return null;
  }
  const actor = parseOperationActor(value.actor);
  const targets = parseOperationTargets(value.targets);
  const approval = parseOperationApproval(value.approval);
  const lease =
    value.lease === undefined ? undefined : parseOperationLease(value.lease);
  const payloadDigest =
    value.payloadDigest === undefined
      ? undefined
      : parseOperationPayloadDigest(value.payloadDigest);
  if (
    actor === null ||
    targets === null ||
    approval === null ||
    lease === null ||
    payloadDigest === null
  ) {
    return null;
  }
  try {
    const prepared = prepareOperationManifest({
      operationId: value.operationId,
      manifestRevision: value.manifestRevision,
      operationKind: value.operationKind,
      authorityId: value.authorityId,
      actor,
      targets,
      approval,
      ...(lease === undefined ? {} : { lease }),
      ...(payloadDigest === undefined ? {} : { payloadDigest }),
      atomicity: value.atomicity,
      createdAt: value.createdAt,
    });
    return prepared.manifestHash === value.manifestHash ? prepared : null;
  } catch {
    return null;
  }
}

export function evaluateOperationTargetPrecondition(
  target: OperationTarget,
  observation: OperationTargetObservation,
): OperationTargetPreconditionResult {
  if (
    target.canonicalTargetId !== undefined &&
    observation.canonicalTargetId !== undefined &&
    target.canonicalTargetId !== observation.canonicalTargetId
  ) {
    return { ok: false, reasonCode: 'path_alias_violation' };
  }

  if (target.existence === 'must_exist' && !observation.exists) {
    return {
      ok: false,
      reasonCode:
        target.role === 'source' ? 'source_missing' : 'target_missing',
    };
  }

  if (target.existence === 'must_not_exist' && observation.exists) {
    return {
      ok: false,
      reasonCode:
        target.role === 'destination'
          ? 'destination_already_exists'
          : 'target_already_exists',
    };
  }

  if (
    target.expectedKind !== undefined &&
    observation.exists &&
    observation.kind !== target.expectedKind
  ) {
    return { ok: false, reasonCode: 'kind_mismatch' };
  }

  return { ok: true };
}

export function evaluateOperationManifestPreconditions(
  manifest: OperationManifest,
  observations: OperationTargetObservation[],
): OperationManifestPreconditionResult {
  for (let index = 0; index < manifest.targets.length; index += 1) {
    const target = manifest.targets[index];
    const observation = observations[index];
    if (target === undefined || observation === undefined) {
      throw new Error('target observation is required for manifest target.');
    }

    const result = evaluateOperationTargetPrecondition(target, observation);
    if (result.ok === false) {
      return {
        ok: false,
        reasonCode: result.reasonCode,
        targetIndex: index,
      };
    }
  }

  return { ok: true };
}

export function evaluateRelocationPreconditions(
  sourceTarget: OperationTarget,
  destinationTarget: OperationTarget,
  destinationObservation: OperationTargetObservation,
): OperationRelocationPreconditionResult {
  if (
    sourceTarget.canonicalTargetId !== undefined &&
    sourceTarget.canonicalTargetId === destinationTarget.canonicalTargetId
  ) {
    return { ok: false, reasonCode: 'same_canonical_target' };
  }

  if (
    sourceTarget.expectedKind !== 'file' &&
    sourceTarget.canonicalTargetId !== undefined &&
    destinationTarget.canonicalTargetId !== undefined &&
    isSameOrDescendantPath(
      sourceTarget.canonicalTargetId,
      destinationTarget.canonicalTargetId,
    )
  ) {
    return { ok: false, reasonCode: 'destination_inside_source' };
  }

  return evaluateOperationTargetPrecondition(
    destinationTarget,
    destinationObservation,
  );
}

export function operationCommitOutcomeFromPreconditionResult(
  result:
    | OperationManifestPreconditionResult
    | OperationRelocationPreconditionResult,
): OperationCommitOutcome {
  if (result.ok) {
    return { status: 'pending' };
  }

  return {
    status: 'rejected',
    reasonCode: result.reasonCode,
  };
}

function prepareOperationTarget(
  operationKind: OperationKind,
  target: OperationTargetDraft,
): OperationTarget {
  assertTargetHasIdentityBasis(target);
  return {
    ...target,
    existence:
      target.existence ?? defaultTargetExistence(operationKind, target.role),
  };
}

function parseOperationActor(value: unknown): OperationActor | null {
  if (
    !isRecord(value) ||
    !isStringMember(value.kind, OPERATION_ACTOR_KINDS) ||
    (value.subagentRole !== undefined &&
      value.subagentRole !== 'explorer' &&
      value.subagentRole !== 'worker') ||
    !hasOptionalString(value, 'runId') ||
    !hasOptionalString(value, 'jobId') ||
    !hasOptionalString(value, 'attemptId')
  ) {
    return null;
  }
  return {
    kind: value.kind,
    ...(value.subagentRole === undefined
      ? {}
      : { subagentRole: value.subagentRole }),
    ...(typeof value.runId !== 'string' ? {} : { runId: value.runId }),
    ...(typeof value.jobId !== 'string' ? {} : { jobId: value.jobId }),
    ...(typeof value.attemptId !== 'string'
      ? {}
      : { attemptId: value.attemptId }),
  };
}

function parseOperationTargets(value: unknown): OperationTargetDraft[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const targets: OperationTargetDraft[] = [];
  for (const candidate of value) {
    const target = parseOperationTarget(candidate);
    if (target === null) {
      return null;
    }
    targets.push(target);
  }
  return targets;
}

function parseOperationTarget(value: unknown): OperationTargetDraft | null {
  if (
    !isRecord(value) ||
    !isStringMember(value.role, OPERATION_TARGET_ROLES) ||
    !hasOptionalString(value, 'path') ||
    !hasOptionalString(value, 'canonicalTargetId') ||
    !hasOptionalString(value, 'expectedIdentityToken') ||
    !hasOptionalString(value, 'expectedVersionToken') ||
    (value.existence !== undefined &&
      !isStringMember(value.existence, OPERATION_TARGET_EXISTENCE)) ||
    (value.expectedKind !== undefined &&
      value.expectedKind !== 'file' &&
      value.expectedKind !== 'directory') ||
    !hasOptionalString(value, 'storeNamespace') ||
    !hasOptionalString(value, 'storeKey') ||
    !hasOptionalString(value, 'expectedStoreRevision')
  ) {
    return null;
  }
  return {
    role: value.role,
    ...(typeof value.path !== 'string' ? {} : { path: value.path }),
    ...(typeof value.canonicalTargetId !== 'string'
      ? {}
      : { canonicalTargetId: value.canonicalTargetId }),
    ...(typeof value.expectedIdentityToken !== 'string'
      ? {}
      : { expectedIdentityToken: value.expectedIdentityToken }),
    ...(typeof value.expectedVersionToken !== 'string'
      ? {}
      : { expectedVersionToken: value.expectedVersionToken }),
    ...(value.existence === undefined ? {} : { existence: value.existence }),
    ...(value.expectedKind === undefined
      ? {}
      : { expectedKind: value.expectedKind }),
    ...(typeof value.storeNamespace !== 'string'
      ? {}
      : { storeNamespace: value.storeNamespace }),
    ...(typeof value.storeKey !== 'string' ? {} : { storeKey: value.storeKey }),
    ...(typeof value.expectedStoreRevision !== 'string'
      ? {}
      : { expectedStoreRevision: value.expectedStoreRevision }),
  };
}

function parseOperationApproval(value: unknown): OperationApproval | null {
  if (
    !isRecord(value) ||
    typeof value.required !== 'boolean' ||
    !hasOptionalString(value, 'reason') ||
    !hasOptionalString(value, 'approvalId') ||
    !hasOptionalString(value, 'approvedManifestHash')
  ) {
    return null;
  }
  return {
    required: value.required,
    ...(typeof value.reason !== 'string' ? {} : { reason: value.reason }),
    ...(typeof value.approvalId !== 'string'
      ? {}
      : { approvalId: value.approvalId }),
    ...(typeof value.approvedManifestHash !== 'string'
      ? {}
      : { approvedManifestHash: value.approvedManifestHash }),
  };
}

function parseOperationLease(value: unknown): OperationLease | null {
  if (
    !isRecord(value) ||
    typeof value.leaseId !== 'string' ||
    typeof value.fencingToken !== 'string' ||
    typeof value.acquiredAt !== 'string' ||
    typeof value.ownerActorId !== 'string' ||
    !hasOptionalString(value, 'expiresAt')
  ) {
    return null;
  }
  return {
    leaseId: value.leaseId,
    fencingToken: value.fencingToken,
    acquiredAt: value.acquiredAt,
    ...(typeof value.expiresAt !== 'string'
      ? {}
      : { expiresAt: value.expiresAt }),
    ownerActorId: value.ownerActorId,
  };
}

function parseOperationPayloadDigest(
  value: unknown,
): OperationPayloadDigest | null {
  if (
    !isRecord(value) ||
    (value.kind !== 'patch' &&
      value.kind !== 'content' &&
      value.kind !== 'binary_artifact' &&
      value.kind !== 'topology_candidate') ||
    typeof value.digest !== 'string'
  ) {
    return null;
  }
  return { kind: value.kind, digest: value.digest };
}

function hasOptionalString(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return value[key] === undefined || typeof value[key] === 'string';
}

function isStringMember<T extends string>(
  value: unknown,
  members: readonly T[],
): value is T {
  return (
    typeof value === 'string' &&
    members.some((candidate) => candidate === value)
  );
}

function assertTargetHasIdentityBasis(target: OperationTargetDraft): void {
  if (target.role === 'derived_store') {
    if (
      target.canonicalTargetId !== undefined ||
      (target.storeNamespace !== undefined && target.storeKey !== undefined)
    ) {
      return;
    }
    throw new Error('target identity is required for derived_store target.');
  }

  if (target.path !== undefined || target.canonicalTargetId !== undefined) {
    return;
  }

  throw new Error('target identity is required for file operation target.');
}

function defaultTargetExistence(
  operationKind: OperationKind,
  role: OperationTargetRole,
): OperationTargetExistence {
  if (role === 'source') {
    return 'must_exist';
  }

  if (role === 'destination') {
    return 'must_not_exist';
  }

  if (role === 'single') {
    return operationKind === 'create_file' ||
      operationKind === 'create_directory' ||
      operationKind === 'generated_artifact_export'
      ? 'must_not_exist'
      : 'must_exist';
  }

  return 'must_exist';
}

function buildManifestHashSnapshot(
  draft: OperationManifestDraft,
  targets: OperationTarget[],
): ManifestHashSnapshot {
  return {
    operationKind: draft.operationKind,
    authorityId: draft.authorityId,
    targets: targets.map((target) => ({
      role: target.role,
      ...(target.path !== undefined ? { path: target.path } : {}),
      ...(target.canonicalTargetId !== undefined
        ? { canonicalTargetId: target.canonicalTargetId }
        : {}),
      ...(target.expectedIdentityToken !== undefined
        ? { expectedIdentityToken: target.expectedIdentityToken }
        : {}),
      ...(target.expectedVersionToken !== undefined
        ? { expectedVersionToken: target.expectedVersionToken }
        : {}),
      existence: target.existence,
      ...(target.expectedKind !== undefined
        ? { expectedKind: target.expectedKind }
        : {}),
      ...(target.storeNamespace !== undefined
        ? { storeNamespace: target.storeNamespace }
        : {}),
      ...(target.storeKey !== undefined ? { storeKey: target.storeKey } : {}),
      ...(target.expectedStoreRevision !== undefined
        ? { expectedStoreRevision: target.expectedStoreRevision }
        : {}),
    })),
    approval: {
      required: draft.approval.required,
      ...(draft.approval.reason !== undefined
        ? { reason: draft.approval.reason }
        : {}),
    },
    atomicity: draft.atomicity,
    leaseRequired: draft.lease !== undefined,
    ...(draft.payloadDigest ? { payloadDigest: draft.payloadDigest } : {}),
  };
}

function hashManifestSnapshot(snapshot: ManifestHashSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
