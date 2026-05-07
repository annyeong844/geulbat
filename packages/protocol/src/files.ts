import { isProjectId, type ProjectId } from './ids.js';
import { isBoolean, isNumber, isRecord, isString } from './runtime-utils.js';

/**
 * Deterministic content version token for one normalized workspace-relative path.
 * The daemon mints a new token whenever that path's persisted bytes change.
 * Clients must treat it as an opaque, path-scoped concurrency token.
 */
export type FileVersionToken = string;

export interface FileReadRequest {
  projectId: ProjectId;
  path: string;
}

export interface FileReadResponse {
  path: string;
  content: string;
  versionToken: FileVersionToken;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export interface FileSaveRequest {
  projectId: ProjectId;
  path: string;
  content: string;
  versionToken: FileVersionToken;
}

export interface FileSaveResponse {
  path: string;
  versionToken: FileVersionToken;
  totalLines: number;
  ok: true;
}

export interface FileTreeRequest {
  projectId: ProjectId;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

export interface FileTreeResponse {
  projectId: ProjectId;
  tree: FileTreeNode[];
}

export function isFileTreeNode(value: unknown): value is FileTreeNode {
  if (!isRecord(value)) {
    return false;
  }
  if (!isString(value.name) || !isString(value.path)) {
    return false;
  }
  if (value.type !== 'file' && value.type !== 'directory') {
    return false;
  }
  if (value.children === undefined) {
    return true;
  }
  return Array.isArray(value.children) && value.children.every(isFileTreeNode);
}

export function isFileTreeResponse(value: unknown): value is FileTreeResponse {
  return (
    isRecord(value) &&
    isString(value.projectId) &&
    isProjectId(value.projectId) &&
    Array.isArray(value.tree) &&
    value.tree.every(isFileTreeNode)
  );
}

export function isFileReadResponse(value: unknown): value is FileReadResponse {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isString(value.content) &&
    isString(value.versionToken) &&
    isNumber(value.totalLines) &&
    isNumber(value.startLine) &&
    isNumber(value.endLine) &&
    isBoolean(value.truncated)
  );
}

export function isFileSaveResponse(value: unknown): value is FileSaveResponse {
  return (
    isRecord(value) &&
    isString(value.path) &&
    isString(value.versionToken) &&
    isNumber(value.totalLines) &&
    value.ok === true
  );
}
