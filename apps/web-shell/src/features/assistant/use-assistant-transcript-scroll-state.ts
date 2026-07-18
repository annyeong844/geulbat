import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

// 트랜스크립트 하단 자동 추종.
//
// 핵심 계약 — 고빈도 스트리밍 높이 변화는 레이아웃 이후 ResizeObserver가
// 추종한다. 질문 append·run 시작/종료 같은 저빈도 생명주기 전환만 layout
// effect에서 한 번 맞춰, 이전 scrollTop이 한 프레임 보였다가 보정되는
// 깜빡임을 막는다. requestAnimationFrame으로 미루면 다음 프레임 레이아웃
// 전에 scrollHeight를 읽어 스트리밍마다 강제 리플로우가 생길 수 있다.
export function useAssistantTranscriptScrollState(args: {
  isRunning: boolean;
  messageCount: number;
  backgroundNotificationCount: number;
  transcriptEntryCount: number;
  finalAnswerText: string;
  activeArtifactKey: string | null;
  streamError: string | null;
}) {
  // finalAnswerText·transcriptEntryCount·backgroundNotificationCount는
  // 계약상 계속 받되(호출부 그대로), 팔로우는 ResizeObserver가 담당하므로
  // 여기서 구조분해하지 않는다 — 아래 effect deps 주석 참조.
  const { isRunning, messageCount, activeArtifactKey, streamError } = args;
  const [hasUnreadStreamContent, setHasUnreadStreamContent] = useState(false);
  // 바닥에서 떨어져 있으면 ↓ 맨 아래로 버튼을 띄운다 (새 내용 여부와 무관)
  const [isAwayFromBottom, setIsAwayFromBottom] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoScrollLockedRef = useRef(false);
  // DOM API로 만든 scroll event도 isTrusted=true이므로 출처를 이벤트에서
  // 추론할 수 없다. 두 scroll owner가 마지막으로 실제 적용한 위치를 기록해
  // 지연 도착한 내부 이벤트와 새 사용자 이동을 구분한다.
  const lastProgrammaticScrollTopRef = useRef<number | null>(null);

  const syncContentLayout = useCallback((behavior: ScrollBehavior) => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      return;
    }

    const scrollHeight = transcript.scrollHeight;
    const shouldFollow =
      !autoScrollLockedRef.current ||
      isTranscriptNearBottom(transcript, scrollHeight);
    if (shouldFollow) {
      scrollAssistantTranscript(transcript, scrollHeight, behavior);
      lastProgrammaticScrollTopRef.current =
        behavior === 'auto' ? transcript.scrollTop : null;
      clearUnreadTranscriptState(
        autoScrollLockedRef,
        setHasUnreadStreamContent,
      );
      setIsAwayFromBottom(false);
      return;
    }

    setHasUnreadStreamContent(true);
    setIsAwayFromBottom(true);
  }, []);

  // entry 개수 변화 없이 내용 높이만 자라는 경우(iframe 아티팩트 로드,
  // tool row expand 등)에도 바닥을 따라가야 한다. RO 콜백은 레이아웃 이후
  // 시점이라 여기서의 동기 추종은 리플로우를 강제하지 않는다.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => syncContentLayout('auto'));
    observer.observe(content);
    return () => observer.disconnect();
  }, [syncContentLayout]);

  // 고빈도 스트리밍 신호(finalAnswerText·transcriptEntryCount·
  // backgroundNotificationCount)는 일부러 deps에서 뺀다. 이들은 전부
  // contentRef 높이를 키우므로 위 ResizeObserver가 레이아웃 이후 시점에
  // 팔로우한다. 저빈도 전환은 첫 페인트 전에 맞춰야 하므로 layout effect가
  // 소유한다. 자동 추종은 애니메이션하지 않고 즉시 맞춘다. smooth는 사용자가
  // 직접 ↓ 버튼을 누른 경우에만 쓴다. 이 경로를 스트림 delta마다 호출하지
  // 않는 것이 성능 계약이다.
  useLayoutEffect(() => {
    syncContentLayout('auto');
  }, [
    messageCount,
    activeArtifactKey,
    streamError,
    isRunning,
    syncContentLayout,
  ]);

  // end-anchored virtualizer도 같은 scroll element를 조정한다. TanStack의
  // scrollToFn write 직후 이 callback으로 최종 판정을 owner에게 돌려주면,
  // 초기 offset과 질문 append가 한 프레임 위로 보였다가 보정되지 않는다.
  const handleVirtualizerUpdate = useCallback(() => {
    const transcript = transcriptRef.current;
    if (transcript) {
      lastProgrammaticScrollTopRef.current = transcript.scrollTop;
    }
    syncContentLayout('auto');
  }, [syncContentLayout]);

  const handleTranscriptScroll = () => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      return;
    }
    const nearBottom = isTranscriptNearBottom(transcript);
    if (
      lastProgrammaticScrollTopRef.current !== null &&
      transcript.scrollTop === lastProgrammaticScrollTopRef.current
    ) {
      // 내부 write 뒤 event가 늦게 도착하는 동안 row 측정으로 높이가 더
      // 커졌다면, 사용자 이탈로 잠그지 말고 최신 바닥으로 이어서 맞춘다.
      if (!autoScrollLockedRef.current && !nearBottom) {
        syncContentLayout('auto');
      }
      return;
    }
    lastProgrammaticScrollTopRef.current = null;
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
    syncContentLayout('smooth');
  };

  return {
    transcriptRef,
    contentRef,
    bottomRef,
    hasUnreadStreamContent,
    isAwayFromBottom,
    handleTranscriptScroll,
    handleVirtualizerUpdate,
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
