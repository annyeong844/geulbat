import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

// 트랜스크립트 하단 자동 추종.
//
// 핵심 계약 — ResizeObserver를 layout effect에서 paint 전에 연결하되,
// 실제 높이 읽기와 바닥 추종은 브라우저가 레이아웃을 끝낸 RO callback이
// 맡는다. requestAnimationFrame이나 render lifecycle에서 scrollHeight를
// 읽어 강제 리플로우를 만들지 않는다.
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
  // 추론할 수 없다. transcript owner가 마지막으로 실제 적용한 위치를 기록해
  // 지연 도착한 내부 이벤트와 새 사용자 이동을 구분한다.
  const lastProgrammaticScrollTopRef = useRef<number | null>(null);
  // 마지막으로 관찰한 콘텐츠 높이. 높이가 줄어드는 것은 새 내용이 아니라
  // 재구성이다(스트리밍 라이브 테일이 정착 메시지로 교체되는 순간이 대표적).
  const lastObservedScrollHeightRef = useRef<number | null>(null);

  const syncContentLayout = useCallback((behavior: ScrollBehavior) => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      return;
    }

    const scrollHeight = transcript.scrollHeight;
    const previousScrollHeight = lastObservedScrollHeightRef.current;
    lastObservedScrollHeightRef.current = scrollHeight;
    // 사용자가 위를 읽는 중이면 바닥을 따라가지 않는다.
    //
    // 여기서 "바닥에 가까운가"로 팔로우를 되살리면 안 된다. 잠금은 실제 스크롤
    // 이벤트에서만 걸리므로, 잠긴 상태에서 바닥에 가까워지는 경우는 콘텐츠가
    // 줄어들어 위치가 바닥 쪽으로 밀린 때뿐이다. 답변이 끝나는 순간이 바로
    // 그때이고, 그것을 팔로우 신호로 읽으면 읽던 자리를 잃는다.
    const shouldFollow = !autoScrollLockedRef.current;
    if (shouldFollow) {
      lastProgrammaticScrollTopRef.current = scrollAssistantTranscript(
        transcript,
        scrollHeight,
        behavior,
      );
      clearUnreadTranscriptState(
        autoScrollLockedRef,
        setHasUnreadStreamContent,
      );
      setIsAwayFromBottom(false);
      return;
    }

    setIsAwayFromBottom(true);
    // 높이가 자란 경우에만 아래에 못 읽은 것이 생긴다. 재구성으로 줄어든
    // 것을 "새 메시지"로 알리면, 사용자가 보내지 않은 알림이 뜬다.
    if (previousScrollHeight === null || scrollHeight > previousScrollHeight) {
      setHasUnreadStreamContent(true);
    }
  }, []);

  // entry 개수 변화 없이 내용 높이만 자라는 경우(iframe 아티팩트 로드,
  // tool row expand 등)에도 바닥을 따라가야 한다. RO 콜백은 레이아웃 이후
  // 시점이라 여기서의 동기 추종은 리플로우를 강제하지 않는다.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => syncContentLayout('auto'));
    observer.observe(content);
    return () => observer.disconnect();
  }, [syncContentLayout]);

  // 지원 브라우저에서는 위 RO가 모든 content 높이 변화를 맡는다. 이 effect는
  // ResizeObserver가 없는 환경의 기존 동작만 보존하며, 지원 브라우저에서는
  // DOM geometry를 읽지 않는다. 고빈도 스트리밍 신호는 content 높이 변화로
  // 관찰되므로 deps에서 제외한다.
  useLayoutEffect(() => {
    if (typeof ResizeObserver !== 'undefined') {
      return;
    }
    syncContentLayout('auto');
  }, [
    messageCount,
    activeArtifactKey,
    streamError,
    isRunning,
    syncContentLayout,
  ]);

  const shouldApplyVirtualizerScroll = useCallback(
    () => autoScrollLockedRef.current,
    [],
  );
  const isProgrammaticTranscriptScroll = useCallback(
    (offset: number) => lastProgrammaticScrollTopRef.current === offset,
    [],
  );

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
    shouldApplyVirtualizerScroll,
    isProgrammaticTranscriptScroll,
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
): number | null {
  const targetScrollTop = Math.max(0, scrollHeight - transcript.clientHeight);
  if (behavior === 'auto') {
    transcript.scrollTop = targetScrollTop;
    return targetScrollTop;
  }
  transcript.scrollTo({ top: targetScrollTop, behavior });
  return null;
}

function clearUnreadTranscriptState(
  autoScrollLockedRef: RefObject<boolean>,
  setHasUnreadStreamContent: (value: boolean) => void,
) {
  autoScrollLockedRef.current = false;
  setHasUnreadStreamContent(false);
}
