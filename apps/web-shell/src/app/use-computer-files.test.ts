import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { useComputerFiles } from './use-computer-files.js';
import {
  installFetchSequence,
  installShellAuthDocument,
  jsonResponse,
  renderHook,
  textResponse,
} from '../test-support/hook-test.js';

let restoreDocument = () => {};
let restoreFetch = () => {};
const COMPUTER_FILE_SCOPE = {
  initialComputerFileScope: { available: true as const, browseShortcuts: [] },
};

afterEach(() => {
  restoreFetch();
  restoreFetch = () => {};
  restoreDocument();
  restoreDocument = () => {};
});

void test('useComputerFiles surfaces loadTree failures', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(() =>
    textResponse(500, 'tree failed'),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  await hook.run((current) => current.loadTree());

  assert.equal(
    hook.result.current.treeError,
    '파일 목록을 불러오지 못했습니다. API 500: tree failed',
  );
  assert.deepEqual(hook.result.current.tree, []);
  hook.unmount();
});

void test('useComputerFiles records stale write conflicts during save', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        path: 'notes.md',
        content: 'original',
        versionToken: 'v1',
        totalLines: 1,
        startLine: 1,
        endLine: 1,
      }),
    () =>
      jsonResponse(
        {
          code: 'conflict_stale_write',
          message: 'stale write',
          path: 'notes.md',
          currentVersionToken: 'v2',
        },
        { status: 409 },
      ),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  await hook.run((current) => current.openFile('notes.md'));
  await hook.run((current) => current.handleContentChange('edited'));
  await hook.run((current) => current.handleSave());

  assert.equal(hook.result.current.isDirty, true);
  assert.equal(hook.result.current.saving, false);
  assert.equal(hook.result.current.editorError, null);
  assert.equal(hook.result.current.saveConflict?.currentVersionToken, 'v2');
  hook.unmount();
});

void test('useComputerFiles conflict save-as-copy writes a new file and keeps the original', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        path: 'notes.md',
        content: 'original',
        versionToken: 'v1',
        totalLines: 1,
        startLine: 1,
        endLine: 1,
      }),
    () =>
      jsonResponse(
        {
          code: 'conflict_stale_write',
          message: 'stale write',
          path: 'notes.md',
          currentVersionToken: 'v2',
        },
        { status: 409 },
      ),
    (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        path: string;
        versionToken: string;
      };
      // 사본은 create-only sentinel(빈 토큰)로 저장 — 원본 덮어쓰기 금지
      assert.equal(body.path, 'notes (충돌 사본).md');
      assert.equal(body.versionToken, '');
      return jsonResponse({
        path: 'notes (충돌 사본).md',
        versionToken: 'v3',
        totalLines: 1,
        ok: true,
      });
    },
    () => jsonResponse({ root: 'computer', tree: [] }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  await hook.run((current) => current.openFile('notes.md'));
  await hook.run((current) => current.handleContentChange('edited'));
  await hook.run((current) => current.handleSave());
  await hook.run((current) => current.handleConflictSaveAsCopy());

  assert.equal(hook.result.current.isDirty, false);
  assert.equal(hook.result.current.saving, false);
  assert.equal(hook.result.current.saveConflict, null);
  assert.equal(hook.result.current.editorError, null);
  assert.equal(hook.result.current.selectedFile, 'notes (충돌 사본).md');
  hook.unmount();
});

void test('useComputerFiles opens transcript source paths against the computer root', async () => {
  restoreDocument = installShellAuthDocument();
  const requestedUrls: string[] = [];
  const fetchMock = installFetchSequence((url) => {
    requestedUrls.push(String(url));
    return jsonResponse({
      path: 'episodes/ch01.md',
      content: 'project text',
      versionToken: 'v1',
      totalLines: 1,
      startLine: 1,
      endLine: 1,
    });
  });
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  await hook.run((current) => current.openFile('episodes/ch01.md'));

  assert.equal(hook.result.current.fileContent, 'project text');
  assert.equal(
    requestedUrls[0],
    '/api/files/read?root=computer&path=episodes%2Fch01.md',
  );
  hook.unmount();
});

void test('useComputerFiles opens browser-playable media as streaming URLs', async () => {
  restoreDocument = installShellAuthDocument();
  // 미디어는 blob 다운로드 없이 raw URL을 직접 쓴다 — fetch가 불리면 실패
  const fetchMock = installFetchSequence(() => {
    throw new Error('media preview must not download the file');
  });
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  await hook.run((current) => current.openFile('movie.mp4'));

  assert.equal(hook.result.current.binaryPreview?.kind, 'video');
  assert.equal(hook.result.current.binaryPreview?.path, 'movie.mp4');
  assert.match(
    hook.result.current.binaryPreview?.url ?? '',
    /\/api\/files\/raw\?root=computer&path=movie\.mp4/,
  );
  assert.equal(hook.result.current.editorError, null);
  assert.equal(hook.result.current.openingFile, false);
  hook.unmount();
});

void test('useComputerFiles ignores stale binary preview responses', async () => {
  restoreDocument = installShellAuthDocument();
  let resolveImagePreview: ((response: Response) => void) | null = null;
  const fetchMock = installFetchSequence(
    () =>
      new Promise<Response>((resolve) => {
        resolveImagePreview = resolve;
      }),
    () =>
      jsonResponse({
        path: 'notes.md',
        content: 'fresh text',
        versionToken: 'v1',
        totalLines: 1,
        startLine: 1,
        endLine: 1,
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  let imageOpen: Promise<void> | undefined;
  await hook.run((current) => {
    imageOpen = current.openFile('photo.png');
  });
  await Promise.resolve();
  await hook.run((current) => current.openFile('notes.md'));
  assert.equal(hook.result.current.selectedFile, 'notes.md');

  assert.ok(resolveImagePreview);
  const completeImagePreview: (response: Response) => void =
    resolveImagePreview;
  assert.ok(imageOpen);
  await hook.run(async () => {
    completeImagePreview(new Response(new Blob(['image-bytes'])));
    await imageOpen;
  });

  assert.equal(hook.result.current.selectedFile, 'notes.md');
  assert.equal(hook.result.current.binaryPreview, null);
  assert.equal(hook.result.current.fileContent, 'fresh text');
  hook.unmount();
});
