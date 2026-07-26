import { randomUUID } from 'node:crypto';

import { createLogger } from '@geulbat/structured-logger/logger';

import { launchDaemonHost } from './host.js';
import { getErrorMessage } from './daemon/utils/error.js';

const logger = createLogger('daemon');

launchDaemonHost({ computerSessionId: randomUUID() }).catch(
  (error: unknown) => {
    logger.error('startup failed:', getErrorMessage(error));
    process.exit(1);
  },
);
