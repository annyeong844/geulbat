import { getErrorMessage } from '../lib/error-message.js';

interface ErrorLogger {
  error(message: string, ...args: unknown[]): void;
}

export function reportVisibleAppError(args: {
  logger: ErrorLogger;
  logContext: string;
  visiblePrefix: string;
  error: unknown;
}): string {
  const { logger, logContext, visiblePrefix, error } = args;
  const message = getErrorMessage(error);
  logger.error(`${logContext}:`, message);
  return `${visiblePrefix} ${message}`;
}

export function reportInternalAppError(args: {
  logger: ErrorLogger;
  logContext: string;
  error: unknown;
}): string {
  const { logger, logContext, error } = args;
  const message = getErrorMessage(error);
  logger.error(`${logContext}:`, message);
  return `[internal] ${message}`;
}
