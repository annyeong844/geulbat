import type {
  FileReadResponse,
  FileSaveResponse,
  FileTreeNode,
} from '@geulbat/protocol/files';
import {
  DEFAULT_PROJECT_ID as PROTOCOL_DEFAULT_PROJECT_ID,
  assertProjectId as assertProtocolProjectId,
  assertThreadId as assertProtocolThreadId,
  isProjectId as isProtocolProjectId,
  type ProjectId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import {
  getDefaultProjectDeleteConflictMessage as getProtocolDefaultProjectDeleteConflictMessage,
  getDefaultProjectRenameConflictMessage as getProtocolDefaultProjectRenameConflictMessage,
  type ProjectListItem,
  type ProjectMutationResponse,
} from '@geulbat/protocol/projects';
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
  ProjectId,
  ProjectListItem,
  ProjectMutationResponse,
  ThreadId,
};

export const DEFAULT_FILE_PROJECT_ID = PROTOCOL_DEFAULT_PROJECT_ID;

export function assertFileProjectId(projectId: string): ProjectId {
  return assertProtocolProjectId(projectId);
}

export function assertFileThreadId(threadId: string): ThreadId {
  return assertProtocolThreadId(threadId);
}

export function isFileProjectId(projectId: string): projectId is ProjectId {
  return isProtocolProjectId(projectId);
}

export function isFileRuntimePersistenceRenderer(
  value: unknown,
): value is ArtifactRuntimePersistenceRenderer {
  return isProtocolArtifactRuntimePersistenceRenderer(value);
}

export function getFilesDefaultProjectRenameConflictMessage(): string {
  return getProtocolDefaultProjectRenameConflictMessage();
}

export function getFilesDefaultProjectDeleteConflictMessage(): string {
  return getProtocolDefaultProjectDeleteConflictMessage();
}
