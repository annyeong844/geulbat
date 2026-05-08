import { loadDaemonLocalEnv } from './env-local.js';

export async function bootstrapDaemonEntry(options?: {
  loadEnv?: () => void | Promise<void>;
  importMain?: () => Promise<unknown>;
}): Promise<void> {
  await (options?.loadEnv ?? loadDaemonLocalEnv)();
  const { validateDaemonRuntimeKnobsFromEnv } =
    await import('./daemon/context.js');
  validateDaemonRuntimeKnobsFromEnv();
  await (options?.importMain ?? (() => import('./main.js')))();
}
