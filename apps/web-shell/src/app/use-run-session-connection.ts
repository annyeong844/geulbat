import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';

import type { RunChannelClient } from '../lib/run-channel/client.js';
import type { RunSessionStateAction } from './run-session-state-types.js';
import {
  adaptRunSessionMessage,
  handleRunSessionMessage,
} from './run-session-message-effects.js';
import { createRunSessionStreamBatchController } from './run-session-stream-batch.js';
import type { createProjectTreeRefreshController } from './run-session-tree-refresh.js';
import { requestProjectTreeRefresh } from './run-session-tree-refresh.js';

interface RunSessionConnectionClient extends Pick<
  RunChannelClient,
  'subscribe' | 'close'
> {}

interface UseRunSessionConnectionArgs {
  client: RunSessionConnectionClient;
  dispatch: (action: RunSessionStateAction) => void;
  projectTreeRefreshControllerRef: MutableRefObject<
    ReturnType<typeof createProjectTreeRefreshController>
  >;
  loadTree: () => Promise<void>;
  handleRunStarted: (threadId: string, runId: string) => void | Promise<void>;
  handleRunSettledSuccess: (thread: ThreadDetailResponse) => Promise<void>;
  handleRunSettleSyncFailed: (
    threadId: string,
    message: string,
  ) => Promise<void>;
  handleRunSettledError: (threadId: string, message: string) => Promise<void>;
  reportSessionFailure: (logContext: string, error: unknown) => void;
}

export function useRunSessionConnection({
  client,
  dispatch,
  projectTreeRefreshControllerRef,
  loadTree,
  handleRunStarted,
  handleRunSettledSuccess,
  handleRunSettleSyncFailed,
  handleRunSettledError,
  reportSessionFailure,
}: UseRunSessionConnectionArgs) {
  const latestArgsRef = useRef<UseRunSessionConnectionArgs>({
    client,
    dispatch,
    projectTreeRefreshControllerRef,
    loadTree,
    handleRunStarted,
    handleRunSettledSuccess,
    handleRunSettleSyncFailed,
    handleRunSettledError,
    reportSessionFailure,
  });
  const dispatchRef = useRef<UseRunSessionConnectionArgs['dispatch']>(dispatch);
  const streamBatchControllerRef = useRef(
    createRunSessionStreamBatchController({
      readDispatch: () => dispatchRef.current,
    }),
  );

  useEffect(() => {
    latestArgsRef.current = {
      client,
      dispatch,
      projectTreeRefreshControllerRef,
      loadTree,
      handleRunStarted,
      handleRunSettledSuccess,
      handleRunSettleSyncFailed,
      handleRunSettledError,
      reportSessionFailure,
    };
    dispatchRef.current = dispatch;
  }, [
    client,
    dispatch,
    projectTreeRefreshControllerRef,
    loadTree,
    handleRunStarted,
    handleRunSettledSuccess,
    handleRunSettleSyncFailed,
    handleRunSettledError,
    reportSessionFailure,
  ]);

  useEffect(() => {
    const streamBatchController = streamBatchControllerRef.current;
    return () => {
      streamBatchController.clearPendingStreamEffects();
      client.close();
    };
  }, [client]);

  useEffect(() => {
    const streamBatchController = streamBatchControllerRef.current;
    const unsubscribe = client.subscribe((message) => {
      const latestArgs = latestArgsRef.current;
      const effect = adaptRunSessionMessage(message);
      if (!effect) {
        return;
      }

      if (effect.kind === 'assistant_text_streamed') {
        streamBatchController.queueStreamedTextEffect(effect);
        return;
      }
      if (effect.kind === 'tool_call_args_streamed') {
        streamBatchController.queueStreamedToolArgsEffect(effect);
        return;
      }

      streamBatchController.flushPendingStreamEffects();
      void handleRunSessionMessage({
        message,
        dispatch: dispatchRef.current,
        requestProjectTreeRefresh: () => {
          void requestProjectTreeRefresh(
            latestArgs.projectTreeRefreshControllerRef.current,
            latestArgs.loadTree,
          ).catch((err: unknown) => {
            latestArgs.reportSessionFailure('project tree refresh failed', err);
          });
        },
        handleRunStarted: latestArgs.handleRunStarted,
        handleRunSettledSuccess: latestArgs.handleRunSettledSuccess,
        handleRunSettleSyncFailed: latestArgs.handleRunSettleSyncFailed,
        handleRunSettledError: latestArgs.handleRunSettledError,
      }).catch((err: unknown) => {
        latestArgs.reportSessionFailure('run channel message failed', err);
      });
    });

    return () => {
      streamBatchController.clearPendingStreamEffects();
      unsubscribe();
    };
  }, [client]);
}
