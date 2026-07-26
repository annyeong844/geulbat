import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ComputerFileScopeResponse,
  FileTreeNode,
} from '@geulbat/protocol/files';

import {
  COMPUTER_FILE_API_SCOPE,
  getComputerFileScope,
  getFileTree,
} from '../lib/api/files.js';
import { parentDirOf } from '../lib/path-name.js';

export interface ReportComputerFileErrorArgs {
  logContext: string;
  visiblePrefix: string;
  error: unknown;
}

export function useComputerFileBrowser(args: {
  initialComputerFileScope: ComputerFileScopeResponse | undefined;
  reportError: (args: ReportComputerFileErrorArgs) => string;
}) {
  const { initialComputerFileScope, reportError } = args;
  const [computerFileScope, setComputerFileScope] = useState<
    ComputerFileScopeResponse | undefined
  >(initialComputerFileScope);
  const [computerFileScopeError, setComputerFileScopeError] = useState<
    string | null
  >(null);
  const browseEnabled = computerFileScope?.available === true;
  const browseStartPath = browseEnabled
    ? (computerFileScope.browseStartPath ?? '')
    : '';
  const browseShortcuts = browseEnabled
    ? computerFileScope.browseShortcuts
    : [];
  const [browsePath, setBrowsePath] = useState(browseStartPath);
  const browseRuntimeRef = useRef<{
    touched: boolean;
    scopeRequestSequence: number;
    refreshComputerFileScope?: () => Promise<void>;
  }>({ touched: false, scopeRequestSequence: 0 });
  const browseEpochRef = useRef(0);
  const treeRequestSequenceRef = useRef(0);
  const subtreeGenerationRef = useRef(0);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);

  const refreshComputerFileScope = async () => {
    const requestSequence = browseRuntimeRef.current.scopeRequestSequence + 1;
    browseRuntimeRef.current.scopeRequestSequence = requestSequence;
    try {
      const scope = await getComputerFileScope();
      if (requestSequence !== browseRuntimeRef.current.scopeRequestSequence) {
        return;
      }
      setComputerFileScope(scope);
      setComputerFileScopeError(null);
    } catch (error: unknown) {
      if (requestSequence !== browseRuntimeRef.current.scopeRequestSequence) {
        return;
      }
      setComputerFileScopeError(
        reportError({
          logContext: 'computer file scope failed',
          visiblePrefix: '컴퓨터 파일 범위를 불러오지 못했습니다.',
          error,
        }),
      );
    }
  };
  browseRuntimeRef.current.refreshComputerFileScope = refreshComputerFileScope;

  useEffect(() => {
    const browseRuntime = browseRuntimeRef.current;
    if (initialComputerFileScope === undefined) {
      void browseRuntime.refreshComputerFileScope?.();
    }
    return () => {
      browseRuntime.scopeRequestSequence += 1;
    };
  }, [initialComputerFileScope]);

  // Computer 파일 범위가 비동기로 늦게 도착한다 — 사용자가 아직 이동하지
  // 않았다면 시작 위치(홈)를 뒤늦게라도 반영한다.
  useEffect(() => {
    if (
      browseEnabled &&
      !browseRuntimeRef.current.touched &&
      browseStartPath !== '' &&
      browsePath === ''
    ) {
      browseEpochRef.current += 1;
      setBrowsePath(browseStartPath);
    }
  }, [browseEnabled, browsePath, browseStartPath]);

  const reportTreeError = useCallback(
    (errorArgs: ReportComputerFileErrorArgs) => {
      setTreeError(reportError(errorArgs));
    },
    [reportError],
  );

  const loadTree = useCallback(async () => {
    const epoch = browseEpochRef.current;
    const requestSequence = treeRequestSequenceRef.current + 1;
    treeRequestSequenceRef.current = requestSequence;
    subtreeGenerationRef.current += 1;
    try {
      // 얕게 먼저 그리고(넓은 root에서도 빠른 첫 페인트) 하위는 lazy 로딩
      if (computerFileScope?.available !== true) {
        return;
      }
      const res = await getFileTree(COMPUTER_FILE_API_SCOPE, {
        depth: 1,
        ...(browsePath !== '' ? { path: browsePath } : {}),
      });
      if (
        epoch !== browseEpochRef.current ||
        requestSequence !== treeRequestSequenceRef.current
      ) {
        return;
      }
      setTree(res.tree);
      setTreeError(null);
    } catch (error: unknown) {
      if (
        epoch !== browseEpochRef.current ||
        requestSequence !== treeRequestSequenceRef.current
      ) {
        return;
      }
      reportTreeError({
        logContext: 'loadTree failed',
        visiblePrefix: '파일 목록을 불러오지 못했습니다.',
        error,
      });
    }
  }, [browsePath, computerFileScope, reportTreeError]);

  const navigateUp = useCallback(() => {
    if (!browseEnabled) {
      return;
    }
    browseRuntimeRef.current.touched = true;
    browseEpochRef.current += 1;
    setBrowsePath((current) => parentDirOf(current));
  }, [browseEnabled]);

  const navigateInto = useCallback(
    (path: string) => {
      if (!browseEnabled) {
        return;
      }
      browseRuntimeRef.current.touched = true;
      browseEpochRef.current += 1;
      setBrowsePath(path);
    },
    [browseEnabled],
  );

  const loadSubtree = useCallback(
    async (path: string) => {
      const epoch = browseEpochRef.current;
      const generation = subtreeGenerationRef.current;
      try {
        // depth 1 — 넓은 root(9p 마운트)에서 대형 폴더의 손자까지
        // 프리페치하면 병합/렌더가 수 초씩 걸린다. 펼칠 때마다 한 층씩.
        const res = await getFileTree(COMPUTER_FILE_API_SCOPE, {
          path,
          depth: 1,
        });
        if (
          epoch !== browseEpochRef.current ||
          generation !== subtreeGenerationRef.current
        ) {
          return;
        }
        setTree((current) => mergeSubtree(current, path, res.tree));
      } catch (error: unknown) {
        if (
          epoch !== browseEpochRef.current ||
          generation !== subtreeGenerationRef.current
        ) {
          return;
        }
        reportTreeError({
          logContext: 'loadSubtree failed',
          visiblePrefix: `${path} 하위 목록을 불러오지 못했습니다.`,
          error,
        });
      }
    },
    [reportTreeError],
  );

  return {
    tree,
    treeError: treeError ?? computerFileScopeError,
    browseEnabled,
    browsePath,
    browseStartPath,
    browseShortcuts,
    refreshComputerFileScope,
    loadTree,
    loadSubtree,
    navigateUp,
    navigateInto,
    reportTreeError,
  };
}

// lazy 트리 병합 — path 노드의 children을 새 하위 트리로 교체
function mergeSubtree(
  nodes: FileTreeNode[],
  path: string,
  children: FileTreeNode[],
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.type !== 'directory') {
      return node;
    }
    if (node.path === path) {
      return { ...node, children };
    }
    if (path.startsWith(`${node.path}/`) && node.children) {
      return { ...node, children: mergeSubtree(node.children, path, children) };
    }
    return node;
  });
}
