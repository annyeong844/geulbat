import { useEffect, useRef, type CSSProperties } from 'react';
import type { ArtifactRuntimePersistenceRenderer } from '@geulbat/protocol/runtime-persistence';

import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
  ResolvedArtifactSourceRef,
} from '../../artifacts/artifact-types.js';
import type {
  ArtifactRuntimeAgentInterjectIntent,
  ArtifactRuntimeAgentPromptIntent,
  ArtifactRuntimeAgentToolIntent,
} from './artifact-runtime-frame-message-handler.js';
import type { RunToolResultPayload } from '@geulbat/protocol/run-channel';
import {
  MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT,
  MIN_INLINE_ARTIFACT_RUNTIME_FRAME_HEIGHT,
} from './artifact-runtime-frame-messages.js';
import { useArtifactRuntimeFrameState } from './use-artifact-runtime-frame-state.js';

const ARTIFACT_RUNTIME_READY_TIMEOUT_MS = 5_000;
const ARTIFACT_RUNTIME_TIMEOUT_MESSAGE =
  '캔버스를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.';

// card: 아티팩트 패널의 떠 있는 카드 표면 (기본값).
// inline: 채팅 본문에 녹아드는 투명 표면 — visualize 위젯용.
type ArtifactRuntimeFrameVariant = 'card' | 'inline';

export function ArtifactRuntimeFrame(props: {
  renderer: ArtifactRuntimePersistenceRenderer;
  title: string;
  sandbox: string;
  runtimePayload: string;
  sourceRef: ResolvedArtifactSourceRef;
  readyTimeoutMs?: number;
  variant?: ArtifactRuntimeFrameVariant;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
  onAgentPromptRequest?: (intent: ArtifactRuntimeAgentPromptIntent) => void;
  onAgentInterjectRequest?: (
    intent: ArtifactRuntimeAgentInterjectIntent,
  ) => void;
  onAgentToolRequest?: (
    intent: ArtifactRuntimeAgentToolIntent,
  ) => Promise<RunToolResultPayload>;
  // 부모 → 프레임 단방향 브로드캐스트 — seq가 바뀔 때마다 message를
  // postMessage로 밀어 넣는다 (visualize 실데이터 스트리밍 등)
  frameBroadcast?: { seq: number; message: Record<string, unknown> } | null;
}) {
  const {
    renderer,
    title,
    sandbox,
    runtimePayload,
    sourceRef,
    readyTimeoutMs = ARTIFACT_RUNTIME_READY_TIMEOUT_MS,
    variant = 'card',
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
    onAgentPromptRequest,
    onAgentInterjectRequest,
    onAgentToolRequest,
    frameBroadcast = null,
  } = props;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const minFrameHeight =
    variant === 'inline'
      ? MIN_INLINE_ARTIFACT_RUNTIME_FRAME_HEIGHT
      : MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT;
  const { bootState, frameHeight, runtimeFrameRevision, runtimeFrameUrl } =
    useArtifactRuntimeFrameState({
      iframeRef,
      renderer,
      sourceRef,
      runtimePayload,
      readyTimeoutMs,
      minFrameHeight,
      ...(onGeneratedTextExportSnapshotChange !== undefined
        ? { onGeneratedTextExportSnapshotChange }
        : {}),
      ...(onGeneratedBinaryExportSnapshotChange !== undefined
        ? { onGeneratedBinaryExportSnapshotChange }
        : {}),
      ...(onAgentPromptRequest !== undefined ? { onAgentPromptRequest } : {}),
      ...(onAgentInterjectRequest !== undefined
        ? { onAgentInterjectRequest }
        : {}),
      ...(onAgentToolRequest !== undefined ? { onAgentToolRequest } : {}),
    });
  const surfaceStyles =
    variant === 'inline'
      ? artifactRuntimeFrameInlineStyles
      : artifactRuntimeFrameCardStyles;

  // 브로드캐스트 — 프레임 부트가 끝난 뒤에도 최신 메시지가 다시 전달되도록
  // bootState를 의존성에 포함한다 (수신 문서는 최신 메시지가 전체 상태).
  useEffect(() => {
    if (frameBroadcast === null) {
      return;
    }
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) {
      return;
    }
    frameWindow.postMessage(
      frameBroadcast.message,
      new URL(runtimeFrameUrl).origin,
    );
  }, [frameBroadcast, bootState, runtimeFrameUrl]);

  return (
    <div style={surfaceStyles.frameWrap}>
      {bootState === 'timed_out' ? (
        <div role="status" style={artifactRuntimeFrameStyles.timeoutNotice}>
          {ARTIFACT_RUNTIME_TIMEOUT_MESSAGE}
        </div>
      ) : null}
      <iframe
        key={runtimeFrameRevision}
        ref={iframeRef}
        title={title}
        sandbox={sandbox}
        src={runtimeFrameUrl}
        referrerPolicy="no-referrer"
        style={{
          ...surfaceStyles.frame,
          minHeight: minFrameHeight,
          height: frameHeight,
        }}
      />
    </div>
  );
}

const artifactRuntimeFrameCardStyles = {
  frameWrap: {
    overflow: 'hidden',
    borderRadius: 8,
    background: 'var(--surface-container-lowest)',
    boxShadow: 'var(--elev-card)',
  },
  frame: {
    display: 'block',
    width: '100%',
    minHeight: MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT,
    border: 0,
    background: 'var(--surface-container-lowest)',
  },
} satisfies Record<string, CSSProperties>;

const artifactRuntimeFrameInlineStyles = {
  frameWrap: {
    overflow: 'hidden',
    background: 'transparent',
  },
  frame: {
    display: 'block',
    width: '100%',
    minHeight: MIN_INLINE_ARTIFACT_RUNTIME_FRAME_HEIGHT,
    border: 0,
    background: 'transparent',
  },
} satisfies Record<string, CSSProperties>;

const artifactRuntimeFrameStyles = {
  timeoutNotice: {
    margin: 16,
    padding: '14px 16px',
    borderRadius: 8,
    background: 'rgba(177, 74, 58, 0.1)',
    color: 'var(--error)',
    font: '600 13px/1.5 var(--font-ui-label)',
  },
} satisfies Record<string, CSSProperties>;
