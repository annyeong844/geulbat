// Explicit export targets preserve user-directed export intent on top of source mutation.
import type { ExplicitExportTarget } from './file-platform-target-types.js';
import { resolveSourceMutationTarget } from './file-platform-source-targets.js';

export async function resolveExplicitExportTarget(
  workspaceRoot: string,
  targetRelativePath: string,
  userIntentSnapshotId: string,
): Promise<ExplicitExportTarget> {
  const sourceTarget = await resolveSourceMutationTarget(
    workspaceRoot,
    targetRelativePath,
    {
      allowMissingLeaf: true,
    },
  );

  return {
    ...sourceTarget,
    kind: 'explicit_export',
    mode: 'persist',
    targetRelativePath: sourceTarget.relativePath,
    canonicalTargetPath: sourceTarget.canonicalAbsolutePath,
    userIntentSnapshotId,
  };
}
