import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { HostCommandRuntime } from '../command-host/contract.js';
import {
  readGitBlobObject,
  sameGitObjectIndexSnapshot,
} from './git-inspection-command.js';
import type {
  GitLogicalEntry,
  GitLogicalLayerEntry,
} from './git-logical-diff.js';
import {
  captureGitReviewObservation,
  type GitReviewObservationSnapshot,
} from './git-review-observation.js';
import type {
  GitComparisonContentKind,
  GitWorktreeContentSnapshot,
} from './git-worktree-capture.js';

const SUMMARY_CURSOR_PREFIX = 'git-review-summary-v1';
const FILE_CURSOR_PREFIX = 'git-review-file-v1';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const UNIFIED_DIFF_CONTEXT_LINES = 3;

interface StoredGitReviewFile {
  fileId: string;
  logicalEntry: GitLogicalEntry;
  summary: GitReviewSummaryServiceFile;
}

interface StoredGitReviewSummary {
  observationId: string;
  observation: GitReviewObservationSnapshot;
  observedAt: string;
  files: readonly StoredGitReviewFile[];
  totals: {
    fileCount: number;
    additions: number | null;
    deletions: number | null;
    lineStatsComplete: boolean;
  };
}

interface StoredGitReviewFileObservation {
  observationId: string;
  fileObservationId: string;
  fileId: string;
  sections: readonly GitReviewFileServiceSection[];
  rows: readonly GitReviewFileServiceRow[];
  capturedAt: string;
}

interface SummaryCursorPayload {
  kind: 'summary';
  observationId: string;
  offset: number;
}

interface FileCursorPayload {
  kind: 'file';
  observationId: string;
  fileId: string;
  fileObservationId: string;
  offset: number;
}

type GitReviewSummaryServiceRequest =
  | {
      kind: 'start';
      workingDirectory: string;
    }
  | {
      kind: 'continue';
      observationId: string;
      cursor: string;
    };

interface GitReviewSummaryServiceLayer {
  layerId: string;
  comparison: GitLogicalLayerEntry['comparison'];
  state: GitLogicalLayerEntry['state'];
  beforeDisplayPath: string | null;
  afterDisplayPath: string | null;
  beforeContentKind: GitComparisonContentKind | null;
  afterContentKind: GitComparisonContentKind | null;
}

interface GitReviewSummaryServiceFile {
  fileId: string;
  displayPath: string;
  layers: GitReviewSummaryServiceLayer[];
  staged: boolean;
  unstaged: boolean;
}

type GitReviewSummaryServiceResult =
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
      branch: {
        name: string | null;
        detached: boolean;
        headOid: string | null;
      };
      observedAt: string;
    }
  | {
      kind: 'changed';
      observationId: string;
      repositoryRoot: string;
      branch: {
        name: string | null;
        detached: boolean;
        headOid: string | null;
      };
      totals: {
        fileCount: number;
        additions: number | null;
        deletions: number | null;
        lineStatsComplete: boolean;
      };
      files: {
        items: GitReviewSummaryServiceFile[];
        nextCursor: string | null;
      };
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

type GitReviewObservationReleaseRequest =
  | {
      kind: 'summary';
      observationId: string;
    }
  | {
      kind: 'file';
      observationId: string;
      fileObservationId: string;
    };

type GitReviewFileServiceRequest =
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

type GitReviewFileServiceSection =
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
      metadataReason:
        | 'binary'
        | 'symlink'
        | 'submodule'
        | 'special_file'
        | 'filtered_content_unsupported'
        | 'unsupported_content_transformation'
        | 'safe_read_unavailable';
    }
  | {
      sectionId: string;
      layerId: string;
      comparison: 'conflict';
      projection: 'conflict';
      metadataReason: null;
    };

interface GitReviewFileServiceRow {
  sectionId: string;
  kind: 'metadata' | 'hunk' | 'context' | 'addition' | 'deletion';
  oldLine: number | null;
  newLine: number | null;
  content: string;
}

