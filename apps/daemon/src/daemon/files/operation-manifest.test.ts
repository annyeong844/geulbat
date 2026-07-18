import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateOperationManifestPreconditions,
  evaluateRelocationPreconditions,
  evaluateOperationTargetPrecondition,
  operationCommitOutcomeFromPreconditionResult,
  prepareOperationManifest,
  type OperationManifestDraft,
} from './operation-manifest.js';

function baseDraft(): OperationManifestDraft {
  return {
    operationId: 'operation-1',
    manifestRevision: 'revision-1',
    operationKind: 'rename',
    authorityId: 'computer-file-scope',
    actor: { kind: 'assistant', runId: 'run-1' },
    targets: [
      {
        role: 'source',
        path: 'drafts/chapter1.md',
        canonicalTargetId: '/workspace/drafts/chapter1.md',
      },
      {
        role: 'destination',
        path: 'drafts/chapter-one.md',
        canonicalTargetId: '/workspace/drafts/chapter-one.md',
      },
    ],
    approval: { required: true, approvalId: 'approval-1' },
    lease: {
      leaseId: 'lease-1',
      fencingToken: 'fence-1',
      acquiredAt: '2026-05-03T00:00:00.000Z',
      expiresAt: '2026-05-03T00:01:00.000Z',
      ownerActorId: 'run-1',
    },
    atomicity: 'best_effort',
    createdAt: '2026-05-03T00:00:00.000Z',
  };
}

void test('prepareOperationManifest applies operation-specific target existence defaults', () => {
  const manifest = prepareOperationManifest(baseDraft());

  assert.equal(manifest.targets[0]?.existence, 'must_exist');
  assert.equal(manifest.targets[1]?.existence, 'must_not_exist');
});

void test('prepareOperationManifest hashes approval-relevant data without volatile approval or lease material', () => {
  const first = prepareOperationManifest(baseDraft());
  const second = prepareOperationManifest({
    ...baseDraft(),
    approval: {
      required: true,
      approvalId: 'approval-2',
      approvedManifestHash: 'stale-approved-hash',
    },
    lease: {
      leaseId: 'lease-2',
      fencingToken: 'fence-2',
      acquiredAt: '2026-05-03T00:10:00.000Z',
      expiresAt: '2026-05-03T00:11:00.000Z',
      ownerActorId: 'run-2',
    },
    createdAt: '2026-05-03T00:10:00.000Z',
  });
  const changedPrecondition = prepareOperationManifest({
    ...baseDraft(),
    targets: [
      {
        role: 'source',
        path: 'drafts/chapter1.md',
        canonicalTargetId: '/workspace/drafts/chapter1.md',
        expectedVersionToken: 'version-2',
      },
      {
        role: 'destination',
        path: 'drafts/chapter-one.md',
        canonicalTargetId: '/workspace/drafts/chapter-one.md',
      },
    ],
  });

  assert.equal(first.manifestHash, second.manifestHash);
  assert.notEqual(first.manifestHash, changedPrecondition.manifestHash);
});

void test('prepareOperationManifest snapshots mutable candidate-owned fields', () => {
  const draft: OperationManifestDraft = {
    ...baseDraft(),
    actor: { kind: 'assistant', runId: 'run-original' },
    approval: {
      required: true,
      reason: 'review before commit',
      approvalId: 'approval-original',
    },
    lease: {
      leaseId: 'lease-original',
      fencingToken: 'fence-original',
      acquiredAt: '2026-05-03T00:00:00.000Z',
      ownerActorId: 'run-original',
    },
    payloadDigest: {
      kind: 'patch',
      digest: 'sha256-original',
    },
  };

  const manifest = prepareOperationManifest(draft);
  draft.actor.runId = 'run-mutated';
  draft.approval.reason = 'mutated approval';
  draft.lease!.ownerActorId = 'run-mutated';
  draft.payloadDigest!.digest = 'sha256-mutated';

  assert.equal(manifest.actor.runId, 'run-original');
  assert.equal(manifest.approval.reason, 'review before commit');
  assert.equal(manifest.lease?.ownerActorId, 'run-original');
  assert.equal(manifest.payloadDigest?.digest, 'sha256-original');
});

void test('prepareOperationManifest rejects targets without a daemon-resolvable identity basis', () => {
  assert.throws(
    () =>
      prepareOperationManifest({
        ...baseDraft(),
        targets: [{ role: 'source' }],
      }),
    /target identity is required/,
  );
});

void test('evaluateOperationTargetPrecondition rejects existing must_not_exist destination', () => {
  const manifest = prepareOperationManifest(baseDraft());
  const destinationTarget = manifest.targets[1];

  assert.ok(destinationTarget);
  assert.deepEqual(
    evaluateOperationTargetPrecondition(destinationTarget, {
      canonicalTargetId: '/workspace/drafts/chapter-one.md',
      exists: true,
      kind: 'file',
    }),
    {
      ok: false,
      reasonCode: 'destination_already_exists',
    },
  );
});

void test('evaluateRelocationPreconditions rejects same canonical source and destination', () => {
  const manifest = prepareOperationManifest({
    ...baseDraft(),
    targets: [
      {
        role: 'source',
        path: 'drafts/chapter1.md',
        canonicalTargetId: '/workspace/drafts/chapter1.md',
      },
      {
        role: 'destination',
        path: 'drafts/./chapter1.md',
        canonicalTargetId: '/workspace/drafts/chapter1.md',
      },
    ],
  });
  const sourceTarget = manifest.targets[0];
  const destinationTarget = manifest.targets[1];

  assert.ok(sourceTarget);
  assert.ok(destinationTarget);
  assert.deepEqual(
    evaluateRelocationPreconditions(sourceTarget, destinationTarget, {
      canonicalTargetId: '/workspace/drafts/chapter1.md',
      exists: false,
    }),
    {
      ok: false,
      reasonCode: 'same_canonical_target',
    },
  );
});

void test('evaluateOperationManifestPreconditions rejects create destination that already exists', () => {
  const manifest = prepareOperationManifest({
    ...baseDraft(),
    operationKind: 'create_file',
    targets: [
      {
        role: 'destination',
        path: 'drafts/new-chapter.md',
        canonicalTargetId: '/workspace/drafts/new-chapter.md',
      },
    ],
  });

  assert.deepEqual(
    evaluateOperationManifestPreconditions(manifest, [
      {
        canonicalTargetId: '/workspace/drafts/new-chapter.md',
        exists: true,
        kind: 'file',
      },
    ]),
    {
      ok: false,
      reasonCode: 'destination_already_exists',
      targetIndex: 0,
    },
  );
});

void test('operationCommitOutcomeFromPreconditionResult maps precondition failure to rejected outcome', () => {
  assert.deepEqual(
    operationCommitOutcomeFromPreconditionResult({
      ok: false,
      reasonCode: 'destination_already_exists',
      targetIndex: 0,
    }),
    {
      status: 'rejected',
      reasonCode: 'destination_already_exists',
    },
  );
});
