import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isGitReviewFileRequest,
  isGitReviewFileResult,
  isGitReviewReleaseRequest,
  isGitReviewReleaseResult,
  isGitReviewSummaryRequest,
  isGitReviewSummaryResult,
} from './git-review.js';

const TIMESTAMP = '2026-07-29T00:00:00.000Z';
const HEAD_OID = 'a'.repeat(40);

const CHANGED_SUMMARY = {
  kind: 'changed',
  observationId: 'summary-observation-1',
  repositoryRoot: '/workspace/repository',
  branch: {
    name: 'main',
    detached: false,
    headOid: HEAD_OID,
  },
  totals: {
    fileCount: 1,
    additions: null,
    deletions: null,
    lineStatsComplete: false,
  },
  files: {
    items: [
      {
        fileId: 'file-1',
        displayPath: 'src/c.ts',
        layers: [
          {
            layerId: 'layer-staged-1',
            comparison: 'staged',
            state: 'renamed',
            beforeDisplayPath: 'src/a.ts',
            afterDisplayPath: 'src/b.ts',
            beforeContentKind: 'text',
            afterContentKind: 'text',
          },
          {
            layerId: 'layer-unstaged-1',
            comparison: 'unstaged',
            state: 'renamed',
            beforeDisplayPath: 'src/b.ts',
            afterDisplayPath: 'src/c.ts',
            beforeContentKind: 'text',
            afterContentKind: 'text',
          },
        ],
        staged: true,
        unstaged: true,
      },
    ],
    nextCursor: null,
  },
  observedAt: TIMESTAMP,
};

const READY_FILE = {
  kind: 'ready',
  observationId: 'summary-observation-1',
  fileObservationId: 'file-observation-1',
  fileId: 'file-1',
  sections: [
    {
      sectionId: 'section-staged-1',
      layerId: 'layer-staged-1',
      comparison: 'staged',
      projection: 'text',
      metadataReason: null,
    },
    {
      sectionId: 'section-unstaged-1',
      layerId: 'layer-unstaged-1',
      comparison: 'unstaged',
      projection: 'metadata_only',
      metadataReason: 'binary',
    },
  ],
  rows: {
    items: [
      {
        sectionId: 'section-staged-1',
        kind: 'hunk',
        oldLine: null,
        newLine: null,
        content: '@@ -1 +1 @@',
      },
      {
        sectionId: 'section-staged-1',
        kind: 'deletion',
        oldLine: 1,
        newLine: null,
        content: 'before',
      },
      {
        sectionId: 'section-staged-1',
        kind: 'addition',
        oldLine: null,
        newLine: 1,
        content: 'after',
      },
      {
        sectionId: 'section-unstaged-1',
        kind: 'metadata',
        oldLine: null,
        newLine: null,
        content: 'Binary content',
      },
    ],
    nextCursor: 'file-cursor-2',
  },
  capturedAt: TIMESTAMP,
};

void test('Git review request guards accept each exact start, continue, and release shape', () => {
  assert.equal(
    isGitReviewSummaryRequest({
      kind: 'start',
      workingDirectory: '/workspace/repository',
    }),
    true,
  );
  assert.equal(
    isGitReviewSummaryRequest({
      kind: 'start',
      workingDirectory: '',
    }),
    true,
  );
  assert.equal(
    isGitReviewSummaryRequest({
      kind: 'continue',
      observationId: 'summary-observation-1',
      cursor: 'summary-cursor-2',
    }),
    true,
  );
  assert.equal(
    isGitReviewFileRequest({
      kind: 'start',
      observationId: 'summary-observation-1',
      fileId: 'file-1',
    }),
    true,
  );
  assert.equal(
    isGitReviewFileRequest({
      kind: 'continue',
      observationId: 'summary-observation-1',
      fileId: 'file-1',
      fileObservationId: 'file-observation-1',
      cursor: 'file-cursor-2',
    }),
    true,
  );
  assert.equal(
    isGitReviewReleaseRequest({
      kind: 'summary',
      observationId: 'summary-observation-1',
    }),
    true,
  );
  assert.equal(
    isGitReviewReleaseRequest({
      kind: 'file',
      observationId: 'summary-observation-1',
      fileObservationId: 'file-observation-1',
    }),
    true,
  );
});

