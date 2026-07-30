import {
  hasOnlyKeys,
  isBoolean,
  isCanonicalIsoTimestamp,
  isNumber,
  isPlainRecord,
  isString,
} from './wire-value-guards.js';

export interface GitReviewPage<T> {
  items: T[];
  nextCursor: string | null;
}

export type GitReviewSummaryRequest =
  | {
      kind: 'start';
      workingDirectory: string;
    }
  | {
      kind: 'continue';
      observationId: string;
      cursor: string;
    };

export interface GitReviewBranch {
  name: string | null;
  detached: boolean;
  headOid: string | null;
}

export interface GitReviewTotals {
  fileCount: number;
  additions: number | null;
  deletions: number | null;
  lineStatsComplete: boolean;
}

export type GitReviewComparisonKind =
  | 'staged'
  | 'unstaged'
  | 'untracked'
  | 'conflict';

export type GitReviewEntryState =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'type_changed'
  | 'conflicted'
  | 'untracked';

export type GitReviewContentKind =
  | 'text'
  | 'binary'
  | 'symlink'
  | 'submodule'
  | 'special'
  | 'unknown';

export interface GitReviewLayerSummary {
  layerId: string;
  comparison: GitReviewComparisonKind;
  state: GitReviewEntryState;
  beforeDisplayPath: string | null;
  afterDisplayPath: string | null;
  beforeContentKind: GitReviewContentKind | null;
  afterContentKind: GitReviewContentKind | null;
}

export interface GitReviewFileSummary {
  fileId: string;
  displayPath: string;
  layers: GitReviewLayerSummary[];
  staged: boolean;
  unstaged: boolean;
}

export type GitReviewSummaryResult =
  | {
      kind: 'not_reviewable';
      reason:
        | 'not_repository'
        | 'missing_directory'
        | 'bare_repository'
        | 'repository_root_unreachable'
        | 'filtered_worktree_comparison_unsupported'
        | 'unsupported_worktree_transformation'
        | 'safe_worktree_read_unavailable';
    }
  | {
      kind: 'clean';
      repositoryRoot: string;
      branch: GitReviewBranch;
      observedAt: string;
    }
  | {
      kind: 'changed';
      observationId: string;
      repositoryRoot: string;
      branch: GitReviewBranch;
      totals: GitReviewTotals;
      files: GitReviewPage<GitReviewFileSummary>;
      observedAt: string;
    }
  | {
      kind: 'stale';
      reason:
        | 'observation_expired'
        | 'observation_changed'
        | 'cursor_invalid'
        | 'cursor_mismatch';
    }
  | {
      kind: 'unavailable';
      reason: 'resource_limit';
    };

export type GitReviewFileRequest =
  | {
      kind: 'start';
      observationId: string;
      fileId: string;
    }
  | {
      kind: 'continue';
      observationId: string;
      fileId: string;
      fileObservationId: string;
      cursor: string;
    };

export type GitReviewMetadataReason =
  | 'binary'
  | 'symlink'
  | 'submodule'
  | 'special_file'
  | 'filtered_content_unsupported'
  | 'unsupported_content_transformation'
  | 'safe_read_unavailable';

export type GitReviewComparisonSection =
  | {
      sectionId: string;
      layerId: string;
      comparison: 'staged' | 'unstaged' | 'untracked';
      projection: 'text';
      metadataReason: null;
    }
  | {
      sectionId: string;
      layerId: string;
      comparison: 'staged' | 'unstaged' | 'untracked';
      projection: 'metadata_only';
      metadataReason: GitReviewMetadataReason;
    }
  | {
      sectionId: string;
      layerId: string;
      comparison: 'conflict';
      projection: 'conflict';
      metadataReason: null;
    };

