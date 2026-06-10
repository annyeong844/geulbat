import {
  isFileReadResponse,
  isFileSaveResponse,
  isFileTreeResponse,
  type FileReadResponse,
  type FileSaveResponse,
  type FileTreeResponse,
} from '@geulbat/protocol/files';
import {
  isConflictStaleWriteError,
  type ConflictStaleWriteError,
} from '@geulbat/protocol/errors';
import { DEFAULT_PROJECT_ID } from '@geulbat/protocol/ids';
import { ApiFetchError, apiFetch } from './client.js';

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
  const contentBase64 = await encodeBlobBase64(blob);
  const mimeType = blob.type.trim();
  return apiFetch(
    '/api/files/save-binary',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        path,
        contentBase64,
        mimeType,
      }),
    },
    isFileSaveResponse,
  );
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
  const contentBase64 = await encodeBlobBase64(blob);
  const mimeType = blob.type.trim();
  return apiFetchWithSaveConflict(
    '/api/files/replace-binary',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        path,
        contentBase64,
        versionToken,
        mimeType,
      }),
    },
    isFileSaveResponse,
  );
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

async function encodeBlobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
