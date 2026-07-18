import { rm } from 'node:fs/promises';

import { deleteThreadMediaDir } from './media-file-store.js';
import {
  artifactStoreFilePath,
  summaryFilePath,
  threadFilePath,
} from './paths.js';
import { deleteThreadRunAttachments } from './run-attachment-store.js';
import { removeThreadSummary } from './threads-index.js';
import { clearTranscriptEntryCacheForThread } from './transcript-log.js';
import { deleteThreadToolOutputs } from '../files/tool-output-store.js';
import { assertSessionThreadId } from './contract.js';
import { deleteProviderRoundHistory } from './provider-round-journal.js';
import { hasErrorCode } from '../utils/error.js';

export async function deleteThreadSession(
  workspaceRoot: string,
  threadId: string,
): Promise<boolean> {
  const deletionResults = await Promise.allSettled([
    removeThreadSummary(workspaceRoot, threadId),
    deleteThreadArtifactFile(threadFilePath(workspaceRoot, threadId)),
    deleteThreadArtifactFile(summaryFilePath(workspaceRoot, threadId)),
    deleteThreadArtifactFile(artifactStoreFilePath(workspaceRoot, threadId)),
    deleteThreadToolOutputs({ stateRoot: workspaceRoot, threadId }),
    deleteThreadRunAttachments({ workspaceRoot, threadId }),
    deleteThreadMediaDir(workspaceRoot, threadId),
    deleteProviderRoundHistory(workspaceRoot, assertSessionThreadId(threadId)),
  ]);

  clearTranscriptEntryCacheForThread(workspaceRoot, threadId);

  const rejectedResult = deletionResults.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejectedResult) {
    throw rejectedResult.reason;
  }

  return deletionResults.some(
    (result) => result.status === 'fulfilled' && result.value,
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
