import { createLogger, type Logger } from '@geulbat/shared-utils/logger';

export function createPtcLogger(scope: string): Logger {
  return createLogger(`ptc/${scope}`);
}
