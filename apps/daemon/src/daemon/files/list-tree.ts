import type { FileTreeNode } from './contract.js';
import { FileAccessError } from './file-domain-error.js';
import { hasErrorCode } from '../utils/error.js';
import {
  enumerateCanonicalChildren,
  resolveSourceDirectoryTarget,
  type SourceDirectoryTarget,
} from './file-platform.js';

type TreeNode = FileTreeNode;
const TRUNCATED_NODE_NAME = '… 더 많은 항목';

interface ListTreeOptions {
  maxDepth?: number;
  maxNodes?: number;
  // 'truncate': 한도에 닿으면 오류 대신 디렉터리를 children 없이 반환한다
  // (lazy 로딩 — 셸이 폴더 펼침 시 subPath로 다시 요청). 기본은 'error'.
  depthLimitMode?: 'error' | 'truncate';
  // 기준 경로 상대 좌표다. `..` 또는 절대경로로 호스트의 다른 위치도 가리킨다.
  subPath?: string;
}

/**
 * List a visible file tree from any OS-accessible host directory.
 * Canonical directory identities prevent symlink cycles while aliases remain
 * visible to the caller.
 */
export async function listTree(
  workspaceRoot: string,
  options: ListTreeOptions = {},
): Promise<TreeNode[]> {
  const rootTarget = await resolveSourceDirectoryTarget(
    workspaceRoot,
    options.subPath ?? '.',
  );
  if (!rootTarget.exists) {
    return [];
  }
  return scanDir(
    rootTarget,
    {
      depth: 0,
      count: { value: 0 },
      maxDepth: options.maxDepth,
      maxNodes: options.maxNodes,
      depthLimitMode: options.depthLimitMode ?? 'error',
    },
    new Set([rootTarget.canonicalAbsolutePath]),
  );
}

interface ScanLimits {
  depth: number;
  count: { value: number };
  maxDepth: number | undefined;
  maxNodes: number | undefined;
  depthLimitMode: 'error' | 'truncate';
}

async function scanDir(
  target: SourceDirectoryTarget,
  limits: ScanLimits,
  visitedRealDirs: ReadonlySet<string>,
): Promise<TreeNode[]> {
  if (
    limits.depthLimitMode === 'error' &&
    limits.maxDepth !== undefined &&
    limits.depth > limits.maxDepth
  ) {
    throw FileAccessError.treeTooLarge(
      target.relativePath || '.',
      `max depth ${limits.maxDepth} exceeded`,
    );
  }

  const nodes: TreeNode[] = [];
  let entries;
  try {
    entries = await enumerateCanonicalChildren(target);
  } catch (error: unknown) {
    // 넓은 boundary(컴퓨터 전체)에서는 접근 불가 시스템 디렉터리가 흔하다
    // — 항목 하나가 전체 나열을 죽이지 않게 skip
    if (isPermissionError(error)) {
      return nodes;
    }
    throw error;
  }

  for (const entry of entries) {
    limits.count.value += 1;
    if (limits.maxNodes !== undefined && limits.count.value > limits.maxNodes) {
      if (limits.depthLimitMode === 'truncate') {
        nodes.push(createTruncatedNode(target.relativePath));
        break;
      }
      throw FileAccessError.treeTooLarge(
        entry.relativePath,
        `max nodes ${limits.maxNodes} exceeded`,
      );
    }

    if (entry.type === 'directory') {
      if (visitedRealDirs.has(entry.canonicalAbsolutePath)) {
        nodes.push({
          name: entry.name,
          path: entry.relativePath,
          type: 'directory',
          children: [],
        });
        continue;
      }
      // truncate 모드에서 depth 한도에 닿은 디렉터리는 children 없이 반환
      // — 셸이 lazy 로딩으로 이어받는다
      if (
        limits.depthLimitMode === 'truncate' &&
        limits.maxDepth !== undefined &&
        limits.depth + 1 > limits.maxDepth
      ) {
        nodes.push({
          name: entry.name,
          path: entry.relativePath,
          type: 'directory',
        });
        continue;
      }
      let children: TreeNode[];
      try {
        children = await scanDir(
          {
            ...target,
            requestedRelativePath: entry.relativePath,
            relativePath: entry.relativePath,
            canonicalAbsolutePath: entry.canonicalAbsolutePath,
            absolutePath: entry.canonicalAbsolutePath,
            exists: true,
          },
          {
            ...limits,
            depth: limits.depth + 1,
          },
          new Set([...visitedRealDirs, entry.canonicalAbsolutePath]),
        );
      } catch (error: unknown) {
        if (isPermissionError(error)) {
          children = [];
        } else {
          throw error;
        }
      }
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

function isPermissionError(error: unknown): boolean {
  return hasErrorCode(error, 'EACCES') || hasErrorCode(error, 'EPERM');
}

function createTruncatedNode(parentPath: string): TreeNode {
  const normalizedParent = parentPath === '.' ? '' : parentPath;
  return {
    name: TRUNCATED_NODE_NAME,
    path:
      normalizedParent === ''
        ? '__geulbat_tree_truncated__'
        : `${normalizedParent}/__geulbat_tree_truncated__`,
    type: 'truncated',
    message:
      '이 폴더에는 더 많은 항목이 있습니다. 하위 폴더를 열어 계속 탐색하세요.',
  };
}
