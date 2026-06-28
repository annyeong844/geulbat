import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { useWorkspaceFiles } from './use-workspace-files.js';
import {
  installFetchSequence,
  installShellAuthDocument,
  jsonResponse,
  renderHook,
  textResponse,
} from '../test-support/hook-test.js';

let restoreDocument = () => {};
let restoreFetch = () => {};

afterEach(() => {
  restoreFetch();
  restoreFetch = () => {};
  restoreDocument();
  restoreDocument = () => {};
});

void test('useWorkspaceFiles surfaces loadTree failures', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(() =>
    textResponse(500, 'tree failed'),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useWorkspaceFiles, 'workspace');

  await hook.run((current) => current.loadTree());

  assert.equal(
    hook.result.current.treeError,
    'Unable to load project files. API 500: tree failed',
  );
  assert.deepEqual(hook.result.current.tree, []);
  hook.unmount();
});

void test('useWorkspaceFiles records stale write conflicts during save', async () => {
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
  const hook = await renderHook(useWorkspaceFiles, 'workspace');

  await hook.run((current) => current.openFile('notes.md'));
  await hook.run((current) => current.handleContentChange('edited'));
  await hook.run((current) => current.handleSave());

  assert.equal(hook.result.current.isDirty, true);
  assert.equal(hook.result.current.saving, false);
  assert.equal(hook.result.current.editorError, null);
  assert.equal(hook.result.current.saveConflict?.currentVersionToken, 'v2');
  hook.unmount();
});

void test('useWorkspaceFiles force save reuses the conflict version token', async () => {
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
        versionToken: string;
      };
      assert.equal(body.versionToken, 'v2');
      return jsonResponse({
        path: 'notes.md',
        versionToken: 'v3',
        totalLines: 1,
        ok: true,
      });
    },
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(useWorkspaceFiles, 'workspace');

  await hook.run((current) => current.openFile('notes.md'));
  await hook.run((current) => current.handleContentChange('edited'));
  await hook.run((current) => current.handleSave());
  await hook.run((current) => current.handleConflictForceSave());

  assert.equal(hook.result.current.isDirty, false);
  assert.equal(hook.result.current.saving, false);
  assert.equal(hook.result.current.saveConflict, null);
  assert.equal(hook.result.current.editorError, null);
  hook.unmount();
});
