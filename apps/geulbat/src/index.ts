import { bootstrapDaemonEntry } from '@geulbat/daemon/bootstrap-entry';
import { daemonFatalRecordPath } from '@geulbat/daemon/home-state-root';
import { registerProcessFatalLogging } from '@geulbat/daemon/process-fatal-logging';

registerProcessFatalLogging({ recordPath: daemonFatalRecordPath });
await bootstrapDaemonEntry({
  importMain: () => import('./main.js'),
});
