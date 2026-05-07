import {
  isThreadDeleteResponse,
  isThreadDetailResponse,
  isThreadListResponse,
  type ThreadDeleteResponse,
  type ThreadDetailResponse,
  type ThreadListResponse,
} from '@geulbat/protocol/threads';
import {
  isConflictActiveRunError,
  type ConflictActiveRunError,
} from '@geulbat/protocol/errors';
import { ApiFetchError, apiFetch } from './client.js';
import { DEFAULT_PROJECT_ID } from '../default-project-id.js';

export class ThreadDeleteConflictError extends Error {
  readonly conflict: ConflictActiveRunError;

  constructor(conflict: ConflictActiveRunError) {
    super(conflict.message);
    this.name = 'ThreadDeleteConflictError';
    this.conflict = conflict;
  }
}

export function getThreads(
  projectId = DEFAULT_PROJECT_ID,
): Promise<ThreadListResponse> {
  return apiFetch(
    `/api/threads?projectId=${encodeURIComponent(projectId)}`,
    undefined,
    isThreadListResponse,
  );
}

export function getThread(
  threadId: string,
  projectId = DEFAULT_PROJECT_ID,
): Promise<ThreadDetailResponse> {
  return apiFetch(
    `/api/threads/${encodeURIComponent(threadId)}?projectId=${encodeURIComponent(projectId)}`,
    undefined,
    isThreadDetailResponse,
  );
}

export function deleteThread(
  threadId: string,
  projectId = DEFAULT_PROJECT_ID,
): Promise<ThreadDeleteResponse> {
  return apiFetchWithDeleteConflict(
    `/api/threads/${encodeURIComponent(threadId)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
    isThreadDeleteResponse,
  );
}

async function apiFetchWithDeleteConflict(
  path: string,
  options: RequestInit,
  validate: (value: unknown) => value is ThreadDeleteResponse,
): Promise<ThreadDeleteResponse> {
  try {
    return await apiFetch(path, options, validate);
  } catch (error: unknown) {
    if (
      error instanceof ApiFetchError &&
      error.status === 409 &&
      isConflictActiveRunError(error.bodyJson)
    ) {
      throw new ThreadDeleteConflictError(error.bodyJson);
    }
    throw error;
  }
}