void test('Git review request guards reject missing, mistyped, whitespace-only, and unknown fields', () => {
  for (const value of [
    null,
    { kind: 'start' },
    { kind: 'start', workingDirectory: '   ' },
    {
      kind: 'start',
      workingDirectory: '/workspace/repository',
      hiddenOption: '--work-tree=/other',
    },
    {
      kind: 'continue',
      observationId: 'summary-observation-1',
      cursor: 2,
    },
    {
      kind: 'continue',
      observationId: '',
      cursor: 'summary-cursor-2',
    },
  ]) {
    assert.equal(isGitReviewSummaryRequest(value), false);
  }

  for (const value of [
    { kind: 'start', observationId: 'summary-observation-1' },
    {
      kind: 'start',
      observationId: 'summary-observation-1',
      fileId: '',
    },
    {
      kind: 'continue',
      observationId: 'summary-observation-1',
      fileId: 'file-1',
      fileObservationId: 'file-observation-1',
    },
    {
      kind: 'continue',
      observationId: 'summary-observation-1',
      fileId: 'file-1',
      fileObservationId: 'file-observation-1',
      cursor: 'file-cursor-2',
      rawPath: 'src/private.ts',
    },
  ]) {
    assert.equal(isGitReviewFileRequest(value), false);
  }

  assert.equal(
    isGitReviewReleaseRequest({
      kind: 'file',
      observationId: 'summary-observation-1',
    }),
    false,
  );
  assert.equal(
    isGitReviewReleaseRequest({
      kind: 'summary',
      observationId: 'summary-observation-1',
      fileObservationId: 'file-observation-1',
    }),
    false,
  );
});

void test('Git review summary guard accepts closed domain results and layered changed truth', () => {
  assert.equal(isGitReviewSummaryResult(CHANGED_SUMMARY), true);
  assert.equal(
    isGitReviewSummaryResult({
      kind: 'clean',
      repositoryRoot: '/workspace/repository',
      branch: { name: null, detached: true, headOid: HEAD_OID },
      observedAt: TIMESTAMP,
    }),
    true,
  );
  assert.equal(
    isGitReviewSummaryResult({
      kind: 'not_reviewable',
      reason: 'filtered_worktree_comparison_unsupported',
    }),
    true,
  );
  assert.equal(
    isGitReviewSummaryResult({
      kind: 'stale',
      reason: 'cursor_mismatch',
    }),
    true,
  );
  assert.equal(
    isGitReviewSummaryResult({
      kind: 'unavailable',
      reason: 'resource_limit',
    }),
    true,
  );
});

void test('Git review summary guard rejects unknown nested fields and incomplete totals', () => {
  const unknownLayerField = clone(CHANGED_SUMMARY);
  Object.assign(unknownLayerField.files.items[0]?.layers[0] ?? {}, {
    rawPathBase64: 'cHJpdmF0ZQ==',
  });
  assert.equal(isGitReviewSummaryResult(unknownLayerField), false);

  const incompleteTotals = clone(CHANGED_SUMMARY);
  incompleteTotals.totals.lineStatsComplete = true;
  assert.equal(isGitReviewSummaryResult(incompleteTotals), false);

  const partialLineStats = {
    ...clone(CHANGED_SUMMARY),
    totals: {
      ...CHANGED_SUMMARY.totals,
      additions: 1,
    },
  };
  assert.equal(isGitReviewSummaryResult(partialLineStats), false);

  const malformedTimestamp = clone(CHANGED_SUMMARY);
  malformedTimestamp.observedAt = '2026-07-29T00:00:00Z';
  assert.equal(isGitReviewSummaryResult(malformedTimestamp), false);

  const unknownResultField = {
    ...CHANGED_SUMMARY,
    daemonObservation: true,
  };
  assert.equal(isGitReviewSummaryResult(unknownResultField), false);
});

void test('Git review summary guard enforces layer state and path invariants', () => {
  const samePathRename = clone(CHANGED_SUMMARY);
  const stagedRename = samePathRename.files.items[0]?.layers[0];
  assert.ok(stagedRename);
  stagedRename.afterDisplayPath = stagedRename.beforeDisplayPath;
  assert.equal(isGitReviewSummaryResult(samePathRename), false);

  const modifiedAcrossPaths = clone(CHANGED_SUMMARY);
  const modified = modifiedAcrossPaths.files.items[0]?.layers[0];
  assert.ok(modified);
  modified.state = 'modified';
  assert.equal(isGitReviewSummaryResult(modifiedAcrossPaths), false);

  const badUntracked = clone(CHANGED_SUMMARY);
  const untracked = badUntracked.files.items[0]?.layers[0];
  assert.ok(untracked);
  untracked.comparison = 'untracked';
  untracked.state = 'untracked';
  assert.equal(isGitReviewSummaryResult(badUntracked), false);

  const badTypeChange = clone(CHANGED_SUMMARY);
  const typeChange = badTypeChange.files.items[0]?.layers[0];
  assert.ok(typeChange);
  typeChange.state = 'type_changed';
  assert.equal(isGitReviewSummaryResult(badTypeChange), false);
});

