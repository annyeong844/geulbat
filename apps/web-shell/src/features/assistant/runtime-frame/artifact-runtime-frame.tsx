import { useRef, type CSSProperties } from 'react';
import type { ArtifactRuntimePersistenceRenderer } from '@geulbat/protocol/runtime-persistence';

import {
  type GeneratedBinaryExportSnapshot,
  type GeneratedTextExportSnapshot,
  type ResolvedArtifactSourceRef,
} from '../../artifacts/artifact-types.js';
import { MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT } from './artifact-runtime-frame-messages.js';
import { useArtifactRuntimeFrameState } from './use-artifact-runtime-frame-state.js';

const ARTIFACT_RUNTIME_READY_TIMEOUT_MS = 5_000;
const ARTIFACT_RUNTIME_TIMEOUT_MESSAGE =
  '캔버스를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.';

export function ArtifactRuntimeFrame(props: {
  renderer: ArtifactRuntimePersistenceRenderer;
  title: string;
  sandbox: string;
  runtimePayload: string;
  sourceRef: ResolvedArtifactSourceRef;
  readyTimeoutMs?: number;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}) {
  const {
    renderer,
    title,
    sandbox,
    runtimePayload,
    sourceRef,
    readyTimeoutMs = ARTIFACT_RUNTIME_READY_TIMEOUT_MS,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  } = props;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const { bootState, frameHeight, runtimeFrameRevision, runtimeFrameUrl } =
    useArtifactRuntimeFrameState({
      iframeRef,
      renderer,
      sourceRef,
      runtimePayload,
      readyTimeoutMs,
      ...(onGeneratedTextExportSnapshotChange !== undefined
        ? { onGeneratedTextExportSnapshotChange }
        : {}),
      ...(onGeneratedBinaryExportSnapshotChange !== undefined
        ? { onGeneratedBinaryExportSnapshotChange }
        : {}),
    });

  return (
    <div style={artifactRuntimeFrameStyles.frameWrap}>
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
          ...artifactRuntimeFrameStyles.frame,
          height: frameHeight,
        }}
      />
    </div>
  );
}

const artifactRuntimeFrameStyles = {
  frameWrap: {
    overflow: 'hidden',
    borderRadius: 12,
    border: '1px solid #d6dce5',
    background: '#fff',
    boxShadow: '0 6px 14px rgba(52, 73, 94, 0.08)',
  },
  frame: {
    display: 'block',
    width: '100%',
    minHeight: MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT,
    border: 0,
    background: '#fff',
  },
  timeoutNotice: {
    margin: 16,
    padding: '14px 16px',
    borderRadius: 12,
    border: '1px solid #f3b8b2',
    background: '#fff3f1',
    color: '#a23a2a',
    font: '600 13px/1.5 ui-sans-serif, system-ui, sans-serif',
  },
} satisfies Record<string, CSSProperties>;
