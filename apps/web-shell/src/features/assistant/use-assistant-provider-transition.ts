import { useCallback, useEffect, useState } from 'react';

import type { ErrorCode } from '@geulbat/protocol/errors';
import type {
  RunModelId,
  RunReasoningEffort,
} from '@geulbat/protocol/run-contract';
import type { PrepareProviderTransitionRequest } from '@geulbat/protocol/threads';

export interface PendingProviderTransition {
  threadId: string | null;
  sourceModelId: RunModelId;
  sourceReasoningEffort: RunReasoningEffort;
  targetModelId: RunModelId;
  attemptStarted: boolean;
}

interface UseAssistantProviderTransitionArgs {
  threadId: string | null;
  messageCount: number;
  modelId: RunModelId;
  reasoningEffort: RunReasoningEffort;
  isRunning: boolean;
  isStarting: boolean;
  isBusy: boolean;
  streamError: string | null;
  streamErrorCode: ErrorCode | null;
  lastUserPrompt: string | undefined;
  onModelIdChange: (modelId: RunModelId) => void;
  onPrepareProviderTransition:
    | ((request: PrepareProviderTransitionRequest) => Promise<void>)
    | undefined;
  onRegenerate: ((prompt: string) => Promise<void> | void) | undefined;
  onSend: (prompt: string) => Promise<void> | void;
}

export function useAssistantProviderTransition({
  threadId,
  messageCount,
  modelId,
  reasoningEffort,
  isRunning,
  isStarting,
  isBusy,
  streamError,
  streamErrorCode,
  lastUserPrompt,
  onModelIdChange,
  onPrepareProviderTransition,
  onRegenerate,
  onSend,
}: UseAssistantProviderTransitionArgs) {
  const [pendingProviderTransition, setPendingProviderTransition] =
    useState<PendingProviderTransition | null>(null);
  const [providerTransitionPending, setProviderTransitionPending] =
    useState(false);
  const [providerTransitionError, setProviderTransitionError] = useState<
    string | null
  >(null);

  const requestModelChange = useCallback(
    (targetModelId: RunModelId) => {
      if (targetModelId === modelId || isRunning || isBusy) {
        return;
      }
      const sourceModelId = pendingProviderTransition?.sourceModelId ?? modelId;
      const sourceReasoningEffort =
        pendingProviderTransition?.sourceReasoningEffort ?? reasoningEffort;
      if (messageCount === 0 || sourceModelId === targetModelId) {
        setPendingProviderTransition(null);
        setProviderTransitionError(null);
        onModelIdChange(targetModelId);
        return;
      }
      setProviderTransitionError(null);
      setPendingProviderTransition({
        threadId,
        sourceModelId,
        sourceReasoningEffort,
        targetModelId,
        attemptStarted: false,
      });
      onModelIdChange(targetModelId);
    },
    [
      isBusy,
      isRunning,
      messageCount,
      modelId,
      onModelIdChange,
      pendingProviderTransition,
      reasoningEffort,
      threadId,
    ],
  );

  useEffect(() => {
    if (
      pendingProviderTransition !== null &&
      pendingProviderTransition.threadId !== threadId
    ) {
      setPendingProviderTransition(null);
      setProviderTransitionError(null);
    }
  }, [pendingProviderTransition, threadId]);

  useEffect(() => {
    if (
      pendingProviderTransition === null ||
      pendingProviderTransition.threadId !== threadId ||
      pendingProviderTransition.attemptStarted ||
      pendingProviderTransition.targetModelId !== modelId ||
      (!isStarting && !isRunning)
    ) {
      return;
    }
    setPendingProviderTransition((current) =>
      current === null || current.targetModelId !== modelId
        ? current
        : { ...current, attemptStarted: true },
    );
  }, [isRunning, isStarting, modelId, pendingProviderTransition, threadId]);

  useEffect(() => {
    if (
      pendingProviderTransition === null ||
      pendingProviderTransition.threadId !== threadId ||
      !pendingProviderTransition.attemptStarted ||
      pendingProviderTransition.targetModelId !== modelId ||
      isRunning ||
      isBusy ||
      streamError !== null
    ) {
      return;
    }
    setPendingProviderTransition(null);
    setProviderTransitionError(null);
  }, [
    isBusy,
    isRunning,
    modelId,
    pendingProviderTransition,
    streamError,
    threadId,
  ]);

  const providerTransitionRecoveryRequired =
    pendingProviderTransition !== null &&
    pendingProviderTransition.threadId === threadId &&
    pendingProviderTransition.attemptStarted &&
    pendingProviderTransition.targetModelId === modelId &&
    (streamErrorCode === 'llm_context_length_exceeded' ||
      streamErrorCode === 'provider_transition_required') &&
    !isRunning &&
    !isBusy;

  const cancelProviderTransition = useCallback(() => {
    if (providerTransitionPending) {
      return;
    }
    setPendingProviderTransition(null);
    setProviderTransitionError(null);
  }, [providerTransitionPending]);

  const confirmProviderTransition = useCallback(async () => {
    const transition = pendingProviderTransition;
    if (
      transition === null ||
      !providerTransitionRecoveryRequired ||
      providerTransitionPending
    ) {
      return;
    }
    if (lastUserPrompt === undefined) {
      setProviderTransitionError('다시 시도할 마지막 질문을 찾지 못했어요.');
      return;
    }
    if (onPrepareProviderTransition === undefined) {
      setProviderTransitionError(
        '이 대화에서는 제공자 전환 문맥을 준비할 수 없어요.',
      );
      return;
    }

    setProviderTransitionPending(true);
    setProviderTransitionError(null);
    try {
      await onPrepareProviderTransition({
        sourceModelId: transition.sourceModelId,
        targetModelId: transition.targetModelId,
        reasoningEffort: transition.sourceReasoningEffort,
      });
      setPendingProviderTransition(null);
      await (onRegenerate ?? onSend)(lastUserPrompt);
    } catch (error: unknown) {
      setProviderTransitionError(
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : '제공자 전환 문맥을 준비하지 못했어요.',
      );
    } finally {
      setProviderTransitionPending(false);
    }
  }, [
    lastUserPrompt,
    onPrepareProviderTransition,
    onRegenerate,
    onSend,
    pendingProviderTransition,
    providerTransitionPending,
    providerTransitionRecoveryRequired,
  ]);

  return {
    pendingProviderTransition,
    providerTransitionRecoveryRequired,
    providerTransitionPending,
    providerTransitionError,
    requestModelChange,
    cancelProviderTransition,
    confirmProviderTransition,
  };
}