export interface GitReviewDiffRow {
  sectionId: string;
  kind: 'metadata' | 'hunk' | 'context' | 'addition' | 'deletion';
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

export type GitReviewFileResult =
  | {
      kind: 'ready';
      observationId: string;
      fileObservationId: string;
      fileId: string;
      sections: GitReviewComparisonSection[];
      rows: GitReviewPage<GitReviewDiffRow>;
      capturedAt: string;
    }
  | {
      kind: 'stale';
      reason:
        | 'observation_changed'
        | 'entry_missing'
        | 'observation_expired'
        | 'cursor_invalid'
        | 'cursor_mismatch';
    }
  | {
      kind: 'unavailable';
      reason:
        | 'resource_limit'
        | 'row_exceeds_transport_boundary'
        | 'comparison_unsupported';
    };

export type GitReviewReleaseRequest =
  | {
      kind: 'summary';
      observationId: string;
    }
  | {
      kind: 'file';
      observationId: string;
      fileObservationId: string;
    };

export interface GitReviewReleaseResult {
  kind: 'released';
}

export function isGitReviewSummaryRequest(
  value: unknown,
): value is GitReviewSummaryRequest {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (value.kind === 'start') {
    return (
      hasExactKeys(value, ['kind', 'workingDirectory']) &&
      (value.workingDirectory === '' ||
        isNonEmptyString(value.workingDirectory))
    );
  }
  return (
    value.kind === 'continue' &&
    hasExactKeys(value, ['kind', 'observationId', 'cursor']) &&
    isOpaqueId(value.observationId) &&
    isOpaqueId(value.cursor)
  );
}

export function isGitReviewSummaryResult(
  value: unknown,
): value is GitReviewSummaryResult {
  if (!isPlainRecord(value)) {
    return false;
  }
  switch (value.kind) {
    case 'not_reviewable':
      return (
        hasExactKeys(value, ['kind', 'reason']) &&
        isGitReviewNotReviewableReason(value.reason)
      );
    case 'clean':
      return (
        hasExactKeys(value, [
          'kind',
          'repositoryRoot',
          'branch',
          'observedAt',
        ]) &&
        isNonEmptyString(value.repositoryRoot) &&
        isGitReviewBranch(value.branch) &&
        isCanonicalIsoTimestamp(value.observedAt)
      );
    case 'changed':
      return isGitReviewChangedResult(value);
    case 'stale':
      return (
        hasExactKeys(value, ['kind', 'reason']) &&
        isGitReviewSummaryStaleReason(value.reason)
      );
    case 'unavailable':
      return (
        hasExactKeys(value, ['kind', 'reason']) &&
        value.reason === 'resource_limit'
      );
    default:
      return false;
  }
}

export function isGitReviewFileRequest(
  value: unknown,
): value is GitReviewFileRequest {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (value.kind === 'start') {
    return (
      hasExactKeys(value, ['kind', 'observationId', 'fileId']) &&
      isOpaqueId(value.observationId) &&
      isOpaqueId(value.fileId)
    );
  }
  return (
    value.kind === 'continue' &&
    hasExactKeys(value, [
      'kind',
      'observationId',
      'fileId',
      'fileObservationId',
      'cursor',
    ]) &&
    isOpaqueId(value.observationId) &&
    isOpaqueId(value.fileId) &&
    isOpaqueId(value.fileObservationId) &&
    isOpaqueId(value.cursor)
  );
}

export function isGitReviewFileResult(
  value: unknown,
): value is GitReviewFileResult {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (value.kind === 'ready') {
    return isGitReviewReadyFileResult(value);
  }
  if (value.kind === 'stale') {
    return (
      hasExactKeys(value, ['kind', 'reason']) &&
      isGitReviewFileStaleReason(value.reason)
    );
  }
  return (
    value.kind === 'unavailable' &&
    hasExactKeys(value, ['kind', 'reason']) &&
    (value.reason === 'resource_limit' ||
      value.reason === 'row_exceeds_transport_boundary' ||
      value.reason === 'comparison_unsupported')
  );
}

export function isGitReviewReleaseRequest(
  value: unknown,
): value is GitReviewReleaseRequest {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (value.kind === 'summary') {
    return (
      hasExactKeys(value, ['kind', 'observationId']) &&
      isOpaqueId(value.observationId)
    );
  }
  return (
    value.kind === 'file' &&
    hasExactKeys(value, ['kind', 'observationId', 'fileObservationId']) &&
    isOpaqueId(value.observationId) &&
    isOpaqueId(value.fileObservationId)
  );
}

export function isGitReviewReleaseResult(
  value: unknown,
): value is GitReviewReleaseResult {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['kind']) &&
    value.kind === 'released'
  );
}

