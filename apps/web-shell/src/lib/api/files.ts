import {
  isComputerFileScopeResponse,
  isFileBinaryInputRefResponse,
  isFileReadResponse,
  isFileSaveResponse,
  isFileTreeResponse,
  type ComputerFileScopeResponse,
  type FileBinaryInputRefResponse,
  type FileReadResponse,
  type FileSaveResponse,
  type FileTreeResponse,
} from '@geulbat/protocol/files';
import {
  isConflictStaleWriteError,
  type ConflictStaleWriteError,
} from '@geulbat/protocol/errors';
import { getErrorMessage } from '@geulbat/shared-utils/error';
import { createLogger } from '@geulbat/shared-utils/logger';
import {
  ApiFetchError,
  apiFetch,
  apiFetchBlob,
  isApiOkResponse,
} from './client.js';

const logger = createLogger('api/files');

export type ComputerFileApiScope = { root: 'computer' };
export type FileApiScope = ComputerFileApiScope;
export const COMPUTER_FILE_API_SCOPE: ComputerFileApiScope = {
  root: 'computer',
};

export class FileSaveConflictError extends Error {
  readonly conflict: ConflictStaleWriteError;

  constructor(conflict: ConflictStaleWriteError) {
    super(conflict.message);
    this.name = 'FileSaveConflictError';
    this.conflict = conflict;
  }
}

export function getFileTree(
  scope: FileApiScope = COMPUTER_FILE_API_SCOPE,
  options?: { path?: string; depth?: number },
): Promise<FileTreeResponse> {
  const params = fileScopeSearchParams(scope);
  if (options?.path !== undefined) {
    params.set('path', options.path);
  }
  if (options?.depth !== undefined) {
    params.set('depth', String(options.depth));
  }
  return apiFetch(
    `/api/files/tree?${params.toString()}`,
    undefined,
    isFileTreeResponse,
  );
}

export function getComputerFileScope(): Promise<ComputerFileScopeResponse> {
  return apiFetch(
    '/api/files/computer-scope',
    undefined,
    isComputerFileScopeResponse,
  );
}

export function readFile(
  scope: FileApiScope,
  path: string,
): Promise<FileReadResponse> {
  const params = fileScopeSearchParams(scope);
  params.set('path', path);
  return apiFetch(
    `/api/files/read?${params.toString()}`,
    undefined,
    isFileReadResponse,
  );
}

export function saveFile(
  scope: FileApiScope,
  path: string,
  content: string,
  versionToken: string,
): Promise<FileSaveResponse> {
  return apiFetchWithSaveConflict(
    '/api/files/save',
    {
      method: 'POST',
      body: JSON.stringify({
        ...fileScopeBody(scope),
        path,
        content,
        versionToken,
      }),
    },
    isFileSaveResponse,
  );
}

export type ManageFileOperation = 'mkdir' | 'delete' | 'rename' | 'move';

interface ManageFileResponse {
  ok: true;
  operation: string;
  path: string;
  destination?: string;
}

function isManageFileResponse(value: unknown): value is ManageFileResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === true &&
    typeof (value as { operation?: unknown }).operation === 'string' &&
    typeof (value as { path?: unknown }).path === 'string'
  );
}

// user file ops shell input path — agent tool과 같은 daemon mutation chain 사용
export function manageFile(
  scope: FileApiScope,
  operation: ManageFileOperation,
  path: string,
  destination?: string,
): Promise<ManageFileResponse> {
  return apiFetch(
    '/api/files/manage',
    {
      method: 'POST',
      body: JSON.stringify({
        ...fileScopeBody(scope),
        operation,
        path,
        ...(destination !== undefined ? { destination } : {}),
      }),
    },
    isManageFileResponse,
  );
}

export async function saveBinaryFile(
  scope: FileApiScope,
  path: string,
  blob: Blob,
): Promise<FileSaveResponse> {
  const input = await uploadBinaryInputRef(scope, blob);
  const mimeType = blob.type.trim();
  try {
    return await apiFetch(
      '/api/files/save-binary',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...fileScopeBody(scope),
          path,
          contentRef: input.contentRef,
          mimeType,
        }),
      },
      isFileSaveResponse,
    );
  } catch (error: unknown) {
    await cleanupBinaryInputRefAfterFailure(scope, input.contentRef, error);
    throw error;
  }
}

