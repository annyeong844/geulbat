// Derived artifact targets stay inside host-owned .geulbat namespaces.
import { PathEscapeError } from './normalize-path.js';
import type {
  DerivedArtifactOwner,
  DerivedArtifactTarget,
  FilePlatformMode,
} from './file-platform-target-types.js';
import {
  inspectCanonicalWorkspacePath,
  normalizeInternalRelativePath,
} from './file-platform-path-inspection.js';
import {
  buildGeulbatRelativePath,
  GEULBAT_INDEX_ROOT,
  GEULBAT_INTERNAL_ROOT,
} from './geulbat-internal-paths.js';

export async function resolveDerivedArtifactTarget(
  workspaceRoot: string,
  owner: DerivedArtifactOwner,
  relativePath: string,
  options?: {
    allowMissingLeaf?: boolean;
    mode?: Exclude<FilePlatformMode, 'persist'>;
  },
): Promise<DerivedArtifactTarget> {
  const workspaceRelativePath = normalizeInternalRelativePath(
    workspaceRoot,
    buildDerivedArtifactWorkspacePath(owner, relativePath),
  );
  const inspected = await inspectCanonicalWorkspacePath(
    workspaceRoot,
    workspaceRelativePath,
    {
      allowMissingLeaf: options?.allowMissingLeaf ?? false,
      allowMissingWorkspaceRoot: true,
    },
  );

  return {
    kind: 'derived',
    mode: options?.mode ?? 'mutate',
    owner,
    requestedRelativePath: relativePath,
    relativePath: workspaceRelativePath,
    canonicalAbsolutePath: inspected.canonicalAbsolutePath,
    absolutePath: inspected.canonicalAbsolutePath,
    workspaceCanonicalRoot: inspected.workspaceCanonicalRoot,
    exists: inspected.missingTailSegments.length === 0,
  };
}

function buildDerivedArtifactWorkspacePath(
  owner: DerivedArtifactOwner,
  relativePath: string,
): string {
  switch (owner) {
    case 'memory_index':
      return buildGeulbatRelativePath(
        normalizeMemoryIndexArtifactRelativePath(relativePath),
      );
    default:
      return GEULBAT_INDEX_ROOT;
  }
}

function normalizeMemoryIndexArtifactRelativePath(
  relativePath: string,
): string {
  let candidate = String(relativePath ?? '.')
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '');

  if (candidate.startsWith(`${GEULBAT_INTERNAL_ROOT}/`)) {
    candidate = candidate.slice(`${GEULBAT_INTERNAL_ROOT}/`.length);
  }

  if (candidate === '' || candidate === '.') {
    return 'index';
  }

  if (
    candidate === 'index' ||
    candidate.startsWith('index/') ||
    candidate.startsWith('.index-staging-') ||
    candidate.startsWith('.index-previous-')
  ) {
    return candidate;
  }

  throw new PathEscapeError(candidate);
}
