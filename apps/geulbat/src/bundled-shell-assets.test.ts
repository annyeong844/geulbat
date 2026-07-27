import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBundledShellAssetRoot } from './bundled-shell-assets.js';

void test('the source checkout layout resolves the sibling web-shell build', () => {
  const seen: string[] = [];
  const resolution = resolveBundledShellAssetRoot({
    moduleUrl: 'file:///repo/apps/geulbat/dist/bundled-shell-assets.js',
    entryDocumentExists: (path) => {
      seen.push(path);
      return true;
    },
  });

  assert.equal(resolution.shellAssetRoot, '/repo/apps/web-shell/dist');
  assert.deepEqual(seen, ['/repo/apps/web-shell/dist/index.html']);
});

void test('the installed package layout resolves the sibling scoped package build', () => {
  const resolution = resolveBundledShellAssetRoot({
    moduleUrl:
      'file:///app/node_modules/@geulbat/product/dist/bundled-shell-assets.js',
    entryDocumentExists: () => true,
  });

  assert.equal(
    resolution.shellAssetRoot,
    '/app/node_modules/@geulbat/web-shell/dist',
  );
});

void test('a missing build reports no root but keeps the path for diagnostics', () => {
  const resolution = resolveBundledShellAssetRoot({
    moduleUrl: 'file:///repo/apps/geulbat/dist/bundled-shell-assets.js',
    entryDocumentExists: () => false,
  });

  // 조용히 넘기지 않는다: 호출부가 이 경로를 진단에 실어야 한다.
  assert.equal(resolution.shellAssetRoot, null);
  assert.equal(resolution.resolvedPath, '/repo/apps/web-shell/dist');
});
