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
    const runEventHandlingByRun = new Map<string, Promise<boolean>>();
    const unsubscribe = client.subscribe((message) => {
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

      const processMessage = async () => {
        const latestArgs = latestArgsRef.current;
        streamBatchController.flushPendingStreamEffects();
        await handleRunSessionMessage({
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
        if (
          message.type === 'run.event' &&
          (message.event.type === 'done' || message.event.type === 'error')
        ) {
          await client.acknowledgeEvent({
            runId: message.event.runId,
            threadId: message.event.threadId,
            seq: message.event.seq,
          });
        }
      };

      if (message.type !== 'run.event') {
        void processMessage().catch((err: unknown) => {
          latestArgsRef.current.reportSessionFailure(
            'run channel message failed',
            err,
          );
        });
        return;
      }

      const runId = message.event.runId;
      const previousHandling =
        runEventHandlingByRun.get(runId) ?? Promise.resolve(true);
      const handled = previousHandling.then(async (previousSucceeded) => {
        if (!previousSucceeded) {
          return false;
        }
        try {
          await processMessage();
          return true;
        } catch (err: unknown) {
          latestArgsRef.current.reportSessionFailure(
            'run channel message failed',
            err,
          );
          return false;
        }
      });
      runEventHandlingByRun.set(runId, handled);

      const terminal =
        message.event.type === 'done' || message.event.type === 'error';
      if (terminal) {
        void handled.finally(() => {
          if (runEventHandlingByRun.get(runId) === handled) {
            runEventHandlingByRun.delete(runId);
          }
        });
      }
    });

    return () => {
      streamBatchController.clearPendingStreamEffects();
      runEventHandlingByRun.clear();
      unsubscribe();
    };
  }, [client]);
}
