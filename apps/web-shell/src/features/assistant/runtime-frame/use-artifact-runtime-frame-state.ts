import { useMemo } from 'react';
import type { ArtifactRuntimePersistenceRenderer } from '@geulbat/protocol/runtime-persistence';

import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
  ResolvedArtifactSourceRef,
} from '../../artifacts/artifact-types.js';
import { createArtifactRuntimeFrameDocument } from './artifact-runtime-frame-document.js';
import { createArtifactRuntimeFrameIdentity } from './artifact-runtime-frame-identity.js';
import { useArtifactRuntimeFrameMessaging } from './use-artifact-runtime-frame-messaging.js';
import { useArtifactRuntimeFrameBootState } from './use-artifact-runtime-frame-boot-state.js';

export function useArtifactRuntimeFrameState(args: {
  iframeRef: { current: HTMLIFrameElement | null };
  renderer: ArtifactRuntimePersistenceRenderer;
  sourceRef: ResolvedArtifactSourceRef;
  runtimePayload: string;
  readyTimeoutMs: number;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
}) {
  const {
    iframeRef,
    renderer,
    sourceRef,
    runtimePayload,
    readyTimeoutMs,
    onGeneratedTextExportSnapshotChange,
    onGeneratedBinaryExportSnapshotChange,
  } = args;
  const {
    kind,
    projectId,
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
          projectId,
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
      projectId,
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
    markHostReady,
    setFrameHeight,
    ...(onGeneratedBinaryExportSnapshotChange !== undefined
      ? { onGeneratedBinaryExportSnapshotChange }
      : {}),
    ...(onGeneratedTextExportSnapshotChange !== undefined
      ? { onGeneratedTextExportSnapshotChange }
      : {}),
  });

  return {
    bootState,
    frameHeight,
    runtimeFrameRevision,
    runtimeFrameUrl,
  };
}
