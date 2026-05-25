import type {
  ArtifactRuntimePersistenceRenderer,
  ArtifactRuntimePersistenceScopeRequest,
} from '@geulbat/protocol/runtime-persistence';

import type { ResolvedArtifactSourceRef } from '../../artifacts/artifact-types.js';
import {
  buildCanonicalArtifactSourceRef,
  deriveArtifactRuntimePersistenceScopeFromSourceRef,
} from '../../artifacts/artifact-source-ref.js';
import {
  createArtifactRuntimePersistenceScopeHandle,
  createArtifactRuntimePersistenceScopeKey,
} from '../runtime-persistence/artifact-runtime-persistence.js';
import { resolveArtifactRuntimeHostUrl } from './artifact-runtime-host.js';
import {
  createArtifactRuntimeFrameRevision,
  createArtifactRuntimeSourceIdentity,
} from './artifact-runtime-frame-revision.js';

const DEFAULT_ARTIFACT_RUNTIME_PARENT_ORIGIN = 'http://127.0.0.1:5173';

interface ArtifactRuntimeFrameIdentity {
  runtimeParentOrigin: string;
  runtimeFrameRevision: string;
  runtimeFrameUrl: string;
  runtimeHostOrigin: string;
  scope: ArtifactRuntimePersistenceScopeRequest | null;
  scopeHandle: string;
}

export function createArtifactRuntimeFrameIdentity(args: {
  renderer: ArtifactRuntimePersistenceRenderer;
  sourceRef: ResolvedArtifactSourceRef;
  runtimePayload: string;
  locationOrigin?: string;
}): ArtifactRuntimeFrameIdentity {
  const canonicalSourceRef = buildCanonicalArtifactSourceRef(args.sourceRef);
  const sourceIdentity =
    createArtifactRuntimeSourceIdentity(canonicalSourceRef);
  const scope = deriveArtifactRuntimePersistenceScopeFromSourceRef({
    renderer: args.renderer,
    sourceRef: canonicalSourceRef,
  });
  const persistenceScopeKey = createArtifactRuntimePersistenceScopeKey(scope);
  const runtimeParentOrigin = resolveArtifactRuntimeParentOrigin(
    args.locationOrigin,
  );
  const runtimeFrameRevision = createArtifactRuntimeFrameRevision({
    renderer: args.renderer,
    runtimePayload: args.runtimePayload,
    sourceIdentity,
    persistenceScopeKey,
    parentOrigin: runtimeParentOrigin,
  });
  const scopeHandle =
    createArtifactRuntimePersistenceScopeHandle(runtimeFrameRevision);
  const runtimeHostUrl = resolveArtifactRuntimeHostUrl(args.locationOrigin);
  const runtimeHostOrigin = new URL(runtimeHostUrl).origin;
  const runtimeFrameUrl = createArtifactRuntimeFrameUrl({
    runtimeHostUrl,
    runtimeParentOrigin,
    runtimeFrameRevision,
  });

  return {
    runtimeParentOrigin,
    runtimeFrameRevision,
    runtimeFrameUrl,
    runtimeHostOrigin,
    scope,
    scopeHandle,
  };
}

export function resolveArtifactRuntimeParentOrigin(
  locationOrigin: string | undefined,
): string {
  return locationOrigin ?? DEFAULT_ARTIFACT_RUNTIME_PARENT_ORIGIN;
}

function createArtifactRuntimeFrameUrl(args: {
  runtimeHostUrl: string;
  runtimeParentOrigin: string;
  runtimeFrameRevision: string;
}): string {
  const frameUrl = new URL(args.runtimeHostUrl);
  frameUrl.searchParams.set('parentOrigin', args.runtimeParentOrigin);
  frameUrl.searchParams.set('rev', args.runtimeFrameRevision);
  return frameUrl.toString();
}
