import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';

import type { RunChannelClient } from '../lib/run-channel/client.js';
import type { RunSessionStateAction } from './run-session-state-types.js';
import {
  adaptRunSessionMessage,
  handleRunSessionMessage,
} from './run-session-message-effects.js';
import { createRunSessionStreamBatchController } from './run-session-stream-batch.js';
import type { createComputerTreeRefreshController } from './run-session-computer-tree-refresh.js';
import { requestComputerTreeRefresh } from './run-session-computer-tree-refresh.js';

interface RunSessionConnectionClient extends Pick<
  RunChannelClient,
  'subscribe' | 'close' | 'acknowledgeEvent'
> {}

interface UseRunSessionConnectionArgs {
  client: RunSessionConnectionClient;
  dispatch: (action: RunSessionStateAction) => void;
  computerTreeRefreshControllerRef: MutableRefObject<
    ReturnType<typeof createComputerTreeRefreshController>
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
  computerTreeRefreshControllerRef,
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
    computerTreeRefreshControllerRef,
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
      computerTreeRefreshControllerRef,
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
    computerTreeRefreshControllerRef,
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
      const handled = handleRunSessionMessage({
        message,
        dispatch: dispatchRef.current,
        requestComputerTreeRefresh: () => {
          void requestComputerTreeRefresh(
            latestArgs.computerTreeRefreshControllerRef.current,
            latestArgs.loadTree,
          ).catch((err: unknown) => {
            latestArgs.reportSessionFailure(
              'computer tree refresh failed',
              err,
            );
          });
        },
        handleRunStarted: latestArgs.handleRunStarted,
        handleRunSettledSuccess: latestArgs.handleRunSettledSuccess,
        handleRunSettleSyncFailed: latestArgs.handleRunSettleSyncFailed,
        handleRunSettledError: latestArgs.handleRunSettledError,
      });
      const terminalHandled =
        message.type === 'run.event' &&
        (message.event.type === 'done' || message.event.type === 'error')
          ? handled.then(async () => {
              await client.acknowledgeEvent({
                runId: message.event.runId,
                threadId: message.event.threadId,
                seq: message.event.seq,
              });
            })
          : handled;
      void terminalHandled.catch((err: unknown) => {
        latestArgs.reportSessionFailure('run channel message failed', err);
      });
    });

    return () => {
      streamBatchController.clearPendingStreamEffects();
      unsubscribe();
    };
  }, [client]);
}
