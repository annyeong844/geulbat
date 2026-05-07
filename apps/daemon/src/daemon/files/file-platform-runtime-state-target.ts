// Runtime state targets derive opaque persistence files from renderer scope.
import { createHash } from 'node:crypto';
import type {
  ArtifactRuntimePersistenceRenderer,
  ArtifactRuntimePersistenceScopeRequest,
} from '@geulbat/protocol/runtime-persistence';
import { isArtifactRuntimePersistenceRenderer } from '@geulbat/protocol/runtime-persistence';

import type { RuntimeStateTarget } from './file-platform-target-types.js';
import {
  inspectCanonicalWorkspacePath,
  normalizeInternalRelativePath,
} from './file-platform-path-inspection.js';
import {
  buildGeulbatRelativePath,
  GEULBAT_RUNTIME_PERSISTENCE_ROOT,
} from './geulbat-internal-paths.js';
import { assertThreadId as assertValidThreadId } from '@geulbat/protocol/ids';

export async function resolveRuntimeStateTarget(
  workspaceRoot: string,
  scope: ArtifactRuntimePersistenceScopeRequest,
): Promise<RuntimeStateTarget> {
  const threadId = assertValidThreadId(scope.threadId);
  assertValidRenderer(scope.renderer);
  const artifactHash = createHash('sha256')
    .update(scope.artifactId)
    .digest('hex');
  const storageRelativePath = normalizeInternalRelativePath(
    workspaceRoot,
    GEULBAT_RUNTIME_PERSISTENCE_ROOT,
  );
  const storageRoot = (
    await inspectCanonicalWorkspacePath(workspaceRoot, storageRelativePath, {
      allowMissingLeaf: true,
    })
  ).canonicalAbsolutePath;
  const workspaceRelativePath = normalizeInternalRelativePath(
    workspaceRoot,
    buildGeulbatRelativePath(
      'runtime-persistence',
      threadId,
      `${artifactHash}-${scope.persistenceEpoch.toString(16)}.json`,
    ),
  );
  const inspected = await inspectCanonicalWorkspacePath(
    workspaceRoot,
    workspaceRelativePath,
    {
      allowMissingLeaf: true,
    },
  );
  const scopeHandle = `${threadId}:${scope.artifactId}:${scope.persistenceEpoch}`;

  return {
    kind: 'runtime_state',
    mode: 'persist',
    requestedRelativePath: workspaceRelativePath,
    relativePath: workspaceRelativePath,
    canonicalAbsolutePath: inspected.canonicalAbsolutePath,
    absolutePath: inspected.canonicalAbsolutePath,
    workspaceCanonicalRoot: inspected.workspaceCanonicalRoot,
    scopeHandle,
    canonicalScopeKey: scopeHandle,
    storageRoot,
    requestedScope: scope,
  };
}

function assertValidRenderer(
  value: string,
): ArtifactRuntimePersistenceRenderer {
  if (!isArtifactRuntimePersistenceRenderer(value)) {
    throw new Error(`invalid runtime persistence renderer: ${value}`);
  }
  return value;
}
