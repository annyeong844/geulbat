import {
  isThreadBranchResponse,
  isThreadDeleteResponse,
  isThreadDetailResponse,
  isThreadListResponse,
  isThreadRenameResponse,
  isPrepareProviderTransitionResponse,
  type PrepareProviderTransitionRequest,
  type PrepareProviderTransitionResponse,
  type ThreadBranchResponse,
  type ThreadDeleteResponse,
  type ThreadDetailResponse,
  type ThreadListResponse,
  type ThreadRenameResponse,
} from '@geulbat/protocol/threads';
import {
  isArtifactDraftCommitResponse,
  type ArtifactDraftCommitRequest,
  type ArtifactDraftCommitResponse,
} from '@geulbat/protocol/artifacts';
import {
  isConflictActiveRunError,
  type ConflictActiveRunError,
} from '@geulbat/protocol/errors';
import { isRecord } from '../json.js';
import { ApiFetchError, apiFetch } from './client.js';

export class ThreadDeleteConflictError extends Error {
  readonly conflict: ConflictActiveRunError;

  constructor(conflict: ConflictActiveRunError) {
    super(conflict.message);
    this.name = 'ThreadDeleteConflictError';
    this.conflict = conflict;
  }
}

export class ProviderTransitionPreparationError extends Error {
  readonly code = 'provider_transition_preparation_failed';
  readonly reason?: string;

  constructor(message: string, reason?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderTransitionPreparationError';
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
}

export function getThreads(): Promise<ThreadListResponse> {
  return apiFetch('/api/threads', undefined, isThreadListResponse);
}

export function getThread(threadId: string): Promise<ThreadDetailResponse> {
  return apiFetch(
    `/api/threads/${encodeURIComponent(threadId)}`,
    undefined,
    isThreadDetailResponse,
  );
}

export async function prepareThreadProviderTransition(
  threadId: string,
  request: PrepareProviderTransitionRequest,
): Promise<PrepareProviderTransitionResponse> {
  try {
    return await apiFetch(
      `/api/threads/${encodeURIComponent(threadId)}/provider-transition`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
      isPrepareProviderTransitionResponse,
    );
  } catch (error: unknown) {
    const body = error instanceof ApiFetchError ? error.bodyJson : undefined;
    if (
      isRecord(body) &&
      body.code === 'provider_transition_preparation_failed' &&
      typeof body.message === 'string'
    ) {
      throw new ProviderTransitionPreparationError(
        body.message,
        typeof body.reason === 'string' ? body.reason : undefined,
        { cause: error },
      );
    }
    throw error;
  }
}

// upToEntryId 포함 prefix를 복제한 새 스레드를 만든다 — 원 스레드는 불변
export function branchThread(
  threadId: string,
  upToEntryId?: string,
): Promise<ThreadBranchResponse> {
  return apiFetch(
    `/api/threads/${encodeURIComponent(threadId)}/branch`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(upToEntryId !== undefined ? { upToEntryId } : {}),
    },
    isThreadBranchResponse,
  );
}

// draft → 버전 커밋의 409 — 서버 latestVersion을 담아 UI가 재로드하게 한다
class ArtifactVersionConflictError extends Error {
  readonly latestVersion: number | null;

  constructor(message: string, latestVersion: number | null) {
    super(message);
    this.name = 'ArtifactVersionConflictError';
    this.latestVersion = latestVersion;
  }
}

// 에디터 </>에서 고친 draft를 같은 artifactId의 새 버전으로 커밋한다.
// baseVersion은 낙관적 동시성 — 서버가 더 최신이면
// ArtifactVersionConflictError(latestVersion)로 던진다.
export async function commitArtifactDraftVersion(
  threadId: string,
  artifactId: string,
  request: ArtifactDraftCommitRequest,
): Promise<ArtifactDraftCommitResponse> {
  try {
    return await apiFetch(
      `/api/threads/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(artifactId)}/versions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
      isArtifactDraftCommitResponse,
    );
  } catch (error: unknown) {
    if (error instanceof ApiFetchError && error.status === 409) {
      const latestVersion =
        isRecord(error.bodyJson) &&
        typeof error.bodyJson.latestVersion === 'number'
          ? error.bodyJson.latestVersion
          : null;
      throw new ArtifactVersionConflictError(error.message, latestVersion);
    }
    throw error;
  }
}

export function renameThread(
  threadId: string,
  title: string,
): Promise<ThreadRenameResponse> {
  return patchThread(threadId, { title });
}

export function setThreadPinned(
  threadId: string,
  pinned: boolean,
): Promise<ThreadRenameResponse> {
  return patchThread(threadId, { pinned });
}

function patchThread(
  threadId: string,
  body: { title?: string; pinned?: boolean },
): Promise<ThreadRenameResponse> {
  return apiFetch(
    `/api/threads/${encodeURIComponent(threadId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    isThreadRenameResponse,
  );
}

export function deleteThread(threadId: string): Promise<ThreadDeleteResponse> {
  return apiFetchWithDeleteConflict(
    `/api/threads/${encodeURIComponent(threadId)}`,
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

// 첨부 이미지 렌더링용 raw URL — HttpOnly 인증 쿠키가 같이 전송된다
export function threadAttachmentUrl(
  threadId: string,
  attachmentId: string,
): string {
  return `/api/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
