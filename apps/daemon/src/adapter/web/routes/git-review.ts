import { Router, type Request, type Response } from 'express';

import {
  isGitReviewFileRequest,
  isGitReviewReleaseRequest,
  isGitReviewSummaryRequest,
  type GitReviewFileRequest,
  type GitReviewFileResult,
  type GitReviewReleaseRequest,
  type GitReviewReleaseResult,
  type GitReviewSummaryRequest,
  type GitReviewSummaryResult,
} from '@geulbat/protocol/git-review';

import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';

export interface GitReviewRoutesService {
  summary(
    request: GitReviewSummaryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GitReviewSummaryResult>;
  file(
    request: GitReviewFileRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GitReviewFileResult>;
  release(request: GitReviewReleaseRequest): GitReviewReleaseResult;
}

export function createGitReviewRoutes(args: {
  service: GitReviewRoutesService;
}): Router {
  const router = Router();

  router.use('/api/git-review', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/api/git-review/summary', async (req, res) => {
    if (!isGitReviewSummaryRequest(req.body)) {
      sendApiError(res, 'bad_request', 'invalid Git review summary request');
      return;
    }
    const capture = createRequestAbort(req, res);
    try {
      const result: GitReviewSummaryResult = await args.service.summary(
        req.body,
        { signal: capture.signal },
      );
      if (!capture.signal.aborted && !res.destroyed) {
        res.status(200).json(result);
      }
    } catch (error: unknown) {
      if (!capture.signal.aborted && !res.destroyed) {
        sendUnexpectedApiError(res, 'api/git-review/summary', error);
      }
    } finally {
      capture.dispose();
    }
  });

  router.post('/api/git-review/file', async (req, res) => {
    if (!isGitReviewFileRequest(req.body)) {
      sendApiError(res, 'bad_request', 'invalid Git review file request');
      return;
    }
    const capture = createRequestAbort(req, res);
    try {
      const result: GitReviewFileResult = await args.service.file(req.body, {
        signal: capture.signal,
      });
      if (!capture.signal.aborted && !res.destroyed) {
        res.status(200).json(result);
      }
    } catch (error: unknown) {
      if (!capture.signal.aborted && !res.destroyed) {
        sendUnexpectedApiError(res, 'api/git-review/file', error);
      }
    } finally {
      capture.dispose();
    }
  });

  router.post('/api/git-review/release', (req, res) => {
    if (!isGitReviewReleaseRequest(req.body)) {
      sendApiError(res, 'bad_request', 'invalid Git review release request');
      return;
    }
    const result: GitReviewReleaseResult = args.service.release(req.body);
    res.status(200).json(result);
  });

  return router;
}

function createRequestAbort(
  request: Request,
  response: Response,
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortWhenResponseCloses = () => {
    if (!response.writableEnded) {
      abort();
    }
  };
  request.once('aborted', abort);
  response.once('close', abortWhenResponseCloses);
  return {
    signal: controller.signal,
    dispose() {
      request.off('aborted', abort);
      response.off('close', abortWhenResponseCloses);
    },
  };
}
