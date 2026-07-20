import { useCallback } from 'react';
import { createLogger } from '@geulbat/structured-logger/logger';

import { reportInternalAppError } from './error-reporting.js';
import type { RunSessionStateAction } from './run-session-state-types.js';

interface ErrorLogger {
  error(message: string, ...args: unknown[]): void;
}

const logger = createLogger('run-session');

type RunSessionDispatch = (action: RunSessionStateAction) => void;

export function clearRunSessionError(dispatch: RunSessionDispatch): void {
  dispatch({ type: 'session_error_cleared' });
}

export function reportRunSessionFailure(args: {
  dispatch: RunSessionDispatch;
  logContext: string;
  error: unknown;
  logger?: ErrorLogger;
}): void {
  const { dispatch, logContext, error, logger: errorLogger = logger } = args;
  dispatch({
    type: 'session_error_recorded',
    message: reportInternalAppError({
      logger: errorLogger,
      logContext,
      error,
    }),
  });
}

export function logRunSessionCommandFailure(args: {
  logContext: string;
  message: string;
  logger?: ErrorLogger;
}): void {
  const { logContext, message, logger: errorLogger = logger } = args;
  errorLogger.error(`${logContext}:`, message);
}

export function useRunSessionDiagnostics({
  dispatch,
}: {
  dispatch: RunSessionDispatch;
}) {
  const reportSessionFailure = useCallback(
    (logContext: string, error: unknown) => {
      reportRunSessionFailure({ dispatch, logContext, error });
    },
    [dispatch],
  );

  const logCommandFailure = useCallback(
    (logContext: string, message: string) => {
      logRunSessionCommandFailure({ logContext, message });
    },
    [],
  );

  const clearSessionError = useCallback(() => {
    clearRunSessionError(dispatch);
  }, [dispatch]);

  return {
    clearSessionError,
    reportSessionFailure,
    logCommandFailure,
  };
}
