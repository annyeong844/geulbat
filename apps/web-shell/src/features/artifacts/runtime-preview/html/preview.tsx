import { buildHtmlArtifactRuntimePayload } from './document.js';
import { validateHtmlArtifactPayload } from '../../html/validator.js';
import type {
  ArtifactPreviewSurface,
  ResolvedArtifactSourceRef,
} from '../../artifact-types.js';
import {
  pendingArtifactPreview,
  renderedArtifactPreview,
  unavailableArtifactPreview,
} from '../../artifact-types.js';
import { useArtifactStreamingPreviewPayload } from '../../use-artifact-streaming-preview-payload.js';
import type { RenderArtifactRuntimeFrame } from '../types.js';

const STREAMING_HTML_VISIBLE_TAG_PATTERN =
  /<\s*(body|main|section|div|article|aside|header|footer|nav|figure|svg|canvas|h1|h2|h3|p|ul|ol|table)\b/i;
const STREAMING_HTML_SHELL_PATTERN = /<\s*html\b/i;
const STREAMING_HTML_BODY_PATTERN = /<\s*body\b/i;
const STREAMING_HTML_FIRST_TAG_PATTERN = /<!doctype\s+html|<\s*[a-z]/i;

export function resolveHtmlArtifactRuntimePreview(args: {
  payload: string;
  isStreaming: boolean;
  digest: string | null;
  sourceRef: ResolvedArtifactSourceRef;
  renderRuntimeFrame: RenderArtifactRuntimeFrame;
}): ArtifactPreviewSurface {
  const { payload, isStreaming, sourceRef, renderRuntimeFrame } = args;
  if (isStreaming && !isStreamingHtmlPreviewReady(payload)) {
    return pendingArtifactPreview(
      '안정적인 문서 본문이 들어오면 미리보기가 이어집니다.',
    );
  }

  const validation = validateHtmlArtifactPayload(payload);
  if (!validation.ok) {
    return unavailableArtifactPreview(validation.code, validation.detail);
  }

  return renderedArtifactPreview(
    <HtmlArtifactPreviewFrame
      payload={payload}
      isStreaming={isStreaming}
      sourceRef={sourceRef}
      renderRuntimeFrame={renderRuntimeFrame}
    />,
  );
}

function isStreamingHtmlPreviewReady(payload: string): boolean {
  const trimmed = payload.trim();
  if (!trimmed) {
    return false;
  }

  const firstTagIndex = trimmed.search(STREAMING_HTML_FIRST_TAG_PATTERN);
  if (firstTagIndex === -1) {
    return false;
  }
  if (trimmed.slice(0, firstTagIndex).trim()) {
    return false;
  }
  if (hasUnclosedStreamingHtmlTag(trimmed, 'style')) {
    return false;
  }
  if (hasUnclosedStreamingHtmlTag(trimmed, 'script')) {
    return false;
  }

  return (
    STREAMING_HTML_VISIBLE_TAG_PATTERN.test(trimmed) ||
    (STREAMING_HTML_SHELL_PATTERN.test(trimmed) &&
      STREAMING_HTML_BODY_PATTERN.test(trimmed))
  );
}

function hasUnclosedStreamingHtmlTag(
  payload: string,
  tagName: 'style' | 'script',
): boolean {
  const openPattern = new RegExp(`<\\s*${tagName}\\b`, 'gi');
  const closePattern = new RegExp(`<\\s*/\\s*${tagName}\\s*>`, 'gi');
  const openCount = payload.match(openPattern)?.length ?? 0;
  const closeCount = payload.match(closePattern)?.length ?? 0;
  return openCount > closeCount;
}

function HtmlArtifactPreviewFrame(props: {
  payload: string;
  isStreaming: boolean;
  sourceRef: ResolvedArtifactSourceRef;
  renderRuntimeFrame: RenderArtifactRuntimeFrame;
}) {
  const { payload, isStreaming, sourceRef, renderRuntimeFrame } = props;
  const displayedPayload = useArtifactStreamingPreviewPayload({
    payload,
    isStreaming,
    shouldCommitPayload: isStreamingHtmlPreviewReady,
  });
  return (
    <>
      {renderRuntimeFrame({
        renderer: 'html5',
        title: 'html5 artifact preview',
        sandbox: 'allow-scripts allow-forms allow-same-origin',
        runtimePayload: buildHtmlArtifactRuntimePayload(displayedPayload),
        sourceRef,
      })}
    </>
  );
}
