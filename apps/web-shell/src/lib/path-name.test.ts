import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPathBreadcrumbs, collapsePathBreadcrumbs } from './path-name.js';

void test('a short path is not collapsed', () => {
  const breadcrumbs = buildPathBreadcrumbs('mnt/c');
  const collapsed = collapsePathBreadcrumbs(breadcrumbs);

  assert.deepEqual(
    collapsed.leading.map((crumb) => crumb.label),
    ['컴퓨터', 'mnt', 'c'],
  );
  assert.deepEqual(collapsed.hidden, []);
  assert.deepEqual(collapsed.trailing, []);
});

void test('a long path keeps the root and the deepest segments around an ellipsis', () => {
  const breadcrumbs = buildPathBreadcrumbs('mnt/c/Users/user/Downloads/repo');
  const collapsed = collapsePathBreadcrumbs(breadcrumbs);

  assert.deepEqual(
    collapsed.leading.map((crumb) => crumb.label),
    ['컴퓨터'],
  );
  assert.deepEqual(
    collapsed.trailing.map((crumb) => crumb.label),
    ['Downloads', 'repo'],
  );
  // 접힌 가운데는 버리지 않는다 — 펼치기가 다시 노출할 수 있어야 한다.
  assert.deepEqual(
    collapsed.hidden.map((crumb) => crumb.label),
    ['mnt', 'c', 'Users', 'user'],
  );
});

void test('collapsing preserves every navigable path exactly once', () => {
  const breadcrumbs = buildPathBreadcrumbs('mnt/c/Users/user/Downloads/repo');
  const collapsed = collapsePathBreadcrumbs(breadcrumbs);

  assert.deepEqual(
    [...collapsed.leading, ...collapsed.hidden, ...collapsed.trailing],
    breadcrumbs,
    'no segment may be lost or duplicated by collapsing',
  );
});

void test('the visible tail size is caller-controlled and never empty', () => {
  const breadcrumbs = buildPathBreadcrumbs('a/b/c/d/e');

  assert.deepEqual(
    collapsePathBreadcrumbs(breadcrumbs, { visibleTrailing: 1 }).trailing.map(
      (crumb) => crumb.label,
    ),
    ['e'],
  );
  // 0이나 음수를 주더라도 마지막 폴더는 남는다 — 현재 위치는 항상 보여야 한다.
  assert.deepEqual(
    collapsePathBreadcrumbs(breadcrumbs, { visibleTrailing: 0 }).trailing.map(
      (crumb) => crumb.label,
    ),
    ['e'],
  );
});
