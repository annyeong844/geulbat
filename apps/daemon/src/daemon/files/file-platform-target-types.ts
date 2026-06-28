// Shared target contracts for the public file-platform facade and its target resolvers.
import type { ArtifactRuntimePersistenceScopeRequest } from './contract.js';

export type FilePlatformMode = 'read' | 'mutate' | 'enumerate' | 'persist';
type FilePlatformKind =
  | 'source'
  | 'derived'
  | 'runtime_state'
  | 'explicit_export';

interface FilePlatformBaseTarget {
  kind: FilePlatformKind;
  mode: FilePlatformMode;
  requestedRelativePath: string;
  relativePath: string;
  canonicalAbsolutePath: string;
  absolutePath: string;
  workspaceCanonicalRoot: string;
}

export interface SourceReadTarget extends FilePlatformBaseTarget {
  kind: 'source';
  mode: 'read';
}

export interface SourceMutationTarget extends FilePlatformBaseTarget {
  kind: 'source';
  mode: 'mutate';
  existingCanonicalAncestor: string;
  missingTailSegments: string[];
  versionedMutationRequired: boolean;
}

export interface SourceDirectoryTarget extends FilePlatformBaseTarget {
  kind: 'source';
  mode: 'enumerate';
  exists: boolean;
}

export type DerivedArtifactOwner = 'memory_index';

export interface DerivedArtifactTarget extends FilePlatformBaseTarget {
  kind: 'derived';
  mode: Exclude<FilePlatformMode, 'persist'>;
  owner: DerivedArtifactOwner;
  exists: boolean;
}

export interface RuntimeStateTarget extends FilePlatformBaseTarget {
  kind: 'runtime_state';
  mode: 'persist';
  scopeHandle: string;
  canonicalScopeKey: string;
  storageRoot: string;
  requestedScope: ArtifactRuntimePersistenceScopeRequest;
}

export interface ExplicitExportTarget extends Omit<
  SourceMutationTarget,
  'kind' | 'mode'
> {
  kind: 'explicit_export';
  mode: 'persist';
  targetRelativePath: string;
  canonicalTargetPath: string;
  userIntentSnapshotId: string;
}

export interface EnumeratedCanonicalChild {
  name: string;
  relativePath: string;
  canonicalAbsolutePath: string;
  type: 'file' | 'directory';
  viaSymlink: boolean;
}

export type CanonicalDirectoryTarget = Pick<
  FilePlatformBaseTarget,
  | 'kind'
  | 'mode'
  | 'relativePath'
  | 'canonicalAbsolutePath'
  | 'workspaceCanonicalRoot'
>;

export interface InspectedCanonicalWorkspacePath {
  workspaceCanonicalRoot: string;
  canonicalAbsolutePath: string;
  existingCanonicalAncestor: string;
  missingTailSegments: string[];
}
