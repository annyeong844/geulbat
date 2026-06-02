import { createLogger, type Logger } from '@geulbat/shared-utils/logger';
import { getErrorMessage } from './error.js';

export interface ProcessFatalLoggingTarget {
  on(
    event: 'uncaughtExceptionMonitor',
    listener: (error: unknown, origin: NodeJS.UncaughtExceptionOrigin) => void,
  ): void;
}

const defaultLogger = createLogger('process');

export function registerProcessFatalLogging(args?: {
  process?: ProcessFatalLoggingTarget;
  logger?: Pick<Logger, 'error'>;
}): void {
  const target = args?.process ?? process;
  const fatalLogger = args?.logger ?? defaultLogger;

  target.on('uncaughtExceptionMonitor', (error, origin) => {
    fatalLogger.error('uncaught exception:', {
      message: getErrorMessage(error),
      origin,
    });
  });
}
