import { bootstrapDaemonEntry } from './bootstrap-entry.js';
import { registerProcessFatalLogging } from './daemon/utils/process-fatal-logging.js';

registerProcessFatalLogging();
await bootstrapDaemonEntry();