function isGitReviewChangedResult(
  value: Record<string, unknown>,
): value is Extract<GitReviewSummaryResult, { kind: 'changed' }> {
  if (
    !hasExactKeys(value, [
      'kind',
      'observationId',
      'repositoryRoot',
      'branch',
      'totals',
      'files',
      'observedAt',
    ]) ||
    !isOpaqueId(value.observationId) ||
    !isNonEmptyString(value.repositoryRoot) ||
    !isGitReviewBranch(value.branch) ||
    !isGitReviewTotals(value.totals) ||
    !isGitReviewPage(value.files, isGitReviewFileSummary) ||
    !isCanonicalIsoTimestamp(value.observedAt)
  ) {
    return false;
  }
  if (value.totals.fileCount < value.files.items.length) {
    return false;
  }
  const fileIds = new Set<string>();
  const layerIds = new Set<string>();
  for (const file of value.files.items) {
    if (fileIds.has(file.fileId)) {
      return false;
    }
    fileIds.add(file.fileId);
    for (const layer of file.layers) {
      if (layerIds.has(layer.layerId)) {
        return false;
      }
      layerIds.add(layer.layerId);
    }
  }
  return true;
}

function isGitReviewBranch(value: unknown): value is GitReviewBranch {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['name', 'detached', 'headOid']) &&
    (value.name === null || isNonEmptyString(value.name)) &&
    isBoolean(value.detached) &&
    (value.headOid === null || isGitObjectId(value.headOid)) &&
    (!value.detached || value.name === null)
  );
}

function isGitReviewTotals(value: unknown): value is GitReviewTotals {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'fileCount',
      'additions',
      'deletions',
      'lineStatsComplete',
    ]) ||
    !isNonNegativeInteger(value.fileCount) ||
    !isBoolean(value.lineStatsComplete)
  ) {
    return false;
  }
  const hasLineStats =
    isNonNegativeInteger(value.additions) &&
    isNonNegativeInteger(value.deletions);
  const hasNoLineStats = value.additions === null && value.deletions === null;
  return value.lineStatsComplete ? hasLineStats : hasNoLineStats;
}

function isGitReviewFileSummary(value: unknown): value is GitReviewFileSummary {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'fileId',
      'displayPath',
      'layers',
      'staged',
      'unstaged',
    ]) ||
    !isOpaqueId(value.fileId) ||
    !isNonEmptyString(value.displayPath) ||
    !Array.isArray(value.layers) ||
    value.layers.length === 0 ||
    !value.layers.every(isGitReviewLayerSummary) ||
    !isBoolean(value.staged) ||
    !isBoolean(value.unstaged)
  ) {
    return false;
  }
  const layerIds = new Set(value.layers.map((layer) => layer.layerId));
  if (layerIds.size !== value.layers.length) {
    return false;
  }
  const hasConflict = value.layers.some(
    (layer) => layer.comparison === 'conflict',
  );
  return (
    (!hasConflict || value.layers.length === 1) &&
    value.staged ===
      value.layers.some((layer) => layer.comparison === 'staged') &&
    value.unstaged ===
      value.layers.some(
        (layer) =>
          layer.comparison === 'unstaged' || layer.comparison === 'untracked',
      )
  );
}

