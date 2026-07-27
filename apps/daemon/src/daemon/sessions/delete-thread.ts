import { rm } from 'node:fs/promises';

import { deleteExecCommandPersistentShellState } from '../exec-command-shell-state.js';
import { deleteThreadToolOutputs } from '../files/tool-output-store.js';
import { deleteThreadPlanState } from '../plan-state-store.js';
import { hasErrorCode } from '../utils/error.js';
import { assertSessionThreadId } from './contract.js';
import { deleteThreadMediaDir } from './media-file-store.js';
import {
  artifactStoreFilePath,
  summaryFilePath,
  threadFilePath,
} from './paths.js';
import { deleteProviderRoundHistory } from './provider-round-journal.js';
import { deleteThreadRunAttachments } from './run-attachment-store.js';
import { deleteThreadRunCheckpoint } from './run-checkpoint-store.js';
import { deleteThreadRunEventJournals } from './run-event-journal.js';
import { removeThreadSummary } from './threads-index.js';
import { clearTranscriptEntryCacheForThread } from './transcript-log.js';

/**
 * tool library projection pin 제거는 tools 계층이 경로를 소유하므로 주입으로 받는다.
 * 공유 projection 콘텐츠는 다른 스레드가 참조할 수 있어 여기서 지우지 않는다.
 */
export interface ThreadProjectionPinDeletionPort {
  deleteThreadProjectionPin(args: {
    stateRoot: string;
    threadId: string;
  }): Promise<boolean>;
}

export async function deleteThreadSession(
  workspaceRoot: string,
  threadId: string,
  projectionPins?: ThreadProjectionPinDeletionPort,
): Promise<boolean> {
  const sessionThreadId = assertSessionThreadId(threadId);
  const deletionResults = await Promise.allSettled([
    removeThreadSummary(workspaceRoot, threadId),
    deleteThreadArtifactFile(threadFilePath(workspaceRoot, threadId)),
    deleteThreadArtifactFile(summaryFilePath(workspaceRoot, threadId)),
    deleteThreadArtifactFile(artifactStoreFilePath(workspaceRoot, threadId)),
    deleteThreadToolOutputs({ stateRoot: workspaceRoot, threadId }),
    deleteExecCommandPersistentShellState({
      stateRoot: workspaceRoot,
      threadId,
    }),
    deleteThreadRunAttachments({ workspaceRoot, threadId }),
    deleteThreadMediaDir(workspaceRoot, threadId),
    deleteProviderRoundHistory(workspaceRoot, sessionThreadId),
    deleteThreadRunEventJournals(workspaceRoot, sessionThreadId),
    deleteThreadRunCheckpoint(workspaceRoot, sessionThreadId),
    deleteThreadPlanState(workspaceRoot, threadId),
    ...(projectionPins === undefined
      ? []
      : [
          projectionPins.deleteThreadProjectionPin({
            stateRoot: workspaceRoot,
            threadId,
          }),
        ]),
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
