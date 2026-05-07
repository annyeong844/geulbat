import type { FileTreeNode } from '@geulbat/protocol/files';
import { FileAccessError } from './file-domain-error.js';
import {
  enumerateCanonicalChildren,
  resolveSourceDirectoryTarget,
  type SourceDirectoryTarget,
} from './file-platform.js';

type TreeNode = FileTreeNode;

const MAX_TREE_DEPTH = 15;
const MAX_TREE_NODES = 10_000;

interface ListTreeOptions {
  maxDepth?: number;
  maxNodes?: number;
}

/**
 * List visible file tree under workspaceRoot.
 * Hides `.geulbat/`, dotfiles starting with `.`, and symlinks escaping workspace.
 */
export async function listTree(
  workspaceRoot: string,
  options: ListTreeOptions = {},
): Promise<TreeNode[]> {
  const rootTarget = await resolveSourceDirectoryTarget(workspaceRoot, '.');
  const maxDepth = options.maxDepth ?? MAX_TREE_DEPTH;
  const maxNodes = options.maxNodes ?? MAX_TREE_NODES;
  if (!rootTarget.exists) {
    return [];
  }
  return scanDir(
    rootTarget,
    {
      depth: 0,
      count: { value: 0 },
      maxDepth,
      maxNodes,
    },
    new Set([rootTarget.canonicalAbsolutePath]),
  );
}

async function scanDir(
  target: SourceDirectoryTarget,
  limits: {
    depth: number;
    count: { value: number };
    maxDepth: number;
    maxNodes: number;
  },
  visitedRealDirs: ReadonlySet<string>,
): Promise<TreeNode[]> {
  if (limits.depth > limits.maxDepth) {
    throw FileAccessError.treeTooLarge(
      target.relativePath || '.',
      `max depth ${limits.maxDepth} exceeded`,
    );
  }

  const nodes: TreeNode[] = [];
  const entries = await enumerateCanonicalChildren(target);

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    limits.count.value += 1;
    if (limits.count.value > limits.maxNodes) {
      throw FileAccessError.treeTooLarge(
        entry.relativePath,
        `max nodes ${limits.maxNodes} exceeded`,
      );
    }

    if (entry.type === 'directory') {
      if (visitedRealDirs.has(entry.canonicalAbsolutePath)) {
        continue;
      }
      const children = await scanDir(
        {
          ...target,
          requestedRelativePath: entry.relativePath,
          relativePath: entry.relativePath,
          canonicalAbsolutePath: entry.canonicalAbsolutePath,
          absolutePath: entry.canonicalAbsolutePath,
          exists: true,
        },
        {
          depth: limits.depth + 1,
          count: limits.count,
          maxDepth: limits.maxDepth,
          maxNodes: limits.maxNodes,
        },
        new Set([...visitedRealDirs, entry.canonicalAbsolutePath]),
      );
      nodes.push({
        name: entry.name,
        path: entry.relativePath,
        type: 'directory',
        children,
      });
    } else {
      nodes.push({ name: entry.name, path: entry.relativePath, type: 'file' });
    }
  }

  return nodes;
}
