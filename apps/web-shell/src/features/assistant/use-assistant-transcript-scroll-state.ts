import { useEffect, useRef, useState, type RefObject } from 'react';

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
  const transcriptRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoScrollLockedRef = useRef(false);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      return;
    }
    if (!autoScrollLockedRef.current || isTranscriptNearBottom(transcript)) {
      scrollAssistantTranscript(bottomRef, isRunning ? 'auto' : 'smooth');
      clearUnreadTranscriptState(
        autoScrollLockedRef,
        setHasUnreadStreamContent,
      );
      return;
    }
    setHasUnreadStreamContent(true);
  }, [
    messageCount,
    backgroundNotificationCount,
    transcriptEntryCount,
    finalAnswerText,
    activeArtifactKey,
    streamError,
    isRunning,
  ]);

  const handleTranscriptScroll = () => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      return;
    }
    const nearBottom = isTranscriptNearBottom(transcript);
    autoScrollLockedRef.current = !nearBottom;
    if (nearBottom) {
      clearUnreadTranscriptState(
        autoScrollLockedRef,
        setHasUnreadStreamContent,
      );
    }
  };

  const handleJumpToLatest = () => {
    scrollAssistantTranscript(bottomRef, 'smooth');
    clearUnreadTranscriptState(autoScrollLockedRef, setHasUnreadStreamContent);
  };

  return {
    transcriptRef,
    bottomRef,
    hasUnreadStreamContent,
    handleTranscriptScroll,
    handleJumpToLatest,
  };
}

function isTranscriptNearBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
}

function scrollAssistantTranscript(
  bottomRef: RefObject<HTMLDivElement | null>,
  behavior: ScrollBehavior,
) {
  bottomRef.current?.scrollIntoView({ behavior });
}

function clearUnreadTranscriptState(
  autoScrollLockedRef: RefObject<boolean>,
  setHasUnreadStreamContent: (value: boolean) => void,
) {
  autoScrollLockedRef.current = false;
  setHasUnreadStreamContent(false);
}
