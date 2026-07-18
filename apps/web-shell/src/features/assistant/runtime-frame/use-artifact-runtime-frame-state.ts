import { useMemo } from 'react';
import type { ArtifactRuntimePersistenceRenderer } from '@geulbat/protocol/runtime-persistence';

import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
  ResolvedArtifactSourceRef,
} from '../../artifacts/artifact-types.js';
import { createArtifactRuntimeFrameDocument } from './artifact-runtime-frame-document.js';
import { createArtifactRuntimeFrameIdentity } from './artifact-runtime-frame-identity.js';
import type {
  ArtifactRuntimeAgentInterjectIntent,
  ArtifactRuntimeAgentPromptIntent,
  ArtifactRuntimeAgentToolIntent,
} from './artifact-runtime-frame-message-handler.js';
import type { RunToolResultPayload } from '@geulbat/protocol/run-channel';
import { useArtifactRuntimeFrameMessaging } from './use-artifact-runtime-frame-messaging.js';
import { useArtifactRuntimeFrameBootState } from './use-artifact-runtime-frame-boot-state.js';

export function useArtifactRuntimeFrameState(args: {
  iframeRef: { current: HTMLIFrameElement | null };
  renderer: ArtifactRuntimePersistenceRenderer;
  sourceRef: ResolvedArtifactSourceRef;
  runtimePayload: string;
  readyTimeoutMs: number;
  minFrameHeight?: number;
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
}) {
  const {
    iframeRef,
    renderer,
    sourceRef,
    runtimePayload,
    readyTimeoutMs,
    minFrameHeight,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
    onAgentPromptRequest,
    onAgentInterjectRequest,
    onAgentToolRequest,
  } = args;
  const {
    kind,
    workingDirectory,
    threadId,
    runId,
    filePath,
    messageTimestamp,
    artifactId,
    artifactVersion,
    persistenceEpoch,
  } = sourceRef;
  const runtimeLocationOrigin = useMemo(
    () => (typeof window === 'undefined' ? undefined : window.location.origin),
    [],
  );
  const runtimeFrameIdentity = useMemo(
    () =>
      createArtifactRuntimeFrameIdentity({
        renderer,
        runtimePayload,
        sourceRef: {
          kind,
          workingDirectory,
          threadId,
          runId,
          filePath,
          messageTimestamp,
          artifactId,
          artifactVersion,
          persistenceEpoch,
        },
        ...(runtimeLocationOrigin !== undefined
          ? { locationOrigin: runtimeLocationOrigin }
          : {}),
      }),
    [
      artifactId,
      artifactVersion,
      filePath,
      kind,
      messageTimestamp,
      persistenceEpoch,
      workingDirectory,
      renderer,
      runId,
      runtimeLocationOrigin,
      runtimePayload,
      threadId,
    ],
  );
  const {
    runtimeParentOrigin,
    runtimeFrameRevision,
    runtimeFrameUrl,
    runtimeHostOrigin,
    scope,
    scopeHandle,
  } = runtimeFrameIdentity;
  const runtimeDocument = useMemo(
    () =>
      createArtifactRuntimeFrameDocument({
        renderer,
        runtimePayload,
        scopeHandle,
        runtimeParentOrigin,
      }),
    [renderer, runtimeParentOrigin, runtimePayload, scopeHandle],
  );
  const { bootState, frameHeight, markHostReady, setFrameHeight } =
    useArtifactRuntimeFrameBootState({
      runtimeFrameRevision,
      readyTimeoutMs,
      ...(minFrameHeight !== undefined ? { minFrameHeight } : {}),
      ...(onGeneratedBinaryExportSnapshotChange !== undefined
        ? { onGeneratedBinaryExportSnapshotChange }
        : {}),
      ...(onGeneratedTextExportSnapshotChange !== undefined
        ? { onGeneratedTextExportSnapshotChange }
        : {}),
    });

  useArtifactRuntimeFrameMessaging({
    iframeRef,
    runtimeDocument,
    runtimeHostOrigin,
    scope,
    scopeHandle,
    ...(minFrameHeight !== undefined ? { minFrameHeight } : {}),
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

  return {
    bootState,
    frameHeight,
    runtimeFrameRevision,
    runtimeFrameUrl,
  };
}
