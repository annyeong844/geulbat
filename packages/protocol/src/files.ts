import { isNumber, isRecord, isString } from './runtime-utils.js';

export interface ComputerFileBrowseShortcut {
  label: string;
  path: string;
}

export type ComputerFileRoot = 'computer';

export type ComputerFileScopeResponse =
  | { available: false }
  | {
      available: true;
      browseStartPath?: string;
      browseShortcuts: ComputerFileBrowseShortcut[];
    };

/**
 * Deterministic content version token for one normalized workspace-relative path.
 * The daemon mints a new token whenever that path's persisted bytes change.
 * Clients must treat it as an opaque, path-scoped concurrency token.
 */
export type FileVersionToken = string;

export interface FileReadRequest {
  root: ComputerFileRoot;
  path: string;
}

export interface FileReadResponse {
  path: string;
  content: string;
  versionToken: FileVersionToken;
  totalLines: number;
  startLine: number;
  endLine: number;
  // 오피스 문서(docx/xlsx/hwpx)에서 추출된 읽기 전용 텍스트임을 표시.
  // 이 값이 있으면 content는 원본이 아니라 추출본이며 저장할 수 없다.
  extractedDocument?: 'docx' | 'xlsx' | 'hwpx';
}

export interface FileSaveRequest {
  root: ComputerFileRoot;
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

export interface FileBinaryInputRefResponse {
  ok: true;
  contentRef: string;
  byteLength: number;
}

export interface FileTreeRequest {
  root: ComputerFileRoot;
}

export interface FileTreeFileNode {
  name: string;
  path: string;
  type: 'file';
}

export interface FileTreeDirectoryNode {
  name: string;
  path: string;
  type: 'directory';
  children?: FileTreeNode[];
}

export interface FileTreeTruncatedNode {
  name: string;
  path: string;
  type: 'truncated';
  message: string;
}

export type FileTreeNode =
  | FileTreeFileNode
  | FileTreeDirectoryNode
  | FileTreeTruncatedNode;

export interface FileTreeResponse {
  root: ComputerFileRoot;
  tree: FileTreeNode[];
}

export function isFileTreeNode(value: unknown): value is FileTreeNode {
  if (!isRecord(value)) {
    return false;
  }
  if (!isString(value.name) || !isString(value.path)) {
    return false;
  }
  if (value.type === 'truncated') {
    return isString(value.message) && value.children === undefined;
  }
  if (value.type !== 'file' && value.type !== 'directory') {
    return false;
  }
  if (value.children === undefined) {
    return true;
  }
  return Array.isArray(value.children) && value.children.every(isFileTreeNode);
}

export function isComputerFileScopeResponse(
  value: unknown,
): value is ComputerFileScopeResponse {
  if (!isRecord(value) || typeof value.available !== 'boolean') {
    return false;
  }
  if (!value.available) {
    return Object.keys(value).length === 1;
  }
  if (
    Object.keys(value).some(
      (key) =>
        key !== 'available' &&
        key !== 'browseStartPath' &&
        key !== 'browseShortcuts',
    )
  ) {
    return false;
  }
  return (
    (value.browseStartPath === undefined || isString(value.browseStartPath)) &&
    Array.isArray(value.browseShortcuts) &&
    value.browseShortcuts.every(
      (shortcut) =>
        isRecord(shortcut) &&
        isString(shortcut.label) &&
        isString(shortcut.path),
    )
  );
}

export function isFileTreeResponse(value: unknown): value is FileTreeResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.tree) ||
    !value.tree.every(isFileTreeNode)
  ) {
    return false;
  }
  return value.root === 'computer' && value.projectId === undefined;
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
    (value.extractedDocument === undefined ||
      value.extractedDocument === 'docx' ||
      value.extractedDocument === 'xlsx' ||
      value.extractedDocument === 'hwpx')
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

export function isFileBinaryInputRefResponse(
  value: unknown,
): value is FileBinaryInputRefResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isString(value.contentRef) &&
    isNumber(value.byteLength)
  );
}