// 어시스턴트 첨부 업로드 — 바이트를 binary-input ref로 스트리밍 업로드하고
// run 시작 요청에는 contentRef만 싣는다. 데몬이 run 시작 시 소비한다.
export async function uploadRunAttachmentBlob(blob: Blob): Promise<string> {
  const input = await uploadBinaryInputRef({ root: 'computer' }, blob);
  return input.contentRef;
}

// 전송 전에 첨부 칩을 제거했을 때의 뒷정리 — 실패해도 무해(고아 ref는
// 데몬이 미청구 상태로 남긴다)
export function deleteRunAttachmentBlob(contentRef: string): Promise<unknown> {
  return deleteBinaryInputRef({ root: 'computer' }, contentRef);
}

export async function replaceBinaryFile(
  scope: FileApiScope,
  path: string,
  blob: Blob,
  versionToken: string,
): Promise<FileSaveResponse> {
  if (versionToken.trim().length === 0) {
    throw new Error('versionToken is required');
  }
  const input = await uploadBinaryInputRef(scope, blob);
  const mimeType = blob.type.trim();
  try {
    return await apiFetchWithSaveConflict(
      '/api/files/replace-binary',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...fileScopeBody(scope),
          path,
          contentRef: input.contentRef,
          versionToken,
          mimeType,
        }),
      },
      isFileSaveResponse,
    );
  } catch (error: unknown) {
    await cleanupBinaryInputRefAfterFailure(scope, input.contentRef, error);
    throw error;
  }
}

function uploadBinaryInputRef(
  scope: FileApiScope,
  blob: Blob,
): Promise<FileBinaryInputRefResponse> {
  const contentType = blob.type.trim() || 'application/octet-stream';
  const params = fileScopeSearchParams(scope);
  return apiFetch(
    `/api/files/binary-inputs?${params.toString()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: blob,
    },
    isFileBinaryInputRefResponse,
  );
}

function deleteBinaryInputRef(
  scope: FileApiScope,
  contentRef: string,
): Promise<unknown> {
  const params = fileScopeSearchParams(scope);
  params.set('contentRef', contentRef);
  return apiFetch(
    `/api/files/binary-inputs?${params.toString()}`,
    {
      method: 'DELETE',
    },
    isApiOkResponse,
  );
}

async function cleanupBinaryInputRefAfterFailure(
  scope: FileApiScope,
  contentRef: string,
  originalError: unknown,
): Promise<void> {
  try {
    await deleteBinaryInputRef(scope, contentRef);
  } catch (cleanupError: unknown) {
    logger.warn('failed to delete uploaded binary input ref after failure:', {
      contentRef,
      originalError: getErrorMessage(originalError),
      cleanupError: getErrorMessage(cleanupError),
    });
  }
}

async function apiFetchWithSaveConflict(
  path: string,
  options: RequestInit,
  validate: (value: unknown) => value is FileSaveResponse,
): Promise<FileSaveResponse> {
  try {
    return await apiFetch(path, options, validate);
  } catch (error: unknown) {
    if (
      error instanceof ApiFetchError &&
      error.status === 409 &&
      isConflictStaleWriteError(error.bodyJson)
    ) {
      throw new FileSaveConflictError(error.bodyJson);
    }
    throw error;
  }
}

// 이미지 등 바이너리 미리보기 — JSON이 아니라 원본 바이트를 받는다
export async function fetchRawFileBlob(
  scope: FileApiScope,
  path: string,
): Promise<Blob> {
  const params = fileScopeSearchParams(scope);
  params.set('path', path);
  return apiFetchBlob(`/api/files/raw?${params.toString()}`);
}

// 미디어 태그(src)용 raw URL — HttpOnly 인증 쿠키가 같이 전송되고,
// 구간 탐색(Range)은 브라우저가 알아서 요청한다
export function rawFileUrl(scope: FileApiScope, path: string): string {
  const params = fileScopeSearchParams(scope);
  params.set('path', path);
  return `/api/files/raw?${params.toString()}`;
}

function fileScopeSearchParams(scope: FileApiScope): URLSearchParams {
  return new URLSearchParams({ root: scope.root });
}

function fileScopeBody(scope: FileApiScope): ComputerFileApiScope {
  return scope;
}