type GitReviewFileServiceResult =
  | {
      kind: 'ready';
      observationId: string;
      fileObservationId: string;
      fileId: string;
      sections: GitReviewFileServiceSection[];
      rows: {
        items: GitReviewFileServiceRow[];
        nextCursor: string | null;
      };
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

interface GitReviewObservationService {
  summary(
    request: GitReviewSummaryServiceRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GitReviewSummaryServiceResult>;
  file(
    request: GitReviewFileServiceRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GitReviewFileServiceResult>;
  release(request: GitReviewObservationReleaseRequest): { kind: 'released' };
}

export function createGitReviewObservationService(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  coordinateBase?: string;
  pageLimitBytes: number;
  maxOutputBytesPerStream: number;
  maxFileBytes: number;
  cursorKey?: Buffer;
  createId?: () => string;
  now?: () => Date;
}): GitReviewObservationService {
  if (!Number.isSafeInteger(args.pageLimitBytes) || args.pageLimitBytes <= 0) {
    throw new RangeError('Git review pageLimitBytes must be positive');
  }
  const cursorKey = Buffer.from(args.cursorKey ?? randomBytes(32));
  if (cursorKey.length === 0) {
    throw new RangeError('Git review cursor key must not be empty');
  }
  const createId = args.createId ?? randomUUID;
  const now = args.now ?? (() => new Date());
  const summaries = new Map<string, StoredGitReviewSummary>();
  const fileObservations = new Map<string, StoredGitReviewFileObservation>();

  return {
    async summary(request, options = {}) {
      if (request.kind === 'continue') {
        const cursor = decodeSummaryCursor(cursorKey, request.cursor);
        if (cursor === undefined) {
          return { kind: 'stale', reason: 'cursor_invalid' };
        }
        if (cursor.observationId !== request.observationId) {
          return { kind: 'stale', reason: 'cursor_mismatch' };
        }
        const stored = summaries.get(request.observationId);
        if (stored === undefined) {
          return { kind: 'stale', reason: 'observation_expired' };
        }
        if (cursor.offset <= 0 || cursor.offset >= stored.files.length) {
          return { kind: 'stale', reason: 'cursor_invalid' };
        }
        return projectChangedSummaryPage({
          stored,
          offset: cursor.offset,
          pageLimitBytes: args.pageLimitBytes,
          cursorKey,
        });
      }

      const workingDirectory = await resolveReviewWorkingDirectory(
        request.workingDirectory,
        args.coordinateBase,
      );
      if (!workingDirectory.ok) {
        return workingDirectory.result;
      }
      const captured = await captureGitReviewObservation({
        hostCommands: args.hostCommands,
        stateRoot: args.stateRoot,
        workingDirectory: workingDirectory.path,
        pageLimitBytes: args.pageLimitBytes,
        maxOutputBytesPerStream: args.maxOutputBytesPerStream,
        maxFileBytes: args.maxFileBytes,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!captured.ok) {
        return projectGitReviewCaptureFailure(captured);
      }
      const observedAt = now().toISOString();
      const { objectIndexSnapshot, logicalEntries } = captured.observation;
      const branch = {
        name: objectIndexSnapshot.branch.name,
        detached: objectIndexSnapshot.branch.detached,
        headOid: objectIndexSnapshot.headObjectId,
      };
      if (logicalEntries.length === 0) {
        return {
          kind: 'clean',
          repositoryRoot: objectIndexSnapshot.repositoryRoot,
          branch,
          observedAt,
        };
      }

      const observationId = `git-summary:${createId()}`;
      const files = logicalEntries.map((logicalEntry): StoredGitReviewFile => {
        const fileId = `git-file:${createId()}`;
        return {
          fileId,
          logicalEntry,
          summary: projectGitReviewFileSummary({
            fileId,
            logicalEntry,
            observation: captured.observation,
            createId,
          }),
        };
      });
      if (
        files.some(
          ({ summary }) =>
            Buffer.byteLength(JSON.stringify(summary), 'utf8') >
            args.pageLimitBytes,
        )
      ) {
        return { kind: 'unavailable', reason: 'resource_limit' };
      }
      const totals = await calculateGitReviewTotals({
        hostCommands: args.hostCommands,
        stateRoot: args.stateRoot,
        pageLimitBytes: args.pageLimitBytes,
        maxOutputBytesPerStream: args.maxOutputBytesPerStream,
        observation: captured.observation,
        files,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!totals.ok) {
        return totals.result;
      }
      const stored: StoredGitReviewSummary = {
        observationId,
        observation: captured.observation,
        observedAt,
        files,
        totals: totals.value,
      };
      summaries.set(observationId, stored);
      return projectChangedSummaryPage({
        stored,
        offset: 0,
        pageLimitBytes: args.pageLimitBytes,
        cursorKey,
      });
    },

    async file(request, options = {}) {
      if (request.kind === 'continue') {
        const cursor = decodeFileCursor(cursorKey, request.cursor);
        if (cursor === undefined) {
          return { kind: 'stale', reason: 'cursor_invalid' };
        }
        if (
          cursor.observationId !== request.observationId ||
          cursor.fileId !== request.fileId ||
          cursor.fileObservationId !== request.fileObservationId
        ) {
          return { kind: 'stale', reason: 'cursor_mismatch' };
        }
        if (!summaries.has(request.observationId)) {
          return { kind: 'stale', reason: 'observation_expired' };
        }
        const storedFileObservation = fileObservations.get(
          request.fileObservationId,
        );
        if (storedFileObservation === undefined) {
          return { kind: 'stale', reason: 'observation_expired' };
        }
        if (
          cursor.offset <= 0 ||
          cursor.offset >= storedFileObservation.rows.length
        ) {
          return { kind: 'stale', reason: 'cursor_invalid' };
        }
        return projectReadyFilePage({
          stored: storedFileObservation,
          offset: cursor.offset,
          pageLimitBytes: args.pageLimitBytes,
          cursorKey,
        });
      }

      const storedSummary = summaries.get(request.observationId);
      if (storedSummary === undefined) {
        return { kind: 'stale', reason: 'observation_expired' };
      }
      const storedFile = storedSummary.files.find(
        ({ fileId }) => fileId === request.fileId,
      );
      if (storedFile === undefined) {
        return { kind: 'stale', reason: 'entry_missing' };
      }
      const recaptured = await captureGitReviewObservation({
        hostCommands: args.hostCommands,
        stateRoot: args.stateRoot,
        workingDirectory:
          storedSummary.observation.objectIndexSnapshot.repositoryRoot,
        pageLimitBytes: args.pageLimitBytes,
        maxOutputBytesPerStream: args.maxOutputBytesPerStream,
        maxFileBytes: args.maxFileBytes,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!recaptured.ok) {
        return projectGitReviewFileCaptureFailure(recaptured);
      }
      if (
        !sameGitObjectIndexSnapshot(
          storedSummary.observation.objectIndexSnapshot,
          recaptured.observation.objectIndexSnapshot,
        )
      ) {
        return { kind: 'stale', reason: 'observation_changed' };
      }
      const matchingEntries = recaptured.observation.logicalEntries.filter(
        ({ structuralIdentity }) =>
          structuralIdentity === storedFile.logicalEntry.structuralIdentity,
      );
      const [recapturedEntry] = matchingEntries;
      if (matchingEntries.length !== 1 || recapturedEntry === undefined) {
        return {
          kind: 'stale',
          reason:
            storedFile.logicalEntry.exactRenameProofs.length > 0
              ? 'observation_changed'
              : 'entry_missing',
        };
      }
      if (!sameGitExactRenameProofs(storedFile.logicalEntry, recapturedEntry)) {
        return { kind: 'stale', reason: 'observation_changed' };
      }
      const projected = await buildGitReviewFileProjection({
        hostCommands: args.hostCommands,
        stateRoot: args.stateRoot,
        pageLimitBytes: args.pageLimitBytes,
        maxOutputBytesPerStream: args.maxOutputBytesPerStream,
        observation: recaptured.observation,
        logicalEntry: recapturedEntry,
        summary: storedFile.summary,
        createId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!projected.ok) {
        return projected.result;
      }
      if (
        projected.rows.some(
          (row) =>
            Buffer.byteLength(JSON.stringify(row), 'utf8') >
            args.pageLimitBytes,
        )
      ) {
        return {
          kind: 'unavailable',
          reason: 'row_exceeds_transport_boundary',
        };
      }
      const fileObservationId = `git-file-observation:${createId()}`;
      const storedFileObservation: StoredGitReviewFileObservation = {
        observationId: request.observationId,
        fileObservationId,
        fileId: request.fileId,
        sections: projected.sections,
        rows: projected.rows,
        capturedAt: now().toISOString(),
      };
      fileObservations.set(fileObservationId, storedFileObservation);
      return projectReadyFilePage({
        stored: storedFileObservation,
        offset: 0,
        pageLimitBytes: args.pageLimitBytes,
        cursorKey,
      });
    },

    release(request) {
      if (request.kind === 'summary') {
        summaries.delete(request.observationId);
        for (const [fileObservationId, fileObservation] of fileObservations) {
          if (fileObservation.observationId === request.observationId) {
            fileObservations.delete(fileObservationId);
          }
        }
      } else {
        const fileObservation = fileObservations.get(request.fileObservationId);
        if (fileObservation?.observationId === request.observationId) {
          fileObservations.delete(request.fileObservationId);
        }
      }
      return { kind: 'released' };
    },
  };
}

async function calculateGitReviewTotals(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  pageLimitBytes: number;
  maxOutputBytesPerStream: number;
  observation: GitReviewObservationSnapshot;
  files: readonly StoredGitReviewFile[];
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      value: StoredGitReviewSummary['totals'];
    }
  | {
      ok: false;
      result: GitReviewSummaryServiceResult;
    }
> {
  const incomplete = {
    fileCount: args.files.length,
    additions: null,
    deletions: null,
    lineStatsComplete: false,
  } as const;
  const worktreeContents = new Map(
    args.observation.worktreeContents.map((snapshot) => [
      gitPathKey(snapshot.path),
      snapshot,
    ]),
  );
  const blobReads = new Map<
    string,
    Promise<Buffer | GitReviewFileServiceResult>
  >();
  let additions = 0;
  let deletions = 0;
  for (const file of args.files) {
    const [layer] = file.logicalEntry.layers;
    const [summaryLayer] = file.summary.layers;
    if (
      file.logicalEntry.layers.length !== 1 ||
      file.summary.layers.length !== 1 ||
      layer === undefined ||
      summaryLayer === undefined ||
      layer.comparison === 'conflict' ||
      gitReviewProjectionBlockReason({ layer, worktreeContents }) !== null ||
      gitReviewMetadataReason({
        beforeContentKind: summaryLayer.beforeContentKind,
        afterContentKind: summaryLayer.afterContentKind,
        beforeMode: layer.beforeMode,
        afterMode: layer.afterMode,
      }) !== null
    ) {
      return { ok: true, value: incomplete };
    }
    const before = await readGitReviewLayerSide({
      side: 'before',
      layer,
      worktreeContents,
      blobReads,
      hostCommands: args.hostCommands,
      stateRoot: args.stateRoot,
      repositoryRoot: args.observation.objectIndexSnapshot.repositoryRoot,
      pageLimitBytes: args.pageLimitBytes,
      maxOutputBytesPerStream: args.maxOutputBytesPerStream,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (!before.ok) {
      return {
        ok: false,
        result: projectFileFailureForSummaryTotals(before.result),
      };
    }
    const after = await readGitReviewLayerSide({
      side: 'after',
      layer,
      worktreeContents,
      blobReads,
      hostCommands: args.hostCommands,
      stateRoot: args.stateRoot,
      repositoryRoot: args.observation.objectIndexSnapshot.repositoryRoot,
      pageLimitBytes: args.pageLimitBytes,
      maxOutputBytesPerStream: args.maxOutputBytesPerStream,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (!after.ok) {
      return {
        ok: false,
        result: projectFileFailureForSummaryTotals(after.result),
      };
    }
    const beforeText = decodeGitReviewText(before.content);
    const afterText = decodeGitReviewText(after.content);
    if (beforeText === undefined || afterText === undefined) {
      return { ok: true, value: incomplete };
    }
    for (const operation of buildMyersLineOperations(
      beforeText.lines,
      afterText.lines,
    )) {
      if (operation.kind === 'addition') {
        additions += 1;
      } else if (operation.kind === 'deletion') {
        deletions += 1;
      }
    }
  }
  return {
    ok: true,
    value: {
      fileCount: args.files.length,
      additions,
      deletions,
      lineStatsComplete: true,
    },
  };
}

function projectFileFailureForSummaryTotals(
  result: GitReviewFileServiceResult,
): GitReviewSummaryServiceResult {
  if (result.kind === 'unavailable' && result.reason === 'resource_limit') {
    return { kind: 'unavailable', reason: 'resource_limit' };
  }
  if (result.kind === 'stale') {
    return { kind: 'stale', reason: 'observation_changed' };
  }
  throw new Error('Git review summary totals could not read captured content');
}

async function buildGitReviewFileProjection(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  pageLimitBytes: number;
  maxOutputBytesPerStream: number;
  observation: GitReviewObservationSnapshot;
  logicalEntry: GitLogicalEntry;
  summary: GitReviewSummaryServiceFile;
  createId: () => string;
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      sections: readonly GitReviewFileServiceSection[];
      rows: readonly GitReviewFileServiceRow[];
    }
  | {
      ok: false;
      result: GitReviewFileServiceResult;
    }
> {
  if (args.logicalEntry.layers.length !== args.summary.layers.length) {
    return {
      ok: false,
      result: { kind: 'stale', reason: 'observation_changed' },
    };
  }
  const worktreeContents = new Map(
    args.observation.worktreeContents.map((snapshot) => [
      gitPathKey(snapshot.path),
      snapshot,
    ]),
  );
  const blobReads = new Map<
    string,
    Promise<Buffer | GitReviewFileServiceResult>
  >();
  const sections: GitReviewFileServiceSection[] = [];
  const rows: GitReviewFileServiceRow[] = [];
  for (
    let layerIndex = 0;
    layerIndex < args.logicalEntry.layers.length;
    layerIndex += 1
  ) {
    const layer = args.logicalEntry.layers[layerIndex];
    const summaryLayer = args.summary.layers[layerIndex];
    if (layer === undefined || summaryLayer === undefined) {
      return {
        ok: false,
        result: { kind: 'stale', reason: 'observation_changed' },
      };
    }
    const sectionId = `git-section:${args.createId()}`;
    if (layer.comparison === 'conflict') {
      sections.push({
        sectionId,
        layerId: summaryLayer.layerId,
        comparison: 'conflict',
        projection: 'conflict',
        metadataReason: null,
      });
      rows.push({
        sectionId,
        kind: 'metadata',
        oldLine: null,
        newLine: null,
        content: `Unmerged Git index stages: ${
          layer.conflictStages.map(({ stage }) => String(stage)).join(', ') ||
          'none'
        }.`,
      });
      continue;
    }

    const projectionBlockReason = gitReviewProjectionBlockReason({
      layer,
      worktreeContents,
    });
    if (projectionBlockReason !== null) {
      sections.push({
        sectionId,
        layerId: summaryLayer.layerId,
        comparison: layer.comparison,
        projection: 'metadata_only',
        metadataReason: projectionBlockReason,
      });
      rows.push(
        projectGitReviewMetadataRow({
          sectionId,
          layer,
          reason: projectionBlockReason,
        }),
      );
      continue;
    }

    const metadataReason = gitReviewMetadataReason({
      beforeContentKind: summaryLayer.beforeContentKind,
      afterContentKind: summaryLayer.afterContentKind,
      beforeMode: layer.beforeMode,
      afterMode: layer.afterMode,
    });
    if (metadataReason !== null) {
      sections.push({
        sectionId,
        layerId: summaryLayer.layerId,
        comparison: layer.comparison,
        projection: 'metadata_only',
        metadataReason,
      });
      rows.push(
        projectGitReviewMetadataRow({
          sectionId,
          layer,
          reason: metadataReason,
        }),
      );
      continue;
    }

    const before = await readGitReviewLayerSide({
      side: 'before',
      layer,
      worktreeContents,
      blobReads,
      hostCommands: args.hostCommands,
      stateRoot: args.stateRoot,
      repositoryRoot: args.observation.objectIndexSnapshot.repositoryRoot,
      pageLimitBytes: args.pageLimitBytes,
      maxOutputBytesPerStream: args.maxOutputBytesPerStream,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (!before.ok) {
      return before;
    }
    const after = await readGitReviewLayerSide({
      side: 'after',
      layer,
      worktreeContents,
      blobReads,
      hostCommands: args.hostCommands,
      stateRoot: args.stateRoot,
      repositoryRoot: args.observation.objectIndexSnapshot.repositoryRoot,
      pageLimitBytes: args.pageLimitBytes,
      maxOutputBytesPerStream: args.maxOutputBytesPerStream,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (!after.ok) {
      return after;
    }
    const beforeText = decodeGitReviewText(before.content);
    const afterText = decodeGitReviewText(after.content);
    if (beforeText === undefined || afterText === undefined) {
      sections.push({
        sectionId,
        layerId: summaryLayer.layerId,
        comparison: layer.comparison,
        projection: 'metadata_only',
        metadataReason: 'binary',
      });
      rows.push(
        projectGitReviewMetadataRow({
          sectionId,
          layer,
          reason: 'binary',
        }),
      );
      continue;
    }
    sections.push({
      sectionId,
      layerId: summaryLayer.layerId,
      comparison: layer.comparison,
      projection: 'text',
      metadataReason: null,
    });
    rows.push(
      ...buildGitReviewDiffRows({
        sectionId,
        before: beforeText,
        after: afterText,
      }),
    );
  }
  return { ok: true, sections, rows };
}

async function readGitReviewLayerSide(args: {
  side: 'before' | 'after';
  layer: Exclude<GitLogicalLayerEntry, { comparison: 'conflict' }>;
  worktreeContents: ReadonlyMap<string, GitWorktreeContentSnapshot>;
  blobReads: Map<string, Promise<Buffer | GitReviewFileServiceResult>>;
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  repositoryRoot: string;
  pageLimitBytes: number;
  maxOutputBytesPerStream: number;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; content: Buffer }
  | { ok: false; result: GitReviewFileServiceResult }
> {
  const path =
    args.side === 'before' ? args.layer.beforePath : args.layer.afterPath;
  const objectId =
    args.side === 'before'
      ? args.layer.beforeObjectId
      : args.layer.afterObjectId;
  if (path === null) {
    return { ok: true, content: Buffer.alloc(0) };
  }
  const readsWorktree =
    args.side === 'after' &&
    (args.layer.comparison === 'unstaged' ||
      args.layer.comparison === 'untracked');
  if (readsWorktree) {
    const content = args.worktreeContents.get(
      gitPathKey(path),
    )?.canonicalContent;
    return content === undefined || content === null
      ? {
          ok: false,
          result: { kind: 'stale', reason: 'observation_changed' },
        }
      : { ok: true, content };
  }
  if (objectId === null) {
    return {
      ok: false,
      result: { kind: 'unavailable', reason: 'comparison_unsupported' },
    };
  }
  let read = args.blobReads.get(objectId);
  if (read === undefined) {
    read = readGitReviewBlob({
      hostCommands: args.hostCommands,
      stateRoot: args.stateRoot,
      repositoryRoot: args.repositoryRoot,
      objectId,
      pageLimitBytes: args.pageLimitBytes,
      maxOutputBytesPerStream: args.maxOutputBytesPerStream,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    args.blobReads.set(objectId, read);
  }
  const content = await read;
  return Buffer.isBuffer(content)
    ? { ok: true, content }
    : { ok: false, result: content };
}

function gitReviewProjectionBlockReason(args: {
  layer: Exclude<GitLogicalLayerEntry, { comparison: 'conflict' }>;
  worktreeContents: ReadonlyMap<string, GitWorktreeContentSnapshot>;
}): 'unsupported_content_transformation' | null {
  if (
    args.layer.afterPath === null ||
    (args.layer.comparison !== 'unstaged' &&
      args.layer.comparison !== 'untracked')
  ) {
    return null;
  }
  return (
    args.worktreeContents.get(gitPathKey(args.layer.afterPath))
      ?.projectionBlockReason ?? null
  );
}

async function readGitReviewBlob(args: {
  hostCommands: HostCommandRuntime;
  stateRoot: string;
  repositoryRoot: string;
  objectId: string;
  pageLimitBytes: number;
  maxOutputBytesPerStream: number;
  signal?: AbortSignal;
}): Promise<Buffer | GitReviewFileServiceResult> {
  const read = await readGitBlobObject(args);
  if (read.ok) {
    return read.content;
  }
  switch (read.reason) {
    case 'resource_limit':
      return { kind: 'unavailable', reason: 'resource_limit' };
    case 'observation_changed':
    case 'object_unavailable':
      return { kind: 'stale', reason: 'observation_changed' };
    case 'aborted':
    case 'bare_repository':
    case 'command_failed':
    case 'filtered_worktree_comparison_unsupported':
    case 'invalid_object_id':
    case 'invalid_output':
    case 'not_repository':
    case 'safe_worktree_read_unavailable':
    case 'unsupported_worktree_transformation':
      throw new Error(read.message);
  }
}

function gitReviewMetadataReason(args: {
  beforeContentKind: GitComparisonContentKind | null;
  afterContentKind: GitComparisonContentKind | null;
  beforeMode: string | null;
  afterMode: string | null;
}): 'binary' | 'symlink' | 'submodule' | 'special_file' | null {
  const kinds = [args.beforeContentKind, args.afterContentKind];
  if (kinds.includes('binary')) {
    return 'binary';
  }
  if (kinds.includes('symlink')) {
    return 'symlink';
  }
  if (kinds.includes('submodule')) {
    return 'submodule';
  }
  if (kinds.includes('special')) {
    return 'special_file';
  }
  return [args.beforeMode, args.afterMode]
    .filter((mode): mode is string => mode !== null)
    .some(
      (mode) =>
        mode !== '100644' &&
        mode !== '100755' &&
        mode !== '120000' &&
        mode !== '160000',
    )
    ? 'special_file'
    : null;
}

function projectGitReviewMetadataRow(args: {
  sectionId: string;
  layer: Exclude<GitLogicalLayerEntry, { comparison: 'conflict' }>;
  reason: string;
}): GitReviewFileServiceRow {
  const before =
    args.layer.beforePath === null
      ? '∅'
      : escapeGitReviewDisplayPath(args.layer.beforePath);
  const after =
    args.layer.afterPath === null
      ? '∅'
      : escapeGitReviewDisplayPath(args.layer.afterPath);
  return {
    sectionId: args.sectionId,
    kind: 'metadata',
    oldLine: null,
    newLine: null,
    content: `${args.layer.comparison} ${args.layer.state}: ${before} → ${after} (${args.reason})`,
  };
}

interface GitReviewText {
  lines: readonly string[];
  endsWithNewline: boolean;
}

function decodeGitReviewText(content: Buffer): GitReviewText | undefined {
  if (content.includes(0)) {
    return undefined;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
  if (text.length === 0) {
    return { lines: [], endsWithNewline: true };
  }
  const endsWithNewline = text.endsWith('\n');
  const body = endsWithNewline ? text.slice(0, -1) : text;
  return {
    lines: body.length === 0 ? [''] : body.split('\n'),
    endsWithNewline,
  };
}

type GitReviewLineOperation =
  | { kind: 'context'; content: string }
  | { kind: 'addition'; content: string }
  | { kind: 'deletion'; content: string };

export function buildGitReviewDiffRows(args: {
  sectionId: string;
  before: GitReviewText;
  after: GitReviewText;
}): readonly GitReviewFileServiceRow[] {
  const operations = buildMyersLineOperations(
    args.before.lines,
    args.after.lines,
  );
  const changeIndexes = operations.flatMap((operation, index) =>
    operation.kind === 'context' ? [] : [index],
  );
  if (changeIndexes.length === 0) {
    return [];
  }
  const ranges: { start: number; end: number }[] = [];
  for (const changeIndex of changeIndexes) {
    const start = Math.max(0, changeIndex - UNIFIED_DIFF_CONTEXT_LINES);
    const end = Math.min(
      operations.length,
      changeIndex + UNIFIED_DIFF_CONTEXT_LINES + 1,
    );
    const previous = ranges.at(-1);
    if (previous !== undefined && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const oldLineBefore = prefixLineCounts(operations, 'old');
  const newLineBefore = prefixLineCounts(operations, 'new');
  const rows: GitReviewFileServiceRow[] = [];
  for (const range of ranges) {
    const oldStart = oldLineBefore[range.start] ?? 0;
    const newStart = newLineBefore[range.start] ?? 0;
    const oldCount = (oldLineBefore[range.end] ?? oldStart) - oldStart;
    const newCount = (newLineBefore[range.end] ?? newStart) - newStart;
    rows.push({
      sectionId: args.sectionId,
      kind: 'hunk',
      oldLine: null,
      newLine: null,
      content: `@@ -${formatUnifiedRange(oldStart + 1, oldCount)} +${formatUnifiedRange(
        newStart + 1,
        newCount,
      )} @@`,
    });
    let oldLine = oldStart + 1;
    let newLine = newStart + 1;
    for (const operation of operations.slice(range.start, range.end)) {
      if (operation.kind === 'context') {
        rows.push({
          sectionId: args.sectionId,
          kind: 'context',
          oldLine,
          newLine,
          content: operation.content,
        });
        oldLine += 1;
        newLine += 1;
      } else if (operation.kind === 'deletion') {
        rows.push({
          sectionId: args.sectionId,
          kind: 'deletion',
          oldLine,
          newLine: null,
          content: operation.content,
        });
        oldLine += 1;
      } else {
        rows.push({
          sectionId: args.sectionId,
          kind: 'addition',
          oldLine: null,
          newLine,
          content: operation.content,
        });
        newLine += 1;
      }
    }
  }
  if (!args.before.endsWithNewline && args.before.lines.length > 0) {
    rows.push({
      sectionId: args.sectionId,
      kind: 'metadata',
      oldLine: null,
      newLine: null,
      content: '\\ No newline at end of before file',
    });
  }
  if (!args.after.endsWithNewline && args.after.lines.length > 0) {
    rows.push({
      sectionId: args.sectionId,
      kind: 'metadata',
      oldLine: null,
      newLine: null,
      content: '\\ No newline at end of after file',
    });
  }
  return rows;
}

function buildMyersLineOperations(
  before: readonly string[],
  after: readonly string[],
): GitReviewLineOperation[] {
  const maximumDistance = before.length + after.length;
  const frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const movesDown =
        diagonal === -distance ||
        (diagonal !== distance &&
          (frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY) <
            (frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY));
      let x = movesDown
        ? (frontier.get(diagonal + 1) ?? 0)
        : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      frontier.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        return backtrackMyersLineOperations(before, after, trace);
      }
    }
  }
  throw new Error('Myers line diff did not reach a terminal path');
}

function backtrackMyersLineOperations(
  before: readonly string[],
  after: readonly string[],
  trace: readonly ReadonlyMap<number, number>[],
): GitReviewLineOperation[] {
  let x = before.length;
  let y = after.length;
  const reversed: GitReviewLineOperation[] = [];
  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const frontier = trace[distance];
    if (frontier === undefined) {
      continue;
    }
    const diagonal = x - y;
    const movesDown =
      diagonal === -distance ||
      (diagonal !== distance &&
        (frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY) <
          (frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY));
    const previousDiagonal = movesDown ? diagonal + 1 : diagonal - 1;
    const previousX = frontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      const content = before[x - 1];
      if (content === undefined) {
        throw new Error('Myers line diff lost a context row');
      }
      reversed.push({ kind: 'context', content });
      x -= 1;
      y -= 1;
    }
    if (distance === 0) {
      break;
    }
    if (x === previousX) {
      const content = after[y - 1];
      if (content === undefined) {
        throw new Error('Myers line diff lost an addition row');
      }
      reversed.push({ kind: 'addition', content });
      y -= 1;
    } else {
      const content = before[x - 1];
      if (content === undefined) {
        throw new Error('Myers line diff lost a deletion row');
      }
      reversed.push({ kind: 'deletion', content });
      x -= 1;
    }
  }
  return reversed.reverse();
}

function prefixLineCounts(
  operations: readonly GitReviewLineOperation[],
  side: 'old' | 'new',
): number[] {
  const counts = [0];
  for (const operation of operations) {
    const contributes =
      operation.kind === 'context' ||
      (side === 'old'
        ? operation.kind === 'deletion'
        : operation.kind === 'addition');
    counts.push((counts.at(-1) ?? 0) + (contributes ? 1 : 0));
  }
  return counts;
}

function formatUnifiedRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${String(start)},${String(count)}`;
}

function projectChangedSummaryPage(args: {
  stored: StoredGitReviewSummary;
  offset: number;
  pageLimitBytes: number;
  cursorKey: Buffer;
}): GitReviewSummaryServiceResult {
  const page = pageSummaryFiles(
    args.stored.files,
    args.offset,
    args.pageLimitBytes,
  );
  const nextCursor =
    page.nextOffset === null
      ? null
      : encodeSummaryCursor(args.cursorKey, {
          kind: 'summary',
          observationId: args.stored.observationId,
          offset: page.nextOffset,
        });
  const objectIndexSnapshot = args.stored.observation.objectIndexSnapshot;
  return {
    kind: 'changed',
    observationId: args.stored.observationId,
    repositoryRoot: objectIndexSnapshot.repositoryRoot,
    branch: {
      name: objectIndexSnapshot.branch.name,
      detached: objectIndexSnapshot.branch.detached,
      headOid: objectIndexSnapshot.headObjectId,
    },
    totals: args.stored.totals,
    files: {
      items: page.items.map(({ summary }) => summary),
      nextCursor,
    },
    observedAt: args.stored.observedAt,
  };
}

function pageSummaryFiles(
  files: readonly StoredGitReviewFile[],
  offset: number,
  pageLimitBytes: number,
): {
  items: readonly StoredGitReviewFile[];
  nextOffset: number | null;
} {
  const items: StoredGitReviewFile[] = [];
  let usedBytes = 0;
  let nextOffset = offset;
  while (nextOffset < files.length) {
    const file = files[nextOffset];
    if (file === undefined) {
      break;
    }
    const itemBytes = Buffer.byteLength(JSON.stringify(file.summary), 'utf8');
    if (items.length > 0 && usedBytes + itemBytes > pageLimitBytes) {
      break;
    }
    items.push(file);
    usedBytes += itemBytes;
    nextOffset += 1;
  }
  return {
    items,
    nextOffset: nextOffset < files.length ? nextOffset : null,
  };
}

function projectGitReviewFileSummary(args: {
  fileId: string;
  logicalEntry: GitLogicalEntry;
  observation: GitReviewObservationSnapshot;
  createId: () => string;
}): GitReviewSummaryServiceFile {
  const worktreeContentKinds = new Map(
    args.observation.worktreeEntries.map((entry) => [
      gitPathKey(entry.path),
      entry.contentKind,
    ]),
  );
  const layers = args.logicalEntry.layers.map(
    (layer): GitReviewSummaryServiceLayer =>
      projectGitReviewLayerSummary({
        layer,
        layerId: `git-layer:${args.createId()}`,
        worktreeContentKinds,
      }),
  );
  return {
    fileId: args.fileId,
    displayPath: escapeGitReviewDisplayPath(args.logicalEntry.displayPath),
    layers,
    staged: layers.some((layer) => layer.comparison === 'staged'),
    unstaged: layers.some(
      (layer) =>
        layer.comparison === 'unstaged' || layer.comparison === 'untracked',
    ),
  };
}

function projectGitReviewLayerSummary(args: {
  layer: GitLogicalLayerEntry;
  layerId: string;
  worktreeContentKinds: ReadonlyMap<string, GitComparisonContentKind>;
}): GitReviewSummaryServiceLayer {
  const { layer } = args;
  const beforeContentKind =
    'beforeContentKind' in layer
      ? layer.beforeContentKind
      : contentKindForGitMode(layer.beforeMode);
  const afterContentKind =
    'afterContentKind' in layer
      ? layer.afterContentKind
      : layer.afterPath === null
        ? null
        : (args.worktreeContentKinds.get(gitPathKey(layer.afterPath)) ??
          contentKindForGitMode(layer.afterMode));
  return {
    layerId: args.layerId,
    comparison: layer.comparison,
    state: layer.state,
    beforeDisplayPath:
      layer.comparison === 'conflict' || layer.beforePath === null
        ? null
        : escapeGitReviewDisplayPath(layer.beforePath),
    afterDisplayPath:
      layer.afterPath === null
        ? null
        : escapeGitReviewDisplayPath(layer.afterPath),
    beforeContentKind:
      layer.comparison === 'conflict' ? null : beforeContentKind,
    afterContentKind,
  };
}

export function escapeGitReviewDisplayPath(path: Uint8Array): string {
  const bytes = Buffer.from(path);
  let escaped = '';
  for (let offset = 0; offset < bytes.length;) {
    const byte = bytes[offset];
    if (byte === undefined) {
      break;
    }
    if (byte < 0x80) {
      escaped += escapeAsciiPathByte(byte);
      offset += 1;
      continue;
    }
    const sequenceLength = utf8SequenceLength(byte);
    if (sequenceLength === 0 || offset + sequenceLength > bytes.length) {
      escaped += escapeHexByte(byte);
      offset += 1;
      continue;
    }
    const sequence = bytes.subarray(offset, offset + sequenceLength);
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(sequence);
    } catch {
      escaped += escapeHexByte(byte);
      offset += 1;
      continue;
    }
    if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(decoded)) {
      escaped += [...sequence].map(escapeHexByte).join('');
    } else {
      escaped += decoded;
    }
    offset += sequenceLength;
  }
  return escaped;
}

function escapeAsciiPathByte(byte: number): string {
  if (byte === 0x5c) {
    return '\\\\';
  }
  if (byte === 0x09) {
    return '\\t';
  }
  if (byte === 0x0a) {
    return '\\n';
  }
  if (byte === 0x0d) {
    return '\\r';
  }
  return byte >= 0x20 && byte <= 0x7e
    ? String.fromCharCode(byte)
    : escapeHexByte(byte);
}

function escapeHexByte(byte: number): string {
  return `\\x${byte.toString(16).padStart(2, '0')}`;
}

function utf8SequenceLength(firstByte: number): number {
  if (firstByte >= 0xc2 && firstByte <= 0xdf) {
    return 2;
  }
  if (firstByte >= 0xe0 && firstByte <= 0xef) {
    return 3;
  }
  if (firstByte >= 0xf0 && firstByte <= 0xf4) {
    return 4;
  }
  return 0;
}

function contentKindForGitMode(
  mode: string | null,
): GitComparisonContentKind | null {
  if (mode === null) {
    return null;
  }
  if (mode === '120000') {
    return 'symlink';
  }
  if (mode === '160000') {
    return 'submodule';
  }
  if (mode === '100644' || mode === '100755') {
    return 'unknown';
  }
  return 'unknown';
}

function gitPathKey(path: Uint8Array): string {
  return Buffer.from(path).toString('base64');
}

function projectReadyFilePage(args: {
  stored: StoredGitReviewFileObservation;
  offset: number;
  pageLimitBytes: number;
  cursorKey: Buffer;
}): GitReviewFileServiceResult {
  const page = pageGitReviewRows(
    args.stored.rows,
    args.offset,
    args.pageLimitBytes,
  );
  const nextCursor =
    page.nextOffset === null
      ? null
      : encodeFileCursor(args.cursorKey, {
          kind: 'file',
          observationId: args.stored.observationId,
          fileId: args.stored.fileId,
          fileObservationId: args.stored.fileObservationId,
          offset: page.nextOffset,
        });
  return {
    kind: 'ready',
    observationId: args.stored.observationId,
    fileObservationId: args.stored.fileObservationId,
    fileId: args.stored.fileId,
    sections: [...args.stored.sections],
    rows: {
      items: [...page.items],
      nextCursor,
    },
    capturedAt: args.stored.capturedAt,
  };
}

function pageGitReviewRows(
  rows: readonly GitReviewFileServiceRow[],
  offset: number,
  pageLimitBytes: number,
): {
  items: readonly GitReviewFileServiceRow[];
  nextOffset: number | null;
} {
  const items: GitReviewFileServiceRow[] = [];
  let usedBytes = 0;
  let nextOffset = offset;
  while (nextOffset < rows.length) {
    const row = rows[nextOffset];
    if (row === undefined) {
      break;
    }
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
    if (items.length > 0 && usedBytes + rowBytes > pageLimitBytes) {
      break;
    }
    items.push(row);
    usedBytes += rowBytes;
    nextOffset += 1;
  }
  return {
    items,
    nextOffset: nextOffset < rows.length ? nextOffset : null,
  };
}

function sameGitExactRenameProofs(
  left: GitLogicalEntry,
  right: GitLogicalEntry,
): boolean {
  return (
    left.exactRenameProofs.length === right.exactRenameProofs.length &&
    left.exactRenameProofs.every((proof, index) => {
      const peer = right.exactRenameProofs[index];
      return (
        peer !== undefined &&
        proof.comparison === peer.comparison &&
        proof.verification === peer.verification &&
        proof.beforePath.equals(peer.beforePath) &&
        proof.afterPath.equals(peer.afterPath) &&
        proof.beforeMode === peer.beforeMode &&
        proof.afterMode === peer.afterMode &&
        proof.beforeObjectId === peer.beforeObjectId &&
        proof.afterObjectId === peer.afterObjectId
      );
    })
  );
}

function encodeFileCursor(key: Buffer, payload: FileCursorPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  );
  const signed = `${FILE_CURSOR_PREFIX}.${encodedPayload}`;
  const signature = createHmac('sha256', key)
    .update(signed)
    .digest('base64url');
  return `${signed}.${signature}`;
}

function decodeFileCursor(
  key: Buffer,
  cursor: string,
): FileCursorPayload | undefined {
  const decoded = decodeSignedCursor(key, cursor, FILE_CURSOR_PREFIX);
  if (
    decoded === undefined ||
    Object.keys(decoded).length !== 5 ||
    decoded['kind'] !== 'file' ||
    typeof decoded['observationId'] !== 'string' ||
    decoded['observationId'].length === 0 ||
    typeof decoded['fileId'] !== 'string' ||
    decoded['fileId'].length === 0 ||
    typeof decoded['fileObservationId'] !== 'string' ||
    decoded['fileObservationId'].length === 0 ||
    typeof decoded['offset'] !== 'number' ||
    !Number.isSafeInteger(decoded['offset']) ||
    decoded['offset'] <= 0
  ) {
    return undefined;
  }
  return {
    kind: 'file',
    observationId: decoded['observationId'],
    fileId: decoded['fileId'],
    fileObservationId: decoded['fileObservationId'],
    offset: decoded['offset'],
  };
}

function encodeSummaryCursor(
  key: Buffer,
  payload: SummaryCursorPayload,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  );
  const signed = `${SUMMARY_CURSOR_PREFIX}.${encodedPayload}`;
  const signature = createHmac('sha256', key)
    .update(signed)
    .digest('base64url');
  return `${signed}.${signature}`;
}

function decodeSummaryCursor(
  key: Buffer,
  cursor: string,
): SummaryCursorPayload | undefined {
  const value = decodeSignedCursor(key, cursor, SUMMARY_CURSOR_PREFIX);
  if (
    value === undefined ||
    Object.keys(value).length !== 3 ||
    value['kind'] !== 'summary' ||
    typeof value['observationId'] !== 'string' ||
    value['observationId'].length === 0 ||
    typeof value['offset'] !== 'number' ||
    !Number.isSafeInteger(value['offset']) ||
    value['offset'] <= 0
  ) {
    return undefined;
  }
  return {
    kind: 'summary',
    observationId: value['observationId'],
    offset: value['offset'],
  };
}

function decodeSignedCursor(
  key: Buffer,
  cursor: string,
  expectedPrefix: string,
): Record<string, unknown> | undefined {
  const [prefix, encodedPayload, encodedSignature, extra] = cursor.split('.');
  if (
    prefix !== expectedPrefix ||
    encodedPayload === undefined ||
    encodedSignature === undefined ||
    extra !== undefined ||
    !BASE64URL_PATTERN.test(encodedPayload) ||
    !BASE64URL_PATTERN.test(encodedSignature)
  ) {
    return undefined;
  }
  const signed = `${prefix}.${encodedPayload}`;
  const expected = createHmac('sha256', key).update(signed).digest();
  const supplied = Buffer.from(encodedSignature, 'base64url');
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString());
  } catch {
    return undefined;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

async function resolveReviewWorkingDirectory(
  workingDirectory: string,
  coordinateBase: string | undefined,
): Promise<
  | { ok: true; path: string }
  | {
      ok: false;
      result: GitReviewSummaryServiceResult;
    }
> {
  if (!isAbsolute(workingDirectory) && coordinateBase === undefined) {
    return {
      ok: false,
      result: { kind: 'not_reviewable', reason: 'missing_directory' },
    };
  }
  const requestedPath =
    coordinateBase === undefined
      ? workingDirectory
      : resolve(coordinateBase, workingDirectory);
  try {
    const canonicalPath = await realpath(requestedPath);
    const metadata = await stat(canonicalPath);
    return metadata.isDirectory()
      ? { ok: true, path: canonicalPath }
      : {
          ok: false,
          result: { kind: 'not_reviewable', reason: 'missing_directory' },
        };
  } catch (error: unknown) {
    const code = readNodeErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        ok: false,
        result: { kind: 'not_reviewable', reason: 'missing_directory' },
      };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ok: false,
        result: {
          kind: 'not_reviewable',
          reason: 'repository_root_unreachable',
        },
      };
    }
    throw error;
  }
}

function projectGitReviewCaptureFailure(
  failure: Exclude<
    Awaited<ReturnType<typeof captureGitReviewObservation>>,
    { ok: true }
  >,
): GitReviewSummaryServiceResult {
  switch (failure.reason) {
    case 'not_repository':
    case 'bare_repository':
    case 'filtered_worktree_comparison_unsupported':
    case 'unsupported_worktree_transformation':
    case 'safe_worktree_read_unavailable':
      return { kind: 'not_reviewable', reason: failure.reason };
    case 'observation_changed':
      return { kind: 'stale', reason: 'observation_changed' };
    case 'resource_limit':
      return { kind: 'unavailable', reason: 'resource_limit' };
    case 'aborted':
    case 'command_failed':
    case 'invalid_object_id':
    case 'invalid_output':
    case 'object_unavailable':
      throw new Error(failure.message);
  }
}

function projectGitReviewFileCaptureFailure(
  failure: Exclude<
    Awaited<ReturnType<typeof captureGitReviewObservation>>,
    { ok: true }
  >,
): GitReviewFileServiceResult {
  switch (failure.reason) {
    case 'observation_changed':
      return { kind: 'stale', reason: 'observation_changed' };
    case 'resource_limit':
      return { kind: 'unavailable', reason: 'resource_limit' };
    case 'filtered_worktree_comparison_unsupported':
    case 'safe_worktree_read_unavailable':
    case 'unsupported_worktree_transformation':
      return { kind: 'unavailable', reason: 'comparison_unsupported' };
    case 'not_repository':
    case 'bare_repository':
      return { kind: 'stale', reason: 'observation_changed' };
    case 'aborted':
    case 'command_failed':
    case 'invalid_object_id':
    case 'invalid_output':
    case 'object_unavailable':
      throw new Error(failure.message);
  }
}

function readNodeErrorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
