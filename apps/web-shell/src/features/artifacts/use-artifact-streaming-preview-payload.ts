import { useDeferredValue, useEffect, useState } from 'react';

const HTML_STREAMING_PREVIEW_THROTTLE_MS = 120;

export function useArtifactStreamingPreviewPayload(args: {
  payload: string;
  isStreaming: boolean;
  throttleMs?: number;
  shouldCommitPayload?: (payload: string) => boolean;
}): string {
  const {
    payload,
    isStreaming,
    throttleMs = HTML_STREAMING_PREVIEW_THROTTLE_MS,
    shouldCommitPayload,
  } = args;
  const deferredPayload = useDeferredValue(payload);
  const [displayedPayload, setDisplayedPayload] = useState(payload);

  useEffect(() => {
    if (!isStreaming) {
      setDisplayedPayload(payload);
      return;
    }
    const timeoutId = setTimeout(() => {
      setDisplayedPayload((current) =>
        current === deferredPayload ||
        (shouldCommitPayload && !shouldCommitPayload(deferredPayload))
          ? current
          : deferredPayload,
      );
    }, throttleMs);
    return () => clearTimeout(timeoutId);
  }, [deferredPayload, isStreaming, payload, shouldCommitPayload, throttleMs]);

  return displayedPayload;
}
