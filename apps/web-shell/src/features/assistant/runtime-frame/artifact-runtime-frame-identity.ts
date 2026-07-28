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
} from '../runtime-persistence/artifact-runtime-persistence-scope.js';
import { resolveArtifactRuntimeHostUrl } from './artifact-runtime-host.js';
import {
  createArtifactRuntimeFrameRevision,
  createArtifactRuntimeSourceIdentity,
} from './artifact-runtime-frame-revision.js';

/**
 * 부모 창의 origin을 알 수 없을 때 쓰는 값. 이 값이 쓰이는 상황은 `window`가
 * 없다는 뜻이고, 그때는 전달할 부모가 애초에 없다. 동작할 것처럼 보이는 주소를
 * 두면 읽는 사람이 "기본 부모 origin"으로 오해하고, 단일 포트 제품에서는 그
 * 주소가 아무 의미도 없다.
 *
 * `'null'`은 웹 표준의 opaque origin이다. 데몬의 parentOrigin 정규화가 이 값을
 * URL로 해석하지 못해 `null`로 만들고, 런타임 호스트는 어떤 메시지도 보내지
 * 않는다 — 모르는 부모에게 fail-closed다.
 */
const UNKNOWN_ARTIFACT_RUNTIME_PARENT_ORIGIN = 'null';
const ARTIFACT_RUNTIME_OPAQUE_MESSAGE_ORIGIN = 'null';
const ARTIFACT_RUNTIME_OPAQUE_TARGET_ORIGIN = '*';

interface ArtifactRuntimeFrameIdentity {
  runtimeParentOrigin: string;
  runtimeFrameRevision: string;
  runtimeFrameUrl: string;
  runtimeFrameMessageOrigin: string;
  runtimeFrameTargetOrigin: string;
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
  const runtimeFrameUrl = createArtifactRuntimeFrameUrl({
    runtimeHostUrl,
    runtimeParentOrigin,
    runtimeFrameRevision,
  });

  return {
    runtimeParentOrigin,
    runtimeFrameRevision,
    runtimeFrameUrl,
    runtimeFrameMessageOrigin: ARTIFACT_RUNTIME_OPAQUE_MESSAGE_ORIGIN,
    runtimeFrameTargetOrigin: ARTIFACT_RUNTIME_OPAQUE_TARGET_ORIGIN,
    scope,
    scopeHandle,
  };
}

export function resolveArtifactRuntimeParentOrigin(
  locationOrigin: string | undefined,
): string {
  return locationOrigin ?? UNKNOWN_ARTIFACT_RUNTIME_PARENT_ORIGIN;
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
