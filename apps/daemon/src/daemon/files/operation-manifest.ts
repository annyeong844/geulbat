import { createHash } from 'node:crypto';
import { isSameOrDescendantPath } from './normalize-path.js';

type OperationKind =
  | 'create_file'
  | 'create_directory'
  | 'delete'
  | 'rename'
  | 'move'
  | 'overwrite'
  | 'binary_replace'
  | 'generated_artifact_export'
  | 'derived_store_update';

type OperationActorKind =
  | 'human'
  | 'assistant'
  | 'subagent'
  | 'process_worker'
  | 'daemon';

type OperationTargetRole =
  | 'single'
  | 'source'
  | 'destination'
  | 'derived_store';

type OperationTargetExistence = 'must_exist' | 'must_not_exist' | 'may_exist';

type OperationAtomicity = 'atomic' | 'best_effort' | 'partial_allowed';

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
