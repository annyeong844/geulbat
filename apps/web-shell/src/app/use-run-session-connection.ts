import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ErrorCode } from '@geulbat/protocol/errors';
import type { ThreadDetailResponse } from '@geulbat/protocol/threads';
import type { PlanningWorkflowSnapshot } from '@geulbat/protocol/planning-workflow';
import type { GoalSnapshot } from '@geulbat/protocol/goal';

import type { RunChannelClient } from '../lib/run-channel/client.js';
import type { RunSessionStateAction } from './run-session-state-types.js';
import {
  adaptRunSessionMessage,
  handleRunSessionMessage,
  shouldRefreshTreeAfterToolResult,
  type RunSessionMessageEffect,
} from './run-session-message-effects.js';
import { createRunSessionStreamBatchController } from './run-session-stream-batch.js';
import type { createComputerTreeRefreshController } from './run-session-computer-tree-refresh.js';
import { requestComputerTreeRefresh } from './run-session-computer-tree-refresh.js';

interface RunSessionConnectionClient extends Pick<
  RunChannelClient,
  'subscribe' | 'close' | 'acknowledgeEvent'
> {
  connect(): Promise<unknown>;
}

interface UseRunSessionConnectionArgs {
  client: RunSessionConnectionClient;
  dispatch: (action: RunSessionStateAction) => void;
  computerTreeRefreshControllerRef: MutableRefObject<
    ReturnType<typeof createComputerTreeRefreshController>
  >;
  loadTree: () => Promise<void>;
  handleRunStarted: (threadId: string, runId: string) => void | Promise<void>;
  handleRunSettledSuccess: (
    thread: ThreadDetailResponse,
    runId?: string,
  ) => Promise<void>;
  handleRunSettleSyncFailed: (
    threadId: string,
    message: string,
    runId?: string,
  ) => Promise<void>;
  handleFollowupSuggested?: ((prompt: string) => void) | undefined;
  handlePlanningWorkflow?:
    | ((threadId: string, snapshot: PlanningWorkflowSnapshot | null) => void)
    | undefined;
  handleGoal?:
    | ((threadId: string, snapshot: GoalSnapshot | null) => void)
    | undefined;
  handleRunSettledError: (
    threadId: string,
    code: ErrorCode,
    message: string,
    runId?: string,
  ) => Promise<void>;
  reportSessionFailure: (logContext: string, error: unknown) => void;
}

function isBatchableDisplayEffect(
  effect: RunSessionMessageEffect,
): effect is Extract<
  RunSessionMessageEffect,
  { kind: 'transcript_activity_added' | 'subagent_activity_added' }
> {
  return (
    effect.kind === 'transcript_activity_added' ||
    effect.kind === 'subagent_activity_added'
  );
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
  handleFollowupSuggested,
  handlePlanningWorkflow,
  handleGoal,
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
    handleFollowupSuggested,
    handlePlanningWorkflow,
    handleGoal,
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
      handleFollowupSuggested,
      handlePlanningWorkflow,
      handleGoal,
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
    handleFollowupSuggested,
    handlePlanningWorkflow,
    handleGoal,
    reportSessionFailure,
  ]);

  useEffect(() => {
    const streamBatchController = streamBatchControllerRef.current;
    const runEventHandlingByRun = new Map<string, Promise<boolean>>();
    const requestLatestComputerTreeRefresh = () => {
      const latestArgs = latestArgsRef.current;
      void requestComputerTreeRefresh(
        latestArgs.computerTreeRefreshControllerRef.current,
        latestArgs.loadTree,
      ).catch((err: unknown) => {
        latestArgs.reportSessionFailure('computer tree refresh failed', err);
      });
    };
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
      if (effect.kind === 'tool_output_streamed') {
        streamBatchController.queueStreamedToolOutputEffect(effect);
        return;
      }
      const processMessage = async () => {
        if (isBatchableDisplayEffect(effect)) {
          if (
            effect.kind === 'transcript_activity_added' &&
            shouldRefreshTreeAfterToolResult(effect)
          ) {
            requestLatestComputerTreeRefresh();
          }
          streamBatchController.queueDisplayEffect(effect);
          return;
        }
        const latestArgs = latestArgsRef.current;
        streamBatchController.flushPendingStreamEffects();
        await handleRunSessionMessage({
          message,
          dispatch: dispatchRef.current,
          requestComputerTreeRefresh: requestLatestComputerTreeRefresh,
          handleRunStarted: latestArgs.handleRunStarted,
          handleRunSettledSuccess: latestArgs.handleRunSettledSuccess,
          handleRunSettleSyncFailed: latestArgs.handleRunSettleSyncFailed,
          handleRunSettledError: latestArgs.handleRunSettledError,
          handleFollowupSuggested: latestArgs.handleFollowupSuggested,
          handlePlanningWorkflow: latestArgs.handlePlanningWorkflow,
          handleGoal: latestArgs.handleGoal,
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
      const continueRunEventHandling = async (previousSucceeded: boolean) => {
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
      };
      const previousHandling = runEventHandlingByRun.get(runId);
      const handled =
        previousHandling === undefined
          ? continueRunEventHandling(true)
          : previousHandling.then(continueRunEventHandling);
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

  useEffect(() => {
    const streamBatchController = streamBatchControllerRef.current;
    const pageDocument = typeof document === 'undefined' ? null : document;
    const pageWindow = typeof window === 'undefined' ? null : window;
    let disposed = false;
    const requestConnection = () => {
      void client.connect().catch((error: unknown) => {
        if (!disposed) {
          latestArgsRef.current.reportSessionFailure(
            'run channel connection failed',
            error,
          );
        }
      });
    };
    const handleVisibilityChange = () => {
      if (pageDocument?.visibilityState === 'visible') {
        requestConnection();
      }
    };
    requestConnection();
    pageDocument?.addEventListener('visibilitychange', handleVisibilityChange);
    pageWindow?.addEventListener('pageshow', requestConnection);
    return () => {
      disposed = true;
      pageDocument?.removeEventListener(
        'visibilitychange',
        handleVisibilityChange,
      );
      pageWindow?.removeEventListener('pageshow', requestConnection);
      streamBatchController.clearPendingStreamEffects();
      client.close();
    };
  }, [client]);
}
