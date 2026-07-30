import { createHash } from 'node:crypto';

import {
  gitModeClass,
  gitPathKey,
  type GitObjectIndexSnapshot,
} from './git-inspection-command.js';
import {
  gitModeContentKind,
  type GitComparisonContentKind,
  type GitWorktreeComparisonEntry,
} from './git-worktree-capture.js';

type GitTreeSnapshotEntry = GitObjectIndexSnapshot['headEntries'][number];
type GitIndexSnapshotEntry = GitObjectIndexSnapshot['indexEntries'][number];
type GitConflictIndexSnapshotEntry = GitIndexSnapshotEntry & {
  stage: 1 | 2 | 3;
};

export interface GitStagedLayerEntry {
  comparison: 'staged' | 'conflict';
  state:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'type_changed'
    | 'conflicted';
  beforePath: Buffer | null;
  afterPath: Buffer | null;
  beforeMode: string | null;
  afterMode: string | null;
  beforeObjectId: string | null;
  afterObjectId: string | null;
  conflictStages: readonly {
    stage: 1 | 2 | 3;
    mode: string;
    objectId: string;
  }[];
}

export interface GitUnstagedLayerEntry {
  comparison: 'unstaged' | 'untracked';
  state: 'modified' | 'deleted' | 'renamed' | 'type_changed' | 'untracked';
  beforePath: Buffer | null;
  afterPath: Buffer | null;
  beforeMode: string | null;
  afterMode: string | null;
  beforeObjectId: string | null;
  afterObjectId: string | null;
  beforeContentKind: GitComparisonContentKind | null;
  afterContentKind: GitComparisonContentKind | null;
}

export type GitLogicalLayerEntry = GitStagedLayerEntry | GitUnstagedLayerEntry;

export interface GitExactRenameProof {
  comparison: 'staged' | 'unstaged';
  verification: 'object_identity' | 'canonical_byte_equality';
  beforePath: Buffer;
  afterPath: Buffer;
  beforeMode: string;
  afterMode: string;
  beforeObjectId: string;
  afterObjectId: string;
}

export interface GitLogicalEntry {
  displayPath: Buffer;
  paths: readonly Buffer[];
  layers: readonly GitLogicalLayerEntry[];
  exactRenameProofs: readonly GitExactRenameProof[];
  structuralIdentity: `sha256:${string}`;
}

export function buildGitStagedLayerEntries(
  snapshot: GitObjectIndexSnapshot,
): readonly GitStagedLayerEntry[] {
  const headByPath = new Map(
    snapshot.headEntries.map((entry) => [gitPathKey(entry.path), entry]),
  );
  const stageZeroByPath = new Map<string, GitIndexSnapshotEntry>();
  const conflictsByPath = new Map<string, GitConflictIndexSnapshotEntry[]>();
  for (const entry of snapshot.indexEntries) {
    const key = gitPathKey(entry.path);
    if (!isGitConflictIndexSnapshotEntry(entry)) {
      stageZeroByPath.set(key, entry);
      continue;
    }
    const conflict = conflictsByPath.get(key) ?? [];
    conflict.push(entry);
    conflictsByPath.set(key, conflict);
  }

  const direct: GitStagedLayerEntry[] = [];
  const added: GitStagedLayerEntry[] = [];
  const deleted: GitStagedLayerEntry[] = [];
  for (const [key, entries] of conflictsByPath) {
    const path = entries[0]?.path;
    if (path === undefined) {
      continue;
    }
    headByPath.delete(key);
    stageZeroByPath.delete(key);
    direct.push({
      comparison: 'conflict',
      state: 'conflicted',
      beforePath: null,
      afterPath: Buffer.from(path),
      beforeMode: null,
      afterMode: null,
      beforeObjectId: null,
      afterObjectId: null,
      conflictStages: [...entries]
        .sort((left, right) => left.stage - right.stage)
        .map((entry) => ({
          stage: entry.stage,
          mode: entry.mode,
          objectId: entry.objectId,
        })),
    });
  }

  for (const [key, indexEntry] of stageZeroByPath) {
    const headEntry = headByPath.get(key);
    if (headEntry === undefined) {
      added.push(stagedAdded(indexEntry));
      continue;
    }
    headByPath.delete(key);
    if (
      headEntry.mode === indexEntry.mode &&
      headEntry.objectId === indexEntry.objectId
    ) {
      continue;
    }
    direct.push({
      comparison: 'staged',
      state:
        gitModeClass(headEntry.mode) === gitModeClass(indexEntry.mode)
          ? 'modified'
          : 'type_changed',
      beforePath: Buffer.from(headEntry.path),
      afterPath: Buffer.from(indexEntry.path),
      beforeMode: headEntry.mode,
      afterMode: indexEntry.mode,
      beforeObjectId: headEntry.objectId,
      afterObjectId: indexEntry.objectId,
      conflictStages: [],
    });
  }
  for (const headEntry of headByPath.values()) {
    deleted.push(stagedDeleted(headEntry));
  }

  const consumedAdded = new Set<GitStagedLayerEntry>();
  const consumedDeleted = new Set<GitStagedLayerEntry>();
  const addedByIdentity = groupStagedCandidatesByIdentity(added, 'after');
  const deletedByIdentity = groupStagedCandidatesByIdentity(deleted, 'before');
  for (const [identity, addedCandidates] of addedByIdentity) {
    const deletedCandidates = deletedByIdentity.get(identity);
    if (addedCandidates.length !== 1 || deletedCandidates?.length !== 1) {
      continue;
    }
    const [addedCandidate] = addedCandidates;
    const [deletedCandidate] = deletedCandidates;
    if (addedCandidate === undefined || deletedCandidate === undefined) {
      continue;
    }
    consumedAdded.add(addedCandidate);
    consumedDeleted.add(deletedCandidate);
    direct.push({
      comparison: 'staged',
      state: 'renamed',
      beforePath: deletedCandidate.beforePath,
      afterPath: addedCandidate.afterPath,
      beforeMode: deletedCandidate.beforeMode,
      afterMode: addedCandidate.afterMode,
      beforeObjectId: deletedCandidate.beforeObjectId,
      afterObjectId: addedCandidate.afterObjectId,
      conflictStages: [],
    });
  }

  return [
    ...direct,
    ...added.filter((entry) => !consumedAdded.has(entry)),
    ...deleted.filter((entry) => !consumedDeleted.has(entry)),
  ].sort(compareGitStagedLayers);
}

