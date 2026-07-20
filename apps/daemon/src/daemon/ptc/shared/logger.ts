import { createLogger, type Logger } from '@geulbat/structured-logger/logger';

export function createPtcLogger(scope: string): Logger {
  return createLogger(`ptc/${scope}`);
}
