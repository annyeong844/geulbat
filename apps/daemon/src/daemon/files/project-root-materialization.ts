import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectId } from '@geulbat/protocol/ids';
import { hasErrorCode } from '../utils/error.js';

export async function ensureProjectRootDirectory(args: {
  projectId: ProjectId;
  projectRegistryRoot: string;
  resolveProjectRoot: (projectId: ProjectId) => string | null;
}): Promise<void> {
  const workspaceRoot =
    args.resolveProjectRoot(args.projectId) ??
    join(args.projectRegistryRoot, args.projectId);

  try {
    const existing = await stat(workspaceRoot);
    if (!existing.isDirectory()) {
      throw Object.assign(
        new Error(`project root already exists as a file: ${workspaceRoot}`),
        { code: 'already_exists' },
      );
    }
    return;
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }

  await mkdir(workspaceRoot, { recursive: true });
}