export function buildGitUnstagedLayerEntries(
  snapshot: GitObjectIndexSnapshot,
  worktreeEntries: readonly GitWorktreeComparisonEntry[],
): readonly GitUnstagedLayerEntry[] {
  const indexByPath = new Map<string, GitIndexSnapshotEntry>();
  const conflictPaths = new Set<string>();
  for (const entry of snapshot.indexEntries) {
    const key = gitPathKey(entry.path);
    if (entry.stage === 0) {
      indexByPath.set(key, entry);
    } else {
      conflictPaths.add(key);
    }
  }

  const worktreeByPath = new Map<string, GitWorktreeComparisonEntry>();
  const verifiedRenamePaths = new Set<string>();
  for (const entry of worktreeEntries) {
    const key = gitPathKey(entry.path);
    if (worktreeByPath.has(key)) {
      throw new Error(
        'Git worktree comparison entries contain a duplicate path',
      );
    }
    worktreeByPath.set(key, entry);
    if (entry.exactRenameIdentityVerified) {
      verifiedRenamePaths.add(key);
    }
  }
  for (const path of conflictPaths) {
    indexByPath.delete(path);
    worktreeByPath.delete(path);
  }

  const layers: GitUnstagedLayerEntry[] = [];
  for (const [key, indexEntry] of indexByPath) {
    const worktreeEntry = worktreeByPath.get(key);
    if (worktreeEntry === undefined) {
      layers.push({
        comparison: 'unstaged',
        state: 'deleted',
        beforePath: Buffer.from(indexEntry.path),
        afterPath: null,
        beforeMode: indexEntry.mode,
        afterMode: null,
        beforeObjectId: indexEntry.objectId,
        afterObjectId: null,
        beforeContentKind: gitModeContentKind(indexEntry.mode),
        afterContentKind: null,
      });
      continue;
    }
    worktreeByPath.delete(key);
    if (
      indexEntry.mode === worktreeEntry.mode &&
      worktreeEntry.objectId !== null &&
      indexEntry.objectId === worktreeEntry.objectId
    ) {
      continue;
    }
    layers.push({
      comparison: 'unstaged',
      state:
        gitModeClass(indexEntry.mode) === gitModeClass(worktreeEntry.mode)
          ? 'modified'
          : 'type_changed',
      beforePath: Buffer.from(indexEntry.path),
      afterPath: Buffer.from(worktreeEntry.path),
      beforeMode: indexEntry.mode,
      afterMode: worktreeEntry.mode,
      beforeObjectId: indexEntry.objectId,
      afterObjectId: worktreeEntry.objectId,
      beforeContentKind: gitModeContentKind(indexEntry.mode),
      afterContentKind: worktreeEntry.contentKind,
    });
  }
  for (const worktreeEntry of worktreeByPath.values()) {
    layers.push({
      comparison: 'untracked',
      state: 'untracked',
      beforePath: null,
      afterPath: Buffer.from(worktreeEntry.path),
      beforeMode: null,
      afterMode: worktreeEntry.mode,
      beforeObjectId: null,
      afterObjectId: worktreeEntry.objectId,
      beforeContentKind: null,
      afterContentKind: worktreeEntry.contentKind,
    });
  }
  const deleted = layers.filter(
    (entry) => entry.comparison === 'unstaged' && entry.state === 'deleted',
  );
  const untracked = layers.filter((entry) => entry.comparison === 'untracked');
  const retained = layers.filter(
    (entry) =>
      !(entry.comparison === 'unstaged' && entry.state === 'deleted') &&
      entry.comparison !== 'untracked',
  );
  const deletedByIdentity = groupGitUnstagedCandidatesByIdentity(
    deleted,
    'before',
  );
  const untrackedByIdentity = groupGitUnstagedCandidatesByIdentity(
    untracked,
    'after',
    verifiedRenamePaths,
  );
  const consumedDeleted = new Set<GitUnstagedLayerEntry>();
  const consumedUntracked = new Set<GitUnstagedLayerEntry>();
  for (const [identity, untrackedCandidates] of untrackedByIdentity) {
    const deletedCandidates = deletedByIdentity.get(identity);
    if (untrackedCandidates.length !== 1 || deletedCandidates?.length !== 1) {
      continue;
    }
    const [untrackedCandidate] = untrackedCandidates;
    const [deletedCandidate] = deletedCandidates;
    if (untrackedCandidate === undefined || deletedCandidate === undefined) {
      continue;
    }
    consumedDeleted.add(deletedCandidate);
    consumedUntracked.add(untrackedCandidate);
    retained.push({
      comparison: 'unstaged',
      state: 'renamed',
      beforePath: deletedCandidate.beforePath,
      afterPath: untrackedCandidate.afterPath,
      beforeMode: deletedCandidate.beforeMode,
      afterMode: untrackedCandidate.afterMode,
      beforeObjectId: deletedCandidate.beforeObjectId,
      afterObjectId: untrackedCandidate.afterObjectId,
      beforeContentKind: deletedCandidate.beforeContentKind,
      afterContentKind: untrackedCandidate.afterContentKind,
    });
  }
  return [
    ...retained,
    ...deleted.filter((entry) => !consumedDeleted.has(entry)),
    ...untracked.filter((entry) => !consumedUntracked.has(entry)),
  ].sort(compareGitUnstagedLayers);
}

