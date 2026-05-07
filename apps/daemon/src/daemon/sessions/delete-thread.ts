import { rm } from 'node:fs/promises';

import {
  artifactStoreFilePath,
  summaryFilePath,
  threadFilePath,
} from './paths.js';
import { removeThreadSummary } from './threads-index.js';
import { clearTranscriptEntryCacheForThread } from './transcript-log.js';
import { hasErrorCode } from '../utils/error.js';

export async function deleteThreadSession(
  workspaceRoot: string,
  threadId: string,
): Promise<boolean> {
  const [
    indexDeleted,
    transcriptDeleted,
    summaryDeleted,
    artifactStoreDeleted,
  ] = await Promise.all([
    removeThreadSummary(workspaceRoot, threadId),
    deleteThreadArtifactFile(threadFilePath(workspaceRoot, threadId)),
    deleteThreadArtifactFile(summaryFilePath(workspaceRoot, threadId)),
    deleteThreadArtifactFile(artifactStoreFilePath(workspaceRoot, threadId)),
  ]);

  clearTranscriptEntryCacheForThread(workspaceRoot, threadId);

  return (
    indexDeleted || transcriptDeleted || summaryDeleted || artifactStoreDeleted
  );
}

async function deleteThreadArtifactFile(filePath: string): Promise<boolean> {
  try {
    await rm(filePath, { force: false });
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}
