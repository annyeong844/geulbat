import type { ArtifactRuntimePersistenceRenderer } from '@geulbat/protocol/runtime-persistence';

import { buildJsArtifactRuntimeDocument } from '../artifacts/js/document.js';

export function createArtifactRuntimeFrameDocument(args: {
  renderer: ArtifactRuntimePersistenceRenderer;
  runtimePayload: string;
  scopeHandle: string;
  runtimeParentOrigin: string;
}): string {
  return buildJsArtifactRuntimeDocument(args.runtimePayload, {
    scopeHandle: args.scopeHandle,
    parentOrigin: args.runtimeParentOrigin,
    awaitStorageBeforePayload: shouldAwaitStorageBeforeArtifactRuntimePayload(
      args.renderer,
    ),
  });
}

function shouldAwaitStorageBeforeArtifactRuntimePayload(
  renderer: ArtifactRuntimePersistenceRenderer,
): boolean {
  return renderer !== 'react_bundle';
}
