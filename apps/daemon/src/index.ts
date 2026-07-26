import { bootstrapDaemonEntry } from './bootstrap-entry.js';
import { daemonFatalRecordPath } from './home-state-root.js';
import { registerProcessFatalLogging } from './daemon/utils/process-fatal-logging.js';

registerProcessFatalLogging({ recordPath: daemonFatalRecordPath });
await bootstrapDaemonEntry();
