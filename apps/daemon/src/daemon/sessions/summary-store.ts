import { readFile } from 'node:fs/promises';
import { summaryFilePath } from './paths.js';
import { hasErrorCode } from '../utils/error.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';

export async function loadSummary(
  workspaceRoot: string,
  threadId: string,
): Promise<string | null> {
  const filePath = summaryFilePath(workspaceRoot, threadId);
  try {
    return await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (hasErrorCode(err, 'ENOENT')) {
      return null;
    }
    throw err;
  }
}

export async function saveSummary(
  workspaceRoot: string,
  threadId: string,
  summary: string,
): Promise<void> {
  const filePath = summaryFilePath(workspaceRoot, threadId);
  await writeTextFileAtomically(filePath, summary);
}
