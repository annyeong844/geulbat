import { useCallback, useEffect, useRef } from 'react';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';

import {
  logSettleRunEffectFailures,
  settleRunEffects,
  settleRunFollowUpEffects,
} from './run-session-settle.js';
import type { RunSessionStateAction } from './run-session-state-types.js';

interface RunSessionSettleHandlerArgs {
  dispatch: (action: RunSessionStateAction) => void;
  loadThreads: () => Promise<void>;
  openThreadForRunSettle: (
    threadId: string,
  ) => Promise<ThreadDetailResponse | null>;
  openFile: (path: string) => Promise<void>;
  selectedFile: string | null;
  applyThreadSnapshotForRunSettle: (thread: ThreadDetailResponse) => boolean;
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
    async (thread: ThreadDetailResponse) => {
      const applied = applyThreadSnapshotForRunSettle(thread);
      if (!applied) {
        return;
      }
      dispatch({ type: 'run_settled_success' });
      const results = await settleRunFollowUpEffects({
        selectedFile: latestSelectedFileRef.current,
        loadThreads,
        openFile,
      });
      logSettleRunEffectFailures(results);
    },
    [applyThreadSnapshotForRunSettle, dispatch, loadThreads, openFile],
  );

  const settleRunSyncFailure = useCallback(
    async (threadId: string, message: string) => {
      dispatch({
        type: 'run_settle_sync_failed',
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
    async (threadId: string, errMsg: string) => {
      dispatch({ type: 'run_settled_error', threadId, message: errMsg });
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
