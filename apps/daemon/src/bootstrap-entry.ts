import { loadDaemonLocalEnv } from './env-local.js';
import { validateDaemonRuntimeKnobsFromEnv } from './daemon/context.js';

export async function bootstrapDaemonEntry(options?: {
  loadEnv?: () => void | Promise<void>;
  importMain?: () => Promise<unknown>;
}): Promise<void> {
  await (options?.loadEnv ?? loadDaemonLocalEnv)();
  validateDaemonRuntimeKnobsFromEnv();
  await (options?.importMain ?? (() => import('./main.js')))();
}
