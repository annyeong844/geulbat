import { useCallback, useEffect, useRef } from 'react';
import type { ErrorCode } from '@geulbat/protocol/errors';
import type { ThreadStateSettlePayload } from '@geulbat/protocol/run-events';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';

import {
  logSettleRunEffectFailures,
  settleRunEffects,
  settleRunFollowUpEffects,
} from './run-session-settle.js';
import type { RunSessionStateAction } from './run-session-state-types.js';
import type { ThreadStateApplyResult } from './use-thread-session-selection.js';

const THREAD_STATE_DELTA_RECOVERY_FAILURE_MESSAGE =
  'Run finished, but the saved thread update could not be joined to the current view.';

interface RunSessionSettleHandlerArgs {
  dispatch: (action: RunSessionStateAction) => void;
  loadThreads: () => Promise<void>;
  openThreadForRunSettle: (
    threadId: string,
  ) => Promise<ThreadDetailResponse | null>;
  openFile: (path: string) => Promise<void>;
  selectedFile: string | null;
  applyThreadSnapshotForRunSettle: (
    thread: ThreadStateSettlePayload,
  ) => ThreadStateApplyResult;
}

export function useRunSessionSettleHandlers({
  dispatch,
  loadThreads,
  openThreadForRunSettle,
  openFile,
  selectedFile,
  applyThreadSnapshotForRunSettle,
}: RunSessionSettleHandlerArgs) {
  const latestSelectedFileRef = useRef(selectedFile);

  useEffect(() => {
    latestSelectedFileRef.current = selectedFile;
  }, [selectedFile]);

  const settleRunSuccess = useCallback(
    async (thread: ThreadStateSettlePayload, runId?: string) => {
      const applyResult = applyThreadSnapshotForRunSettle(thread);
      const recoveredThread =
        applyResult === 'missing_base'
          ? await openThreadForRunSettle(thread.threadId)
          : null;
      if (applyResult === 'missing_base' && recoveredThread === null) {
        dispatch({
          type: 'run_settle_sync_failed',
          ...(runId === undefined ? {} : { runId }),
          threadId: thread.threadId,
          message: THREAD_STATE_DELTA_RECOVERY_FAILURE_MESSAGE,
        });
        const results = await settleRunFollowUpEffects({
          selectedFile: null,
          loadThreads,
          openFile,
        });
        logSettleRunEffectFailures(results);
        return;
      }
      const applied = applyResult === true || recoveredThread !== null;
      dispatch({
        type: 'run_settled_success',
        ...(runId === undefined ? {} : { runId }),
        threadId: thread.threadId,
      });
      const results = await settleRunFollowUpEffects({
        selectedFile: applied ? latestSelectedFileRef.current : null,
        loadThreads,
        openFile,
      });
      logSettleRunEffectFailures(results);
    },
    [
      applyThreadSnapshotForRunSettle,
      dispatch,
      loadThreads,
      openFile,
      openThreadForRunSettle,
    ],
  );

  const settleRunSyncFailure = useCallback(
    async (threadId: string, message: string, runId?: string) => {
      dispatch({
        type: 'run_settle_sync_failed',
        ...(runId === undefined ? {} : { runId }),
        threadId,
        message,
      });
      const results = await settleRunFollowUpEffects({
        selectedFile: latestSelectedFileRef.current,
        loadThreads,
        openFile,
      });
      logSettleRunEffectFailures(results);
    },
    [dispatch, loadThreads, openFile],
  );

  const settleRunError = useCallback(
    async (
      threadId: string,
      code: ErrorCode,
      errMsg: string,
      runId?: string,
    ) => {
      dispatch({
        type: 'run_settled_error',
        ...(runId === undefined ? {} : { runId }),
        threadId,
        code,
        message: `[${code}] ${errMsg}`,
      });
      const results = await settleRunEffects({
        threadId,
        selectedFile: null,
        loadThreads,
        openThreadForRunSettle,
        openFile,
      });
      logSettleRunEffectFailures(results);
    },
    [dispatch, loadThreads, openFile, openThreadForRunSettle],
  );

  return {
    settleRunSuccess,
    settleRunSyncFailure,
    settleRunError,
  };
}
