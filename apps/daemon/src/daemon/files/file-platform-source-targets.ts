// Source target resolvers map user-facing workspace paths to canonical targets.
import type {
  SourceDirectoryTarget,
  SourceMutationTarget,
  SourceReadTarget,
} from './file-platform-target-types.js';
import {
  inspectCanonicalWorkspacePath,
  normalizeSourceRelativePath,
  resolveCanonicalDirectoryPath,
  resolveCanonicalReadPath,
} from './file-platform-path-inspection.js';

export async function resolveSourceReadTarget(
  workspaceRoot: string,
  inputPath: string,
): Promise<SourceReadTarget> {
  const relativePath = normalizeSourceRelativePath(workspaceRoot, inputPath);
  const { workspaceCanonicalRoot, canonicalAbsolutePath } =
    await resolveCanonicalReadPath(workspaceRoot, relativePath);

  return {
    kind: 'source',
    mode: 'read',
    requestedRelativePath: inputPath,
    relativePath,
    canonicalAbsolutePath,
    absolutePath: canonicalAbsolutePath,
    workspaceCanonicalRoot,
  };
}

export async function resolveSourceMutationTarget(
  workspaceRoot: string,
  inputPath: string,
  options?: { allowMissingLeaf?: boolean },
): Promise<SourceMutationTarget> {
  const relativePath = normalizeSourceRelativePath(workspaceRoot, inputPath);
  const inspected = await inspectCanonicalWorkspacePath(
    workspaceRoot,
    relativePath,
    {
      allowMissingLeaf: options?.allowMissingLeaf ?? false,
    },
  );

  return {
    kind: 'source',
    mode: 'mutate',
    requestedRelativePath: inputPath,
    relativePath,
    canonicalAbsolutePath: inspected.canonicalAbsolutePath,
    absolutePath: inspected.canonicalAbsolutePath,
    workspaceCanonicalRoot: inspected.workspaceCanonicalRoot,
    existingCanonicalAncestor: inspected.existingCanonicalAncestor,
    missingTailSegments: inspected.missingTailSegments,
    versionedMutationRequired: true,
  };
}

export async function resolveSourceDirectoryTarget(
  workspaceRoot: string,
  inputPath: string,
): Promise<SourceDirectoryTarget> {
  const relativePath = normalizeSourceRelativePath(workspaceRoot, inputPath);
  const { workspaceCanonicalRoot, canonicalAbsolutePath, exists } =
    await resolveCanonicalDirectoryPath(workspaceRoot, relativePath);

  return {
    kind: 'source',
    mode: 'enumerate',
    requestedRelativePath: inputPath,
    relativePath,
    canonicalAbsolutePath,
    absolutePath: canonicalAbsolutePath,
    workspaceCanonicalRoot,
    exists,
  };
}
