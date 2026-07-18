import type {
  FileReadResponse,
  FileSaveResponse,
  FileTreeNode,
} from '@geulbat/protocol/files';
import {
  assertThreadId as assertProtocolThreadId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import {
  isArtifactRuntimePersistenceRenderer as isProtocolArtifactRuntimePersistenceRenderer,
  type ArtifactRuntimePersistenceRenderer,
  type ArtifactRuntimePersistenceScopeRequest,
} from '@geulbat/protocol/runtime-persistence';

export type {
  ArtifactRuntimePersistenceRenderer,
  ArtifactRuntimePersistenceScopeRequest,
  FileReadResponse,
  FileSaveResponse,
  FileTreeNode,
};

export function assertFileThreadId(threadId: string): ThreadId {
  return assertProtocolThreadId(threadId);
}

export function isFileRuntimePersistenceRenderer(
  value: unknown,
): value is ArtifactRuntimePersistenceRenderer {
  return isProtocolArtifactRuntimePersistenceRenderer(value);
}
