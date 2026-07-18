import { useEffect, useMemo } from 'react';
import type { ArtifactRuntimePersistenceScopeRequest } from '@geulbat/protocol/runtime-persistence';

import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../../artifacts/artifact-types.js';
import { createArtifactRuntimePersistenceBridgeResponder } from '../runtime-persistence/artifact-runtime-persistence.js';
import {
  handleArtifactRuntimeFrameMessageEvent,
  type ArtifactRuntimeAgentInterjectIntent,
  type ArtifactRuntimeAgentPromptIntent,
  type ArtifactRuntimeAgentToolIntent,
} from './artifact-runtime-frame-message-handler.js';
import type { RunToolResultPayload } from '@geulbat/protocol/run-channel';

export function useArtifactRuntimeFrameMessaging(args: {
  iframeRef: { current: HTMLIFrameElement | null };
  runtimeDocument: string;
  runtimeHostOrigin: string;
  scope: ArtifactRuntimePersistenceScopeRequest | null;
  scopeHandle: string;
  minFrameHeight?: number;
  markHostReady: () => void;
  setFrameHeight: (height: number) => void;
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
}): void {
  const {
    iframeRef,
    runtimeDocument,
    runtimeHostOrigin,
    scope,
    scopeHandle,
    minFrameHeight,
    markHostReady,
    setFrameHeight,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
    onAgentPromptRequest,
    onAgentInterjectRequest,
    onAgentToolRequest,
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
        ...(minFrameHeight !== undefined ? { minFrameHeight } : {}),
        bridgeResponder,
        markHostReady,
        setFrameHeight,
        ...(onGeneratedBinaryExportSnapshotChange !== undefined
          ? { onGeneratedBinaryExportSnapshotChange }
          : {}),
        ...(onGeneratedTextExportSnapshotChange !== undefined
          ? { onGeneratedTextExportSnapshotChange }
          : {}),
        ...(onAgentPromptRequest !== undefined ? { onAgentPromptRequest } : {}),
        ...(onAgentInterjectRequest !== undefined
          ? { onAgentInterjectRequest }
          : {}),
        ...(onAgentToolRequest !== undefined ? { onAgentToolRequest } : {}),
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
    minFrameHeight,
    onAgentInterjectRequest,
    onAgentPromptRequest,
    onAgentToolRequest,
    onGeneratedBinaryExportSnapshotChange,
    onGeneratedTextExportSnapshotChange,
    runtimeDocument,
    runtimeHostOrigin,
    scopeHandle,
    setFrameHeight,
  ]);
}