export function buildGitLogicalEntries(
  stagedLayers: readonly GitStagedLayerEntry[],
  unstagedLayers: readonly GitUnstagedLayerEntry[],
): readonly GitLogicalEntry[] {
  const conflictEntries = stagedLayers
    .filter((layer) => layer.comparison === 'conflict')
    .map((layer) => createGitLogicalEntry([layer]));
  const layers: GitLogicalLayerEntry[] = [
    ...stagedLayers.filter((layer) => layer.comparison !== 'conflict'),
    ...unstagedLayers,
  ];
  const pathByKey = new Map<string, Buffer>();
  const parentByKey = new Map<string, string>();
  const ensurePath = (path: Buffer): string => {
    const key = gitPathKey(path);
    if (!parentByKey.has(key)) {
      parentByKey.set(key, key);
      pathByKey.set(key, Buffer.from(path));
    }
    return key;
  };
  const findRoot = (key: string): string => {
    let root = key;
    for (;;) {
      const parent = parentByKey.get(root);
      if (parent === undefined || parent === root) {
        break;
      }
      root = parent;
    }
    let current = key;
    while (current !== root) {
      const parent = parentByKey.get(current);
      if (parent === undefined) {
        break;
      }
      parentByKey.set(current, root);
      current = parent;
    }
    return root;
  };
  const unionPaths = (left: string, right: string): void => {
    const leftRoot = findRoot(left);
    const rightRoot = findRoot(right);
    if (leftRoot === rightRoot) {
      return;
    }
    const [parent, child] =
      Buffer.compare(
        pathByKey.get(leftRoot) ?? Buffer.alloc(0),
        pathByKey.get(rightRoot) ?? Buffer.alloc(0),
      ) <= 0
        ? [leftRoot, rightRoot]
        : [rightRoot, leftRoot];
    parentByKey.set(child, parent);
  };

  for (const layer of layers) {
    const beforeKey =
      layer.beforePath === null ? null : ensurePath(layer.beforePath);
    const afterKey =
      layer.afterPath === null ? null : ensurePath(layer.afterPath);
    if (beforeKey !== null && afterKey !== null) {
      unionPaths(beforeKey, afterKey);
    }
  }

  const layersByRoot = new Map<string, GitLogicalLayerEntry[]>();
  for (const layer of layers) {
    const path = layer.afterPath ?? layer.beforePath;
    if (path === null) {
      throw new Error('Git logical layer has no before or after path');
    }
    const root = findRoot(gitPathKey(path));
    const componentLayers = layersByRoot.get(root) ?? [];
    componentLayers.push(layer);
    layersByRoot.set(root, componentLayers);
  }

  return [
    ...conflictEntries,
    ...[...layersByRoot.values()].map((componentLayers) =>
      createGitLogicalEntry(componentLayers),
    ),
  ].sort((left, right) => Buffer.compare(left.displayPath, right.displayPath));
}

