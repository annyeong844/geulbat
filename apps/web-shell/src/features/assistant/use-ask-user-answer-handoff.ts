import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AskUserAnswerHandler,
  AskUserAnswerRequest,
} from './ask-user/ask-user-card.js';

interface AskUserTurnWaiter {
  threadId: string | null;
  resolve: () => void;
  reject: (error: Error) => void;
}

// ask_user 카드 답변 핸드오프 — 답변은 지금 turn이 끝난 뒤 새 turn으로
// 보내야 한다. 카드 클릭 시점에 run이 아직 도는 중이면 waiter로 기다렸다가
// settle 후 전송하고, 그 사이 스레드가 바뀌거나 언마운트되면 답변 claim을
// 되돌린다. (use-assistant-provider-transition과 같은 분리 문법)
export function useAskUserAnswerHandoff(args: {
  threadId: string | null;
  isRunning: boolean;
  isStarting: boolean;
  isSettling: boolean;
  sendNewTurn: (prompt: string) => Promise<void> | void;
}) {
  const { threadId, isRunning, isStarting, isSettling, sendNewTurn } = args;
  const [answeredAskUserRequestKeys, setAnsweredAskUserRequestKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [askUserAnswerPending, setAskUserAnswerPending] = useState(false);
  const askUserTurnStateRef = useRef({
    threadId,
    isRunning,
    isStarting,
    isSettling,
  });
  const askUserTurnWaitersRef = useRef(new Set<AskUserTurnWaiter>());
  const claimedAskUserRequestKeysRef = useRef(new Set<string>());
  const previousAskUserThreadIdRef = useRef(threadId);
  const latestSendNewTurnRef = useRef(sendNewTurn);
  const mountedRef = useRef(true);
  askUserTurnStateRef.current = {
    threadId,
    isRunning,
    isStarting,
    isSettling,
  };
  latestSendNewTurnRef.current = sendNewTurn;

  useEffect(() => {
    if (previousAskUserThreadIdRef.current === threadId) {
      return;
    }
    previousAskUserThreadIdRef.current = threadId;
    for (const waiter of askUserTurnWaitersRef.current) {
      askUserTurnWaitersRef.current.delete(waiter);
      waiter.reject(new Error('ask_user thread changed before answer handoff'));
    }
    claimedAskUserRequestKeysRef.current.clear();
    setAnsweredAskUserRequestKeys(new Set());
    setAskUserAnswerPending(false);
  }, [threadId]);

  useEffect(() => {
    const current = askUserTurnStateRef.current;
    for (const waiter of askUserTurnWaitersRef.current) {
      if (waiter.threadId !== current.threadId) {
        askUserTurnWaitersRef.current.delete(waiter);
        waiter.reject(
          new Error('ask_user thread changed before answer handoff'),
        );
        continue;
      }
      if (!current.isRunning && !current.isStarting && !current.isSettling) {
        askUserTurnWaitersRef.current.delete(waiter);
        waiter.resolve();
      }
    }
  }, [isRunning, isSettling, isStarting, threadId]);

  useEffect(() => {
    const askUserTurnWaiters = askUserTurnWaitersRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const waiter of askUserTurnWaiters) {
        waiter.reject(new Error('ask_user answer handoff was unmounted'));
      }
      askUserTurnWaiters.clear();
    };
  }, []);

  const waitForAskUserTurn = useCallback(
    (expectedThreadId: string | null): Promise<void> => {
      const current = askUserTurnStateRef.current;
      if (current.threadId !== expectedThreadId) {
        return Promise.reject(
          new Error('ask_user thread changed before answer handoff'),
        );
      }
      if (!current.isRunning && !current.isStarting && !current.isSettling) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        askUserTurnWaitersRef.current.add({
          threadId: expectedThreadId,
          resolve,
          reject,
        });
      });
    },
    [],
  );

  const handleAskUserAnswer = useCallback<AskUserAnswerHandler>(
    async ({ answer, requestKey }: AskUserAnswerRequest) => {
      if (claimedAskUserRequestKeysRef.current.has(requestKey)) {
        return;
      }
      claimedAskUserRequestKeysRef.current.add(requestKey);
      setAnsweredAskUserRequestKeys((current) => {
        const next = new Set(current);
        next.add(requestKey);
        return next;
      });
      setAskUserAnswerPending(true);
      const expectedThreadId = askUserTurnStateRef.current.threadId;
      try {
        await waitForAskUserTurn(expectedThreadId);
        if (askUserTurnStateRef.current.threadId !== expectedThreadId) {
          throw new Error('ask_user thread changed before answer handoff');
        }
        await latestSendNewTurnRef.current(answer);
      } catch (error: unknown) {
        claimedAskUserRequestKeysRef.current.delete(requestKey);
        if (mountedRef.current) {
          setAnsweredAskUserRequestKeys((current) => {
            const next = new Set(current);
            next.delete(requestKey);
            return next;
          });
        }
        throw error;
      } finally {
        if (mountedRef.current) {
          setAskUserAnswerPending(false);
        }
      }
    },
    [waitForAskUserTurn],
  );

  return {
    handleAskUserAnswer,
    answeredAskUserRequestKeys,
    askUserAnswerPending,
  };
}
