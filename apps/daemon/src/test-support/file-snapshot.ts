import { dirname } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { hasErrorCode } from '../daemon/utils/error.js';

export async function snapshotFile(
  filePath: string,
): Promise<{ exists: boolean; content: string | null }> {
  try {
    return {
      exists: true,
      content: await readFile(filePath, 'utf8'),
    };
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { exists: false, content: null };
    }
    throw error;
  }
}

export async function restoreFileSnapshot(
  filePath: string,
  snapshot: { exists: boolean; content: string | null },
): Promise<void> {
  if (!snapshot.exists) {
    await rm(filePath, { force: true });
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, snapshot.content ?? '', 'utf8');
}
