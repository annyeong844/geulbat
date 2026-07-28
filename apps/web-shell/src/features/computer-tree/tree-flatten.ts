import type { FileTreeNode } from '@geulbat/protocol/files';

export interface FlatTreeRow {
  node: FileTreeNode;
  depth: number;
  isExpanded: boolean;
}

// Explorer 정렬 규칙: 폴더 먼저, 같은 종류끼리는 한국어 자연 정렬.
// 카테고리 그룹 없음 — 순서는 파일시스템 내용에서만 유도된다 (§2.2).
function compareTreeNodes(a: FileTreeNode, b: FileTreeNode): number {
  const rank = (node: FileTreeNode): number => {
    switch (node.type) {
      case 'directory':
        return 0;
      case 'file':
        return 1;
      case 'truncated':
        return 2;
    }
  };
  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  return a.name.localeCompare(b.name, 'ko', {
    numeric: true,
    sensitivity: 'base',
  });
}

function sortTreeLevel(nodes: FileTreeNode[]): FileTreeNode[] {
  return [...nodes].sort(compareTreeNodes);
}

/**
 * Visible-row projection of the file tree for keyboard navigation
 * (§3.1.2 — ↑/↓ tree navigation, →/← expand/collapse).
 */
// 점으로 시작하는 항목은 도구가 만든 것이지 사용자가 찾는 것이 아니다.
// 홈 디렉터리에서는 `.cache`·`.cargo` 같은 이름이 목록 앞을 채워, 실제 작업
// 폴더가 스크롤 아래로 밀린다. 기본은 숨김이고 사용자가 켤 수 있다.
export function isHiddenEntryName(name: string): boolean {
  return name.startsWith('.');
}

export function flattenVisibleTree(
  nodes: FileTreeNode[],
  expandedPaths: ReadonlySet<string>,
  depth = 0,
  { showHiddenEntries = true }: { showHiddenEntries?: boolean } = {},
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  const options = { showHiddenEntries };
  for (const node of sortTreeLevel(nodes)) {
    if (!showHiddenEntries && isHiddenEntryName(node.name)) {
      continue;
    }
    const isExpanded =
      node.type === 'directory' && expandedPaths.has(node.path);
    rows.push({ node, depth, isExpanded });
    if (isExpanded && node.children) {
      rows.push(
        ...flattenVisibleTree(node.children, expandedPaths, depth + 1, options),
      );
    }
  }
  return rows;
}

export function countHiddenEntries(nodes: FileTreeNode[]): number {
  return nodes.filter((node) => isHiddenEntryName(node.name)).length;
}

export function isCanvasEligibleFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.html');
}

export function isPlainTextInsertableFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.txt');
}
