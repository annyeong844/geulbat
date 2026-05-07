import type { ErrorCode } from '@geulbat/protocol/errors';
import type { ErrorRequestHandler, Response } from 'express';
import { errorCodeToStatus } from '../../../daemon/error-codes.js';
import { getErrorMessage } from '../../../daemon/utils/error.js';
import { createLogger } from '@geulbat/shared-utils/logger';

export function sendApiError(
  res: Response,
  code: ErrorCode,
  message: string,
  extras: Record<string, unknown> = {},
): void {
  if (res.headersSent) {
    return;
  }
  res.status(errorCodeToStatus(code)).json({
    code,
    message,
    ...extras,
  });
}

export function sendUnexpectedApiError(
  res: Response,
  logContext: string,
  error: unknown,
): void {
  createLogger(logContext).error('unexpected error:', getErrorMessage(error));
  sendApiError(res, 'internal', 'internal server error');
}

export function createUnexpectedApiErrorMiddleware(): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (!req.path.startsWith('/api/')) {
      next(error);
      return;
    }

    sendUnexpectedApiError(res, req.path.replace(/^\/+/, '') || 'api', error);
  };
}