function isGitReviewLayerSummary(
  value: unknown,
): value is GitReviewLayerSummary {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'layerId',
      'comparison',
      'state',
      'beforeDisplayPath',
      'afterDisplayPath',
      'beforeContentKind',
      'afterContentKind',
    ]) ||
    !isOpaqueId(value.layerId) ||
    !isGitReviewComparisonKind(value.comparison) ||
    !isGitReviewEntryState(value.state) ||
    !isNullableDisplayPath(value.beforeDisplayPath) ||
    !isNullableDisplayPath(value.afterDisplayPath) ||
    !isNullableGitReviewContentKind(value.beforeContentKind) ||
    !isNullableGitReviewContentKind(value.afterContentKind)
  ) {
    return false;
  }
  if (value.comparison === 'conflict') {
    return (
      value.state === 'conflicted' &&
      value.beforeDisplayPath === null &&
      value.beforeContentKind === null
    );
  }
  if (value.comparison === 'untracked') {
    return (
      value.state === 'untracked' &&
      value.beforeDisplayPath === null &&
      value.beforeContentKind === null &&
      value.afterDisplayPath !== null &&
      value.afterContentKind !== null
    );
  }
  if (
    value.state === 'conflicted' ||
    value.state === 'untracked' ||
    (value.comparison === 'unstaged' && value.state === 'added')
  ) {
    return false;
  }
  switch (value.state) {
    case 'added':
      return (
        value.beforeDisplayPath === null &&
        value.beforeContentKind === null &&
        value.afterDisplayPath !== null &&
        value.afterContentKind !== null
      );
    case 'deleted':
      return (
        value.beforeDisplayPath !== null &&
        value.beforeContentKind !== null &&
        value.afterDisplayPath === null &&
        value.afterContentKind === null
      );
    case 'renamed':
      return (
        value.beforeDisplayPath !== null &&
        value.afterDisplayPath !== null &&
        value.beforeDisplayPath !== value.afterDisplayPath &&
        value.beforeContentKind !== null &&
        value.afterContentKind !== null
      );
    case 'type_changed':
      return (
        value.beforeDisplayPath !== null &&
        value.afterDisplayPath !== null &&
        value.beforeContentKind !== null &&
        value.afterContentKind !== null &&
        value.beforeContentKind !== value.afterContentKind
      );
    case 'modified':
      return (
        value.beforeDisplayPath !== null &&
        value.afterDisplayPath === value.beforeDisplayPath &&
        value.beforeContentKind !== null &&
        value.afterContentKind !== null
      );
  }
}

function isGitReviewReadyFileResult(
  value: Record<string, unknown>,
): value is Extract<GitReviewFileResult, { kind: 'ready' }> {
  if (
    !hasExactKeys(value, [
      'kind',
      'observationId',
      'fileObservationId',
      'fileId',
      'sections',
      'rows',
      'capturedAt',
    ]) ||
    !isOpaqueId(value.observationId) ||
    !isOpaqueId(value.fileObservationId) ||
    !isOpaqueId(value.fileId) ||
    !Array.isArray(value.sections) ||
    value.sections.length === 0 ||
    !value.sections.every(isGitReviewComparisonSection) ||
    !isGitReviewPage(value.rows, isGitReviewDiffRow) ||
    !isCanonicalIsoTimestamp(value.capturedAt)
  ) {
    return false;
  }
  const sectionIds = new Set<string>();
  const layerIds = new Set<string>();
  for (const section of value.sections) {
    if (sectionIds.has(section.sectionId) || layerIds.has(section.layerId)) {
      return false;
    }
    sectionIds.add(section.sectionId);
    layerIds.add(section.layerId);
  }
  return value.rows.items.every((row) => sectionIds.has(row.sectionId));
}

function isGitReviewComparisonSection(
  value: unknown,
): value is GitReviewComparisonSection {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'sectionId',
      'layerId',
      'comparison',
      'projection',
      'metadataReason',
    ]) ||
    !isOpaqueId(value.sectionId) ||
    !isOpaqueId(value.layerId)
  ) {
    return false;
  }
  if (value.comparison === 'conflict') {
    return value.projection === 'conflict' && value.metadataReason === null;
  }
  if (
    value.comparison !== 'staged' &&
    value.comparison !== 'unstaged' &&
    value.comparison !== 'untracked'
  ) {
    return false;
  }
  if (value.projection === 'text') {
    return value.metadataReason === null;
  }
  return (
    value.projection === 'metadata_only' &&
    isGitReviewMetadataReason(value.metadataReason)
  );
}

