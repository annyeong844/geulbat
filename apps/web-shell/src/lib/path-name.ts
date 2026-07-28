// Computer root 상대 경로 문자열 분해 — 트리/에디터/버퍼가 공유하는 단일 owner

export function baseNameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

export function parentDirOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function buildPathBreadcrumbs(
  path: string,
): Array<{ label: string; path: string }> {
  const breadcrumbs = [{ label: '컴퓨터', path: '' }];
  let currentPath = '';
  for (const segment of path.split('/').filter(Boolean)) {
    currentPath = currentPath === '' ? segment : `${currentPath}/${segment}`;
    breadcrumbs.push({ label: segment, path: currentPath });
  }
  return breadcrumbs;
}

export interface CollapsedBreadcrumbs {
  leading: Array<{ label: string; path: string }>;
  hidden: Array<{ label: string; path: string }>;
  trailing: Array<{ label: string; path: string }>;
}

// 긴 경로를 `루트 / … / 마지막 몇 개`로 접는다. 접힌 가운데는 버리지 않고
// `hidden`으로 돌려주므로, 호출부가 펼치기나 메뉴로 다시 노출할 수 있다.
//
// 기본값은 표시 폭 문제일 뿐이며 제품 정책이 아니다. 호출부가 원하면 바꿀 수
// 있게 인자로 열어 둔다.
export function collapsePathBreadcrumbs(
  breadcrumbs: ReadonlyArray<{ label: string; path: string }>,
  { visibleTrailing = 2 }: { visibleTrailing?: number } = {},
): CollapsedBreadcrumbs {
  const trailingCount = Math.max(1, visibleTrailing);
  // 루트 + 접힘 표시 + 꼬리보다 짧으면 접을 이유가 없다.
  if (breadcrumbs.length <= trailingCount + 2) {
    return { leading: [...breadcrumbs], hidden: [], trailing: [] };
  }
  const root = breadcrumbs[0];
  return {
    leading: root === undefined ? [] : [root],
    hidden: breadcrumbs.slice(1, breadcrumbs.length - trailingCount),
    trailing: breadcrumbs.slice(breadcrumbs.length - trailingCount),
  };
}

export function splitExtension(name: string): { base: string; ext: string } {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) {
    return { base: name, ext: '' };
  }
  return { base: name.slice(0, dotIndex), ext: name.slice(dotIndex) };
}
