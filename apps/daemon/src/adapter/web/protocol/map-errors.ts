import type { Response } from 'express';
import {
  PersistenceBlockedError,
  PersistenceConflictError,
  PersistenceQuotaExceededError,
  PersistenceUnavailableError,
} from '../../../daemon/artifact-runtime-persistence/errors.js';
import {
  FileAccessError,
  StaleWriteError,
} from '../../../daemon/files/file-domain-error.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import {
  sendApiError,
  sendUnexpectedApiError,
} from '#web/response/send-api-error.js';

const logger = createLogger('web/files');

function sendFileAccessError(res: Response, error: FileAccessError): void {
  if (error instanceof StaleWriteError) {
    sendApiError(res, error.code, error.message, {
      path: error.path,
      currentVersionToken: error.currentVersionToken,
    });
    return;
  }

  sendApiError(
    res,
    error.code,
    error.message,
    error.path ? { path: error.path } : {},
  );
}

export function sendFilesRouteError(
  res: Response,
  logContext: string,
  error: unknown,
): void {
  if (error instanceof FileAccessError) {
    logger
      .withContext({
        logContext,
        path: error.path ?? null,
      })
      .warn('route failed', {
        code: error.code,
      });
    sendFileAccessError(res, error);
    return;
  }
  sendUnexpectedApiError(res, logContext, error);
}

export function sendArtifactRuntimePersistenceRouteError(
  res: Response,
  logContext: string,
  error: unknown,
): void {
  if (
    error instanceof PersistenceBlockedError ||
    error instanceof PersistenceConflictError ||
    error instanceof PersistenceQuotaExceededError ||
    error instanceof PersistenceUnavailableError
  ) {
    sendApiError(res, error.code, error.message);
    return;
  }
  sendUnexpectedApiError(res, logContext, error);
}