void test('Git review summary guard rejects duplicate identities and false convenience flags', () => {
  const duplicateFile = clone(CHANGED_SUMMARY);
  const file = duplicateFile.files.items[0];
  assert.ok(file);
  duplicateFile.files.items.push(clone(file));
  duplicateFile.totals.fileCount = 2;
  assert.equal(isGitReviewSummaryResult(duplicateFile), false);

  const duplicateLayer = clone(CHANGED_SUMMARY);
  const layers = duplicateLayer.files.items[0]?.layers;
  assert.ok(layers);
  assert.ok(layers[0]);
  assert.ok(layers[1]);
  layers[1].layerId = layers[0].layerId;
  assert.equal(isGitReviewSummaryResult(duplicateLayer), false);

  const falseFlags = clone(CHANGED_SUMMARY);
  const flagged = falseFlags.files.items[0];
  assert.ok(flagged);
  flagged.staged = false;
  assert.equal(isGitReviewSummaryResult(falseFlags), false);
});

void test('Git review file guard accepts correlated structured sections and rows', () => {
  assert.equal(isGitReviewFileResult(READY_FILE), true);
  assert.equal(
    isGitReviewFileResult({
      kind: 'ready',
      observationId: 'summary-observation-1',
      fileObservationId: 'file-observation-conflict',
      fileId: 'file-conflict',
      sections: [
        {
          sectionId: 'section-conflict',
          layerId: 'layer-conflict',
          comparison: 'conflict',
          projection: 'conflict',
          metadataReason: null,
        },
      ],
      rows: { items: [], nextCursor: null },
      capturedAt: TIMESTAMP,
    }),
    true,
  );
  assert.equal(
    isGitReviewFileResult({
      kind: 'stale',
      reason: 'entry_missing',
    }),
    true,
  );
  assert.equal(
    isGitReviewFileResult({
      kind: 'unavailable',
      reason: 'row_exceeds_transport_boundary',
    }),
    true,
  );
});

void test('Git review file guard rejects impossible section and row combinations', () => {
  const metadataWithoutReason = clone(READY_FILE);
  const metadataSection = metadataWithoutReason.sections[1];
  assert.ok(metadataSection);
  metadataSection.metadataReason = null;
  assert.equal(isGitReviewFileResult(metadataWithoutReason), false);

  const textWithReason = clone(READY_FILE);
  const textSection = textWithReason.sections[0];
  assert.ok(textSection);
  textSection.metadataReason = 'binary';
  assert.equal(isGitReviewFileResult(textWithReason), false);

  const conflictAsText = clone(READY_FILE);
  const conflictSection = conflictAsText.sections[0];
  assert.ok(conflictSection);
  conflictSection.comparison = 'conflict';
  assert.equal(isGitReviewFileResult(conflictAsText), false);

  const danglingRow = clone(READY_FILE);
  const row = danglingRow.rows.items[0];
  assert.ok(row);
  row.sectionId = 'missing-section';
  assert.equal(isGitReviewFileResult(danglingRow), false);

  const malformedAddition = clone(READY_FILE);
  const addition = malformedAddition.rows.items[2];
  assert.ok(addition);
  addition.oldLine = 1;
  assert.equal(isGitReviewFileResult(malformedAddition), false);
});

void test('Git review file guard rejects duplicate section/layer identity and unknown fields', () => {
  const duplicateSection = clone(READY_FILE);
  assert.ok(duplicateSection.sections[0]);
  assert.ok(duplicateSection.sections[1]);
  duplicateSection.sections[1].sectionId =
    duplicateSection.sections[0].sectionId;
  assert.equal(isGitReviewFileResult(duplicateSection), false);

  const duplicateLayer = clone(READY_FILE);
  assert.ok(duplicateLayer.sections[0]);
  assert.ok(duplicateLayer.sections[1]);
  duplicateLayer.sections[1].layerId = duplicateLayer.sections[0].layerId;
  assert.equal(isGitReviewFileResult(duplicateLayer), false);

  const unknownRowField = clone(READY_FILE);
  Object.assign(unknownRowField.rows.items[0] ?? {}, { rawBytes: 'private' });
  assert.equal(isGitReviewFileResult(unknownRowField), false);
});

void test('Git review release result is exact and reveals no extra state', () => {
  assert.equal(isGitReviewReleaseResult({ kind: 'released' }), true);
  assert.equal(
    isGitReviewReleaseResult({
      kind: 'released',
      existed: true,
    }),
    false,
  );
  assert.equal(isGitReviewReleaseResult({ kind: 'missing' }), false);
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
