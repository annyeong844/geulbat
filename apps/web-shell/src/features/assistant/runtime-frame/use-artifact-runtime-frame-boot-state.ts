import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../../artifacts/artifact-types.js';
import { MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT } from './artifact-runtime-frame-messages.js';

export type ArtifactRuntimeBootState = 'waiting' | 'ready' | 'timed_out';

export function useArtifactRuntimeFrameBootState(args: {
  runtimeFrameRevision: string;
  readyTimeoutMs: number;
  minFrameHeight?: number;
  initialFrameHeight?: number;
  onFrameHeightChange?: (height: number) => void;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}) {
  const {
    runtimeFrameRevision,
    readyTimeoutMs,
    minFrameHeight = MIN_ARTIFACT_RUNTIME_FRAME_HEIGHT,
    initialFrameHeight,
    onFrameHeightChange,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  } = args;
  const readyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialFrameHeightRef = useRef(
    Math.max(minFrameHeight, initialFrameHeight ?? minFrameHeight),
  );
  initialFrameHeightRef.current = Math.max(
    minFrameHeight,
    initialFrameHeight ?? minFrameHeight,
  );
  const [frameHeight, setFrameHeightState] = useState(
    initialFrameHeightRef.current,
  );
  const [bootState, setBootState] =
    useState<ArtifactRuntimeBootState>('waiting');

  const clearReadyTimeout = useCallback(() => {
    if (readyTimeoutRef.current === null) {
      return;
    }
    clearTimeout(readyTimeoutRef.current);
    readyTimeoutRef.current = null;
  }, []);

  const markHostReady = useCallback(() => {
    clearReadyTimeout();
    setBootState('ready');
  }, [clearReadyTimeout]);

  const setFrameHeight = useCallback((height: number) => {
    setFrameHeightState(height);
  }, []);

  useEffect(() => {
    onFrameHeightChange?.(frameHeight);
  }, [frameHeight, onFrameHeightChange]);

  useEffect(() => {
    clearReadyTimeout();
    setBootState('waiting');
    setFrameHeightState(initialFrameHeightRef.current);
    onGeneratedTextExportSnapshotChange?.(null);
    onGeneratedBinaryExportSnapshotChange?.(null);
    readyTimeoutRef.current = setTimeout(() => {
      setBootState('timed_out');
    }, readyTimeoutMs);
    return () => {
      clearReadyTimeout();
      onGeneratedTextExportSnapshotChange?.(null);
      onGeneratedBinaryExportSnapshotChange?.(null);
    };
  }, [
    clearReadyTimeout,
    onGeneratedBinaryExportSnapshotChange,
    onGeneratedTextExportSnapshotChange,
    readyTimeoutMs,
    runtimeFrameRevision,
  ]);

  return {
    bootState,
    frameHeight,
    markHostReady,
    setFrameHeight,
  };
}
