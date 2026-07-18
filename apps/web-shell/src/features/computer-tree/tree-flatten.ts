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
export function flattenVisibleTree(
  nodes: FileTreeNode[],
  expandedPaths: ReadonlySet<string>,
  depth = 0,
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  for (const node of sortTreeLevel(nodes)) {
    const isExpanded =
      node.type === 'directory' && expandedPaths.has(node.path);
    rows.push({ node, depth, isExpanded });
    if (isExpanded && node.children) {
      rows.push(...flattenVisibleTree(node.children, expandedPaths, depth + 1));
    }
  }
  return rows;
}

export function isCanvasEligibleFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.html');
}

export function isPlainTextInsertableFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.txt');
}
