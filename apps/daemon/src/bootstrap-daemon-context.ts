import type { ProjectStore } from './daemon/files/project-store.js';
import { readDefaultRepoRoot } from './repo-root.js';

function resolveDaemonRepoRoot(repoRoot?: string): string {
  return repoRoot ?? readDefaultRepoRoot();
}

export async function bootstrapDaemonContext(args: {
  projectStore: Pick<ProjectStore, 'bootstrapProjectRegistry'>;
  repoRoot?: string;
}): Promise<void> {
  await args.projectStore.bootstrapProjectRegistry(
    resolveDaemonRepoRoot(args.repoRoot),
  );
}
