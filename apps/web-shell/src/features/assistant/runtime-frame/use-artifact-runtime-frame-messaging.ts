import { useEffect, useMemo } from 'react';
import type { ArtifactRuntimePersistenceScopeRequest } from '@geulbat/protocol/runtime-persistence';

import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../../artifacts/artifact-types.js';
import { createArtifactRuntimePersistenceBridgeResponder } from '../runtime-persistence/artifact-runtime-persistence.js';
import { handleArtifactRuntimeFrameMessageEvent } from './artifact-runtime-frame-message-handler.js';

export function useArtifactRuntimeFrameMessaging(args: {
  iframeRef: { current: HTMLIFrameElement | null };
  runtimeDocument: string;
  runtimeHostOrigin: string;
  scope: ArtifactRuntimePersistenceScopeRequest | null;
  scopeHandle: string;
  markHostReady: () => void;
  setFrameHeight: (height: number) => void;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}): void {
  const {
    iframeRef,
    runtimeDocument,
    runtimeHostOrigin,
    scope,
    scopeHandle,
    markHostReady,
    setFrameHeight,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  } = args;

  const bridgeResponder = useMemo(
    () =>
      createArtifactRuntimePersistenceBridgeResponder({
        expectedSource: () => iframeRef.current?.contentWindow ?? null,
        scope,
        scopeHandle,
      }),
    [iframeRef, scope, scopeHandle],
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleMessage = (event: MessageEvent<unknown>) => {
      void handleArtifactRuntimeFrameMessageEvent(event, {
        iframeRef,
        runtimeDocument,
        runtimeHostOrigin,
        scopeHandle,
        bridgeResponder,
        markHostReady,
        setFrameHeight,
        ...(onGeneratedBinaryExportSnapshotChange !== undefined
          ? { onGeneratedBinaryExportSnapshotChange }
          : {}),
        ...(onGeneratedTextExportSnapshotChange !== undefined
          ? { onGeneratedTextExportSnapshotChange }
          : {}),
      });
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [
    bridgeResponder,
    iframeRef,
    markHostReady,
    onGeneratedBinaryExportSnapshotChange,
    onGeneratedTextExportSnapshotChange,
    runtimeDocument,
    runtimeHostOrigin,
    scopeHandle,
    setFrameHeight,
  ]);
}
