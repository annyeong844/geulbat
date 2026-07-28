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
let restoreStorage = () => {};
const COMPUTER_FILE_SCOPE = {
  initialComputerFileScope: { available: true as const, browseShortcuts: [] },
};
const RECENT_FILE_STORAGE_KEY = 'geulbat.shell.recent-files.v1';

function installRecentFileStorage(initialValue?: string): {
  storage: Storage;
  restore: () => void;
} {
  const previousDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage',
  );
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
  if (initialValue !== undefined) {
    storage.setItem(RECENT_FILE_STORAGE_KEY, initialValue);
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return {
    storage,
    restore() {
      if (previousDescriptor !== undefined) {
        Object.defineProperty(globalThis, 'localStorage', previousDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'localStorage');
      }
    },
  };
}

afterEach(() => {
  restoreFetch();
  restoreFetch = () => {};
  restoreDocument();
  restoreDocument = () => {};
  restoreStorage();
  restoreStorage = () => {};
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

void test('useComputerFiles refreshes cached browse shortcuts on demand', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(() =>
    jsonResponse({
      available: true,
      browseStartPath: 'C:\\Workspace\\writer',
      browseShortcuts: [
        { label: '다운로드', path: 'C:\\Workspace\\writer\\Downloads' },
        { label: '사진', path: 'C:\\Workspace\\writer\\Pictures' },
      ],
    }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  assert.deepEqual(hook.result.current.browseShortcuts, []);
  await hook.run((current) => current.refreshComputerFileScope());

  assert.deepEqual(
    fetchMock.calls.map((call) => call.url),
    ['/api/files/computer-scope'],
  );
  assert.deepEqual(hook.result.current.browseShortcuts, [
    { label: '다운로드', path: 'C:\\Workspace\\writer\\Downloads' },
    { label: '사진', path: 'C:\\Workspace\\writer\\Pictures' },
  ]);
  hook.unmount();
});

void test('useComputerFiles keeps the newest overlapping scope refresh', async () => {
  restoreDocument = installShellAuthDocument();
  let resolveStaleScope: ((response: Response) => void) | null = null;
  const fetchMock = installFetchSequence(
    () =>
      new Promise<Response>((resolve) => {
        resolveStaleScope = resolve;
      }),
    () =>
      jsonResponse({
        available: true,
        browseShortcuts: [
          { label: '사진', path: 'C:\\Workspace\\writer\\Pictures' },
        ],
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  let staleRefresh: Promise<void> | undefined;
  await hook.run((current) => {
    staleRefresh = current.refreshComputerFileScope();
  });
  await Promise.resolve();
  await hook.run((current) => current.refreshComputerFileScope());

  assert.ok(resolveStaleScope);
  const completeStaleScope: (response: Response) => void = resolveStaleScope;
  assert.ok(staleRefresh);
  await hook.run(async () => {
    completeStaleScope(
      jsonResponse({
        available: true,
        browseShortcuts: [],
      }),
    );
    await staleRefresh;
  });

  assert.deepEqual(hook.result.current.browseShortcuts, [
    { label: '사진', path: 'C:\\Workspace\\writer\\Pictures' },
  ]);
  hook.unmount();
});

void test('useComputerFiles ignores a stale tree response after browse navigation', async () => {
  restoreDocument = installShellAuthDocument();
  let resolveStaleTree: ((response: Response) => void) | null = null;
  const fetchMock = installFetchSequence(
    () =>
      new Promise<Response>((resolve) => {
        resolveStaleTree = resolve;
      }),
    () =>
      jsonResponse({
        root: 'computer',
        tree: [{ name: 'fresh.md', path: 'docs/fresh.md', type: 'file' }],
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  let staleLoad: Promise<void> | undefined;
  await hook.run((current) => {
    staleLoad = current.loadTree();
  });
  await Promise.resolve();
  await hook.run((current) => current.navigateInto('docs'));
  await hook.run((current) => current.loadTree());
  assert.equal(hook.result.current.browsePath, 'docs');
  assert.deepEqual(hook.result.current.tree, [
    { name: 'fresh.md', path: 'docs/fresh.md', type: 'file' },
  ]);

  assert.ok(resolveStaleTree);
  const completeStaleTree: (response: Response) => void = resolveStaleTree;
  assert.ok(staleLoad);
  await hook.run(async () => {
    completeStaleTree(
      jsonResponse({
        root: 'computer',
        tree: [{ name: 'stale.md', path: 'stale.md', type: 'file' }],
      }),
    );
    await staleLoad;
  });

  assert.deepEqual(hook.result.current.tree, [
    { name: 'fresh.md', path: 'docs/fresh.md', type: 'file' },
  ]);
  hook.unmount();
});

void test('useComputerFiles ignores an older refresh for the same browse path', async () => {
  restoreDocument = installShellAuthDocument();
  let resolveStaleTree: ((response: Response) => void) | null = null;
  const fetchMock = installFetchSequence(
    () =>
      new Promise<Response>((resolve) => {
        resolveStaleTree = resolve;
      }),
    () =>
      jsonResponse({
        root: 'computer',
        tree: [{ name: 'fresh.md', path: 'fresh.md', type: 'file' }],
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  let staleLoad: Promise<void> | undefined;
  await hook.run((current) => {
    staleLoad = current.loadTree();
  });
  await Promise.resolve();
  await hook.run((current) => current.loadTree());
  assert.deepEqual(hook.result.current.tree, [
    { name: 'fresh.md', path: 'fresh.md', type: 'file' },
  ]);

  assert.ok(resolveStaleTree);
  const completeStaleTree: (response: Response) => void = resolveStaleTree;
  assert.ok(staleLoad);
  await hook.run(async () => {
    completeStaleTree(
      jsonResponse({
        root: 'computer',
        tree: [{ name: 'stale.md', path: 'stale.md', type: 'file' }],
      }),
    );
    await staleLoad;
  });

  assert.deepEqual(hook.result.current.tree, [
    { name: 'fresh.md', path: 'fresh.md', type: 'file' },
  ]);
  hook.unmount();
});

void test('useComputerFiles ignores a subtree response invalidated by a full refresh', async () => {
  restoreDocument = installShellAuthDocument();
  let resolveStaleSubtree: ((response: Response) => void) | null = null;
  const freshTree = [
    {
      name: 'docs',
      path: 'docs',
      type: 'directory' as const,
      children: [
        { name: 'fresh.md', path: 'docs/fresh.md', type: 'file' as const },
      ],
    },
  ];
  const fetchMock = installFetchSequence(
    () =>
      new Promise<Response>((resolve) => {
        resolveStaleSubtree = resolve;
      }),
    () => jsonResponse({ root: 'computer', tree: freshTree }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  let staleLoad: Promise<void> | undefined;
  await hook.run((current) => {
    staleLoad = current.loadSubtree('docs');
  });
  await Promise.resolve();
  await hook.run((current) => current.loadTree());
  assert.deepEqual(hook.result.current.tree, freshTree);

  assert.ok(resolveStaleSubtree);
  const completeStaleSubtree: (response: Response) => void =
    resolveStaleSubtree;
  assert.ok(staleLoad);
  await hook.run(async () => {
    completeStaleSubtree(
      jsonResponse({
        root: 'computer',
        tree: [{ name: 'deleted.md', path: 'docs/deleted.md', type: 'file' }],
      }),
    );
    await staleLoad;
  });

  assert.deepEqual(hook.result.current.tree, freshTree);
  hook.unmount();
});

void test('useComputerFiles ignores a stale tree failure after browse navigation', async () => {
  restoreDocument = installShellAuthDocument();
  let rejectStaleTree: ((reason?: unknown) => void) | null = null;
  const fetchMock = installFetchSequence(
    () =>
      new Promise<Response>((_resolve, reject) => {
        rejectStaleTree = reject;
      }),
    () =>
      jsonResponse({
        root: 'computer',
        tree: [{ name: 'fresh.md', path: 'docs/fresh.md', type: 'file' }],
      }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  let staleLoad: Promise<void> | undefined;
  await hook.run((current) => {
    staleLoad = current.loadTree();
  });
  await Promise.resolve();
  await hook.run((current) => current.navigateInto('docs'));
  await hook.run((current) => current.loadTree());

  assert.ok(rejectStaleTree);
  const failStaleTree: (reason?: unknown) => void = rejectStaleTree;
  assert.ok(staleLoad);
  await hook.run(async () => {
    failStaleTree(new Error('stale root failed'));
    await staleLoad;
  });

  assert.equal(hook.result.current.browsePath, 'docs');
  assert.equal(hook.result.current.treeError, null);
  assert.deepEqual(hook.result.current.tree, [
    { name: 'fresh.md', path: 'docs/fresh.md', type: 'file' },
  ]);
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

void test('useComputerFiles persists the four most recently used files across remounts', async () => {
  restoreDocument = installShellAuthDocument();
  const installedStorage = installRecentFileStorage();
  restoreStorage = installedStorage.restore;
  const paths = ['one.md', 'two.md', 'three.md', 'four.md', 'five.md'];
  const fetchMock = installFetchSequence(
    ...paths.map(
      (path, index) => () =>
        jsonResponse({
          path,
          content: path,
          versionToken: `v${index + 1}`,
          totalLines: 1,
          startLine: 1,
          endLine: 1,
        }),
    ),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  for (const path of paths) {
    await hook.run((current) => current.openFile(path));
  }

  assert.deepEqual(hook.result.current.recentFiles, [
    'five.md',
    'four.md',
    'three.md',
    'two.md',
  ]);

  await hook.run((current) => current.activateTab('three.md'));
  await hook.run((current) => current.closeTab('three.md'));

  assert.deepEqual(hook.result.current.recentFiles, [
    'three.md',
    'five.md',
    'four.md',
    'two.md',
  ]);

  const requestCountBeforeRemoval = fetchMock.calls.length;
  await hook.run((current) => current.removeRecentFile('four.md'));

  assert.deepEqual(hook.result.current.recentFiles, [
    'three.md',
    'five.md',
    'two.md',
  ]);
  assert.equal(fetchMock.calls.length, requestCountBeforeRemoval);
  hook.unmount();

  const reloadedHook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);
  assert.deepEqual(reloadedHook.result.current.recentFiles, [
    'three.md',
    'five.md',
    'two.md',
  ]);
  assert.equal(
    installedStorage.storage.getItem(RECENT_FILE_STORAGE_KEY),
    JSON.stringify(['three.md', 'five.md', 'two.md']),
  );
  reloadedHook.unmount();
});

void test('useComputerFiles ignores malformed persisted recent-file state', async () => {
  restoreDocument = installShellAuthDocument();
  const installedStorage = installRecentFileStorage('{not-json');
  restoreStorage = installedStorage.restore;

  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  assert.deepEqual(hook.result.current.recentFiles, []);
  hook.unmount();
});

void test('useComputerFiles opens browser-playable images and media as streaming URLs', async () => {
  restoreDocument = installShellAuthDocument();
  // 미디어는 blob 다운로드 없이 raw URL을 직접 쓴다 — fetch가 불리면 실패
  const fetchMock = installFetchSequence(() => {
    throw new Error('media preview must not download the file');
  });
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useComputerFiles, COMPUTER_FILE_SCOPE);

  await hook.run((current) => current.openFile('photo.png'));

  assert.equal(hook.result.current.binaryPreview?.kind, 'image');
  assert.equal(hook.result.current.binaryPreview?.path, 'photo.png');
  assert.match(
    hook.result.current.binaryPreview?.url ?? '',
    /\/api\/files\/raw\?root=computer&path=photo\.png/,
  );

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