function isGitConflictIndexSnapshotEntry(
  entry: GitIndexSnapshotEntry,
): entry is GitConflictIndexSnapshotEntry {
  return entry.stage !== 0;
}

function stagedAdded(entry: GitIndexSnapshotEntry): GitStagedLayerEntry {
  return {
    comparison: 'staged',
    state: 'added',
    beforePath: null,
    afterPath: Buffer.from(entry.path),
    beforeMode: null,
    afterMode: entry.mode,
    beforeObjectId: null,
    afterObjectId: entry.objectId,
    conflictStages: [],
  };
}

function stagedDeleted(entry: GitTreeSnapshotEntry): GitStagedLayerEntry {
  return {
    comparison: 'staged',
    state: 'deleted',
    beforePath: Buffer.from(entry.path),
    afterPath: null,
    beforeMode: entry.mode,
    afterMode: null,
    beforeObjectId: entry.objectId,
    afterObjectId: null,
    conflictStages: [],
  };
}

function groupStagedCandidatesByIdentity(
  entries: readonly GitStagedLayerEntry[],
  side: 'before' | 'after',
): Map<string, GitStagedLayerEntry[]> {
  const grouped = new Map<string, GitStagedLayerEntry[]>();
  for (const entry of entries) {
    const mode = side === 'before' ? entry.beforeMode : entry.afterMode;
    const objectId =
      side === 'before' ? entry.beforeObjectId : entry.afterObjectId;
    if (mode === null || objectId === null) {
      continue;
    }
    const modeClass = gitModeClass(mode);
    if (modeClass === 'unknown') {
      continue;
    }
    const key = `${modeClass}:${objectId}`;
    const candidates = grouped.get(key) ?? [];
    candidates.push(entry);
    grouped.set(key, candidates);
  }
  return grouped;
}

function groupGitUnstagedCandidatesByIdentity(
  entries: readonly GitUnstagedLayerEntry[],
  side: 'before' | 'after',
  verifiedRenamePaths: ReadonlySet<string> = new Set(),
): Map<string, GitUnstagedLayerEntry[]> {
  const grouped = new Map<string, GitUnstagedLayerEntry[]>();
  for (const entry of entries) {
    const path = side === 'before' ? entry.beforePath : entry.afterPath;
    if (
      side === 'after' &&
      (path === null || !verifiedRenamePaths.has(gitPathKey(path)))
    ) {
      continue;
    }
    const mode = side === 'before' ? entry.beforeMode : entry.afterMode;
    const objectId =
      side === 'before' ? entry.beforeObjectId : entry.afterObjectId;
    if (mode === null || objectId === null) {
      continue;
    }
    const modeClass = gitModeClass(mode);
    if (modeClass === 'unknown') {
      continue;
    }
    const key = `${modeClass}:${objectId}`;
    const candidates = grouped.get(key) ?? [];
    candidates.push(entry);
    grouped.set(key, candidates);
  }
  return grouped;
}

function compareGitStagedLayers(
  left: GitStagedLayerEntry,
  right: GitStagedLayerEntry,
): number {
  const leftPath = left.afterPath ?? left.beforePath ?? Buffer.alloc(0);
  const rightPath = right.afterPath ?? right.beforePath ?? Buffer.alloc(0);
  return Buffer.compare(leftPath, rightPath);
}

function compareGitUnstagedLayers(
  left: GitUnstagedLayerEntry,
  right: GitUnstagedLayerEntry,
): number {
  const leftPath = left.afterPath ?? left.beforePath ?? Buffer.alloc(0);
  const rightPath = right.afterPath ?? right.beforePath ?? Buffer.alloc(0);
  return Buffer.compare(leftPath, rightPath);
}

