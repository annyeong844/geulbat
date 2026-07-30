import {
  isGitReviewFileResult,
  isGitReviewReleaseResult,
  isGitReviewSummaryResult,
  type GitReviewFileRequest,
  type GitReviewFileResult,
  type GitReviewReleaseRequest,
  type GitReviewReleaseResult,
  type GitReviewSummaryRequest,
  type GitReviewSummaryResult,
} from '@geulbat/protocol/git-review';

import { apiFetch } from './client.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

export function fetchGitReviewSummary(
  request: GitReviewSummaryRequest,
  signal?: AbortSignal,
): Promise<GitReviewSummaryResult> {
  return apiFetch(
    '/api/git-review/summary',
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    },
    isGitReviewSummaryResult,
  );
}

export function fetchGitReviewFile(
  request: GitReviewFileRequest,
  signal?: AbortSignal,
): Promise<GitReviewFileResult> {
  return apiFetch(
    '/api/git-review/file',
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    },
    isGitReviewFileResult,
  );
}

export function releaseGitReviewObservation(
  request: GitReviewReleaseRequest,
  signal?: AbortSignal,
): Promise<GitReviewReleaseResult> {
  return apiFetch(
    '/api/git-review/release',
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    },
    isGitReviewReleaseResult,
  );
}
