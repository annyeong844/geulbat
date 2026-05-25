import { symlink } from 'node:fs/promises';
import type { TestContext } from 'node:test';

function isSymlinkPrivilegeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = 'code' in error ? (error.code as string | undefined) : undefined;
  return code === 'EPERM' || code === 'EACCES';
}

export async function createSymlinkOrSkip(
  t: TestContext,
  target: string,
  path: string,
): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error: unknown) {
    if (isSymlinkPrivilegeError(error)) {
      t.skip('symlink creation is not permitted in this environment');
      return false;
    }
    throw error;
  }
}