function createGitLogicalEntry(
  sourceLayers: readonly GitLogicalLayerEntry[],
): GitLogicalEntry {
  if (sourceLayers.length === 0) {
    throw new Error('Git logical entry requires at least one layer');
  }
  const layers = [...sourceLayers].sort(compareGitLogicalLayers);
  const pathByKey = new Map<string, Buffer>();
  const livePaths = new Set<string>();
  for (const layer of layers) {
    for (const path of [layer.beforePath, layer.afterPath]) {
      if (path !== null) {
        pathByKey.set(gitPathKey(path), Buffer.from(path));
      }
    }
    if (layer.beforePath !== null) {
      livePaths.add(gitPathKey(layer.beforePath));
    }
  }

  const survivingAfterCandidates: Buffer[] = [];
  let lastDeletedPath: Buffer | null = null;
  for (const layer of layers) {
    if (layer.beforePath !== null) {
      livePaths.delete(gitPathKey(layer.beforePath));
    }
    if (layer.afterPath === null) {
      if (layer.beforePath !== null) {
        lastDeletedPath = Buffer.from(layer.beforePath);
      }
    } else {
      livePaths.add(gitPathKey(layer.afterPath));
      survivingAfterCandidates.push(Buffer.from(layer.afterPath));
    }
  }
  let displayPath: Buffer | null | undefined;
  for (let index = survivingAfterCandidates.length - 1; index >= 0; index--) {
    const candidate = survivingAfterCandidates[index];
    if (candidate !== undefined && livePaths.has(gitPathKey(candidate))) {
      displayPath = candidate;
      break;
    }
  }
  displayPath ??=
    lastDeletedPath ??
    [...pathByKey.values()].sort((left, right) =>
      Buffer.compare(left, right),
    )[0];
  if (displayPath === undefined) {
    throw new Error('Git logical entry has no display path');
  }

  const exactRenameProofs = layers
    .filter((layer) => layer.state === 'renamed')
    .map((layer): GitExactRenameProof => {
      if (
        layer.comparison === 'conflict' ||
        layer.comparison === 'untracked' ||
        layer.beforePath === null ||
        layer.afterPath === null ||
        layer.beforeMode === null ||
        layer.afterMode === null ||
        layer.beforeObjectId === null ||
        layer.afterObjectId === null
      ) {
        throw new Error('Git exact rename layer is missing proof inputs');
      }
      return {
        comparison: layer.comparison,
        verification:
          layer.comparison === 'staged'
            ? 'object_identity'
            : 'canonical_byte_equality',
        beforePath: Buffer.from(layer.beforePath),
        afterPath: Buffer.from(layer.afterPath),
        beforeMode: layer.beforeMode,
        afterMode: layer.afterMode,
        beforeObjectId: layer.beforeObjectId,
        afterObjectId: layer.afterObjectId,
      };
    });
  const paths = [...pathByKey.values()].sort((left, right) =>
    Buffer.compare(left, right),
  );
  const structuralIdentityPayload = layers.map((layer) => ({
    comparison: layer.comparison,
    state: layer.state,
    beforePath: layer.beforePath?.toString('base64') ?? null,
    afterPath: layer.afterPath?.toString('base64') ?? null,
    beforeMode: layer.beforeMode,
    afterMode: layer.afterMode,
    beforeContentKind:
      'beforeContentKind' in layer ? layer.beforeContentKind : null,
    afterContentKind:
      'afterContentKind' in layer ? layer.afterContentKind : null,
    conflictStages:
      'conflictStages' in layer
        ? layer.conflictStages.map(({ stage, mode }) => ({ stage, mode }))
        : [],
  }));
  return {
    displayPath: Buffer.from(displayPath),
    paths,
    layers,
    exactRenameProofs,
    structuralIdentity: `sha256:${createHash('sha256')
      .update(JSON.stringify(structuralIdentityPayload))
      .digest('hex')}`,
  };
}

function compareGitLogicalLayers(
  left: GitLogicalLayerEntry,
  right: GitLogicalLayerEntry,
): number {
  const rankDifference =
    gitLogicalLayerRank(left.comparison) -
    gitLogicalLayerRank(right.comparison);
  if (rankDifference !== 0) {
    return rankDifference;
  }
  const leftPath = left.afterPath ?? left.beforePath ?? Buffer.alloc(0);
  const rightPath = right.afterPath ?? right.beforePath ?? Buffer.alloc(0);
  return Buffer.compare(leftPath, rightPath);
}

function gitLogicalLayerRank(
  comparison: GitLogicalLayerEntry['comparison'],
): number {
  switch (comparison) {
    case 'staged':
    case 'conflict':
      return 0;
    case 'unstaged':
      return 1;
    case 'untracked':
      return 2;
  }
}
