import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

export function useAssistantTranscriptScrollState(args: {
  isRunning: boolean;
  messageCount: number;
  backgroundNotificationCount: number;
  transcriptEntryCount: number;
  finalAnswerText: string;
  activeArtifactKey: string | null;
  streamError: string | null;
}) {
  const {
    isRunning,
    messageCount,
    backgroundNotificationCount,
    transcriptEntryCount,
    finalAnswerText,
    activeArtifactKey,
    streamError,
  } = args;
  const [hasUnreadStreamContent, setHasUnreadStreamContent] = useState(false);
  // 바닥에서 떨어져 있으면 ↓ 맨 아래로 버튼을 띄운다 (새 내용 여부와 무관)
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoScrollLockedRef = useRef(false);
  const pendingLayoutFrameRef = useRef<number | null>(null);
  const pendingScrollBehaviorRef = useRef<ScrollBehavior>('auto');

  const scheduleContentLayoutSync = useCallback((behavior: ScrollBehavior) => {
    if (!transcriptRef.current) {
      return;
    }
    pendingScrollBehaviorRef.current = behavior;
    if (pendingLayoutFrameRef.current !== null) {
      return;
    }
    pendingLayoutFrameRef.current = requestAnimationFrame(() => {
      pendingLayoutFrameRef.current = null;
      const transcript = transcriptRef.current;
      if (!transcript) {
        return;
      }

      const scrollHeight = transcript.scrollHeight;
      const shouldFollow =
        !autoScrollLockedRef.current ||
        isTranscriptNearBottom(transcript, scrollHeight);
      if (shouldFollow) {
        scrollAssistantTranscript(
          transcript,
          scrollHeight,
          pendingScrollBehaviorRef.current,
        );
        clearUnreadTranscriptState(
          autoScrollLockedRef,
          setHasUnreadStreamContent,
        );
        setIsAwayFromBottom(false);
        return;
      }

      setHasUnreadStreamContent(true);
      setIsAwayFromBottom(true);
    });
  }, []);

  useEffect(
    () => () => {
      if (pendingLayoutFrameRef.current !== null) {
        cancelAnimationFrame(pendingLayoutFrameRef.current);
      }
    },
    [],
  );

  // entry 개수 변화 없이 내용 높이만 자라는 경우(iframe 아티팩트 로드,
  // tool row expand 등)에도 바닥을 따라가야 한다.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() =>
      scheduleContentLayoutSync('auto'),
    );
    observer.observe(content);
    return () => observer.disconnect();
  }, [scheduleContentLayoutSync]);

  useEffect(() => {
    scheduleContentLayoutSync(isRunning ? 'auto' : 'smooth');
  }, [
    messageCount,
    backgroundNotificationCount,
    transcriptEntryCount,
    finalAnswerText,
    activeArtifactKey,
    streamError,
    isRunning,
    scheduleContentLayoutSync,
  ]);

  const handleTranscriptScroll = () => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      return;
    }
    const nearBottom = isTranscriptNearBottom(transcript);
    autoScrollLockedRef.current = !nearBottom;
    setIsAwayFromBottom(!nearBottom);
    if (nearBottom) {
      clearUnreadTranscriptState(
        autoScrollLockedRef,
        setHasUnreadStreamContent,
      );
    }
  };

  const handleJumpToLatest = () => {
    clearUnreadTranscriptState(autoScrollLockedRef, setHasUnreadStreamContent);
    setIsAwayFromBottom(false);
    scheduleContentLayoutSync('smooth');
  };

  return {
    transcriptRef,
    contentRef,
    bottomRef,
    hasUnreadStreamContent,
    isAwayFromBottom,
    handleTranscriptScroll,
    handleJumpToLatest,
  };
}

function isTranscriptNearBottom(
  element: HTMLDivElement,
  scrollHeight = element.scrollHeight,
): boolean {
  return scrollHeight - element.scrollTop - element.clientHeight <= 48;
}

function scrollAssistantTranscript(
  transcript: HTMLDivElement,
  scrollHeight: number,
  behavior: ScrollBehavior,
) {
  if (behavior === 'auto') {
    transcript.scrollTop = scrollHeight;
    return;
  }
  transcript.scrollTo({ top: scrollHeight, behavior });
}

function clearUnreadTranscriptState(
  autoScrollLockedRef: RefObject<boolean>,
  setHasUnreadStreamContent: (value: boolean) => void,
) {
  autoScrollLockedRef.current = false;
  setHasUnreadStreamContent(false);
}
