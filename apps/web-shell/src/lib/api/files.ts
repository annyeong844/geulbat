import {
  isFileBinaryInputRefResponse,
  isFileReadResponse,
  isFileSaveResponse,
  isFileTreeResponse,
  type FileBinaryInputRefResponse,
  type FileReadResponse,
  type FileSaveResponse,
  type FileTreeResponse,
} from '@geulbat/protocol/files';
import {
  isConflictStaleWriteError,
  type ConflictStaleWriteError,
} from '@geulbat/protocol/errors';
import { DEFAULT_PROJECT_ID } from '@geulbat/protocol/ids';
import { getErrorMessage } from '@geulbat/shared-utils/error';
import { createLogger } from '@geulbat/shared-utils/logger';
import { ApiFetchError, apiFetch, isApiOkResponse } from './client.js';

const logger = createLogger('api/files');

export class FileSaveConflictError extends Error {
  readonly conflict: ConflictStaleWriteError;

  constructor(conflict: ConflictStaleWriteError) {
    super(conflict.message);
    this.name = 'FileSaveConflictError';
    this.conflict = conflict;
  }
}

export function getFileTree(
  projectId = DEFAULT_PROJECT_ID,
): Promise<FileTreeResponse> {
  return apiFetch(
    `/api/files/tree?projectId=${encodeURIComponent(projectId)}`,
    undefined,
    isFileTreeResponse,
  );
}

export function readFile(
  projectId: string,
  path: string,
): Promise<FileReadResponse> {
  return apiFetch(
    `/api/files/read?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`,
    undefined,
    isFileReadResponse,
  );
}

export function saveFile(
  projectId: string,
  path: string,
  content: string,
  versionToken: string,
): Promise<FileSaveResponse> {
  return apiFetchWithSaveConflict(
    '/api/files/save',
    {
      method: 'POST',
      body: JSON.stringify({ projectId, path, content, versionToken }),
    },
    isFileSaveResponse,
  );
}

export async function saveBinaryFile(
  projectId: string,
  path: string,
  blob: Blob,
): Promise<FileSaveResponse> {
  const input = await uploadBinaryInputRef(projectId, blob);
  const mimeType = blob.type.trim();
  try {
    return await apiFetch(
      '/api/files/save-binary',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          path,
          contentRef: input.contentRef,
          mimeType,
        }),
      },
      isFileSaveResponse,
    );
  } catch (error: unknown) {
    await cleanupBinaryInputRefAfterFailure(projectId, input.contentRef, error);
    throw error;
  }
}

export async function replaceBinaryFile(
  projectId: string,
  path: string,
  blob: Blob,
  versionToken: string,
): Promise<FileSaveResponse> {
  if (versionToken.trim().length === 0) {
    throw new Error('versionToken is required');
  }
  const input = await uploadBinaryInputRef(projectId, blob);
  const mimeType = blob.type.trim();
  try {
    return await apiFetchWithSaveConflict(
      '/api/files/replace-binary',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          path,
          contentRef: input.contentRef,
          versionToken,
          mimeType,
        }),
      },
      isFileSaveResponse,
    );
  } catch (error: unknown) {
    await cleanupBinaryInputRefAfterFailure(projectId, input.contentRef, error);
    throw error;
  }
}

function uploadBinaryInputRef(
  projectId: string,
  blob: Blob,
): Promise<FileBinaryInputRefResponse> {
  const contentType = blob.type.trim() || 'application/octet-stream';
  return apiFetch(
    `/api/files/binary-inputs?projectId=${encodeURIComponent(projectId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: blob,
    },
    isFileBinaryInputRefResponse,
  );
}

function deleteBinaryInputRef(
  projectId: string,
  contentRef: string,
): Promise<unknown> {
  return apiFetch(
    `/api/files/binary-inputs?projectId=${encodeURIComponent(projectId)}&contentRef=${encodeURIComponent(contentRef)}`,
    {
      method: 'DELETE',
    },
    isApiOkResponse,
  );
}

async function cleanupBinaryInputRefAfterFailure(
  projectId: string,
  contentRef: string,
  originalError: unknown,
): Promise<void> {
  try {
    await deleteBinaryInputRef(projectId, contentRef);
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
