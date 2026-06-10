import type { ArtifactRuntimePersistenceRenderer } from '@geulbat/protocol/runtime-persistence';

import { buildJsArtifactRuntimeDocument } from '../../artifacts/runtime-preview/js/document.js';
import { buildJsRuntimePersistenceBootstrap } from '../runtime-persistence/artifact-runtime-persistence-bootstrap.js';

export function createArtifactRuntimeFrameDocument(args: {
  renderer: ArtifactRuntimePersistenceRenderer;
  runtimePayload: string;
  scopeHandle: string;
  runtimeParentOrigin: string;
}): string {
  const awaitStorageBeforePayload =
    shouldAwaitStorageBeforeArtifactRuntimePayload(args.renderer);
  const persistenceBootstrap = {
    scopeHandle: args.scopeHandle,
    parentOrigin: args.runtimeParentOrigin,
    awaitStorageBeforePayload,
  };

  return buildJsArtifactRuntimeDocument(args.runtimePayload, {
    ...persistenceBootstrap,
    bootstrapSource: buildJsRuntimePersistenceBootstrap(persistenceBootstrap),
  });
}

function shouldAwaitStorageBeforeArtifactRuntimePayload(
  renderer: ArtifactRuntimePersistenceRenderer,
): boolean {
  return renderer !== 'react_bundle';
}