function isGitReviewDiffRow(value: unknown): value is GitReviewDiffRow {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'sectionId',
      'kind',
      'oldLine',
      'newLine',
      'content',
    ]) ||
    !isOpaqueId(value.sectionId) ||
    !isGitReviewDiffRowKind(value.kind) ||
    !isNullablePositiveInteger(value.oldLine) ||
    !isNullablePositiveInteger(value.newLine) ||
    !isString(value.content)
  ) {
    return false;
  }
  switch (value.kind) {
    case 'metadata':
    case 'hunk':
      return value.oldLine === null && value.newLine === null;
    case 'context':
      return value.oldLine !== null && value.newLine !== null;
    case 'addition':
      return value.oldLine === null && value.newLine !== null;
    case 'deletion':
      return value.oldLine !== null && value.newLine === null;
  }
}

function isGitReviewPage<T>(
  value: unknown,
  isItem: (item: unknown) => item is T,
): value is GitReviewPage<T> {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['items', 'nextCursor']) &&
    Array.isArray(value.items) &&
    value.items.every(isItem) &&
    (value.nextCursor === null || isOpaqueId(value.nextCursor))
  );
}

function isGitReviewNotReviewableReason(value: unknown): boolean {
  return (
    value === 'not_repository' ||
    value === 'missing_directory' ||
    value === 'bare_repository' ||
    value === 'repository_root_unreachable' ||
    value === 'filtered_worktree_comparison_unsupported' ||
    value === 'unsupported_worktree_transformation' ||
    value === 'safe_worktree_read_unavailable'
  );
}

function isGitReviewSummaryStaleReason(value: unknown): boolean {
  return (
    value === 'observation_expired' ||
    value === 'observation_changed' ||
    value === 'cursor_invalid' ||
    value === 'cursor_mismatch'
  );
}

function isGitReviewFileStaleReason(value: unknown): boolean {
  return (
    value === 'observation_changed' ||
    value === 'entry_missing' ||
    value === 'observation_expired' ||
    value === 'cursor_invalid' ||
    value === 'cursor_mismatch'
  );
}

function isGitReviewComparisonKind(
  value: unknown,
): value is GitReviewComparisonKind {
  return (
    value === 'staged' ||
    value === 'unstaged' ||
    value === 'untracked' ||
    value === 'conflict'
  );
}

function isGitReviewEntryState(value: unknown): value is GitReviewEntryState {
  return (
    value === 'added' ||
    value === 'modified' ||
    value === 'deleted' ||
    value === 'renamed' ||
    value === 'type_changed' ||
    value === 'conflicted' ||
    value === 'untracked'
  );
}

function isNullableGitReviewContentKind(
  value: unknown,
): value is GitReviewContentKind | null {
  return value === null || isGitReviewContentKind(value);
}

function isGitReviewContentKind(value: unknown): value is GitReviewContentKind {
  return (
    value === 'text' ||
    value === 'binary' ||
    value === 'symlink' ||
    value === 'submodule' ||
    value === 'special' ||
    value === 'unknown'
  );
}

function isGitReviewMetadataReason(
  value: unknown,
): value is GitReviewMetadataReason {
  return (
    value === 'binary' ||
    value === 'symlink' ||
    value === 'submodule' ||
    value === 'special_file' ||
    value === 'filtered_content_unsupported' ||
    value === 'unsupported_content_transformation' ||
    value === 'safe_read_unavailable'
  );
}

function isGitReviewDiffRowKind(
  value: unknown,
): value is GitReviewDiffRow['kind'] {
  return (
    value === 'metadata' ||
    value === 'hunk' ||
    value === 'context' ||
    value === 'addition' ||
    value === 'deletion'
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expectedKeys.length &&
    hasOnlyKeys(value, expectedKeys)
  );
}

function isOpaqueId(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isNullableDisplayPath(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return (
    value === null ||
    (isNumber(value) && Number.isSafeInteger(value) && value > 0)
  );
}

function isGitObjectId(value: unknown): value is string {
  return isString(value) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}
