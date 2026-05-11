import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  getDefaultProjectRenameConflictMessage,
  getSelectedProjectDeleteConflictMessage,
} from '@geulbat/protocol/projects';

import { useProjectRegistry } from './use-project-registry.js';
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

void test('useProjectRegistry keeps the fallback project when initial load fails', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(() =>
    textResponse(500, 'registry failed'),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(() => useProjectRegistry(), undefined);

  await hook.flush();

  assert.equal(
    hook.result.current.projectError,
    'Unable to load project list. API 500: registry failed',
  );
  assert.equal(hook.result.current.defaultProjectId, 'workspace');
  assert.equal(hook.result.current.selectedProjectId, 'workspace');
  assert.deepEqual(hook.result.current.projects, [
    { projectId: 'workspace', label: 'Workspace' },
  ]);
  hook.unmount();
});

void test('useProjectRegistry rejects default-project rename locally', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(() =>
    jsonResponse({
      defaultProjectId: 'workspace',
      projects: [
        { projectId: 'workspace', label: 'Workspace' },
        { projectId: 'alpha', label: 'Alpha' },
      ],
    }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(() => useProjectRegistry(), undefined);

  await hook.flush();
  const result = await hook.run((current) =>
    current.renameProject('workspace', 'Renamed'),
  );

  assert.equal(result, false);
  assert.equal(
    hook.result.current.projectError,
    getDefaultProjectRenameConflictMessage(),
  );
  assert.equal(fetchMock.calls.length, 1);
  hook.unmount();
});

void test('useProjectRegistry rejects deleting the selected project locally', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(() =>
    jsonResponse({
      defaultProjectId: 'workspace',
      projects: [
        { projectId: 'workspace', label: 'Workspace' },
        { projectId: 'alpha', label: 'Alpha' },
      ],
    }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(() => useProjectRegistry(), undefined);

  await hook.flush();
  await hook.run((current) => current.selectProject('alpha'));
  const result = await hook.run((current) => current.deleteProject('alpha'));

  assert.equal(result, false);
  assert.equal(
    hook.result.current.projectError,
    getSelectedProjectDeleteConflictMessage(),
  );
  assert.equal(fetchMock.calls.length, 1);
  hook.unmount();
});

void test('useProjectRegistry selects projects without scanning the project array', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(() =>
    jsonResponse({
      defaultProjectId: 'workspace',
      projects: [
        { projectId: 'workspace', label: 'Workspace' },
        { projectId: 'alpha', label: 'Alpha' },
      ],
    }),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(() => useProjectRegistry(), undefined);

  await hook.flush();
  const projects = hook.result.current.projects;
  const originalFind = projects.find;
  let findCalls = 0;
  Object.defineProperty(projects, 'find', {
    configurable: true,
    value: (...args: Parameters<typeof originalFind>) => {
      findCalls += 1;
      return originalFind.call(projects, ...args);
    },
  });

  try {
    await hook.run((current) => current.selectProject('alpha'));
  } finally {
    Object.defineProperty(projects, 'find', {
      configurable: true,
      value: originalFind,
    });
  }

  assert.equal(hook.result.current.selectedProjectId, 'alpha');
  assert.equal(findCalls, 0);
  hook.unmount();
});

void test('useProjectRegistry clears mutationBusy after delete failures', async () => {
  restoreDocument = installShellAuthDocument();
  const fetchMock = installFetchSequence(
    () =>
      jsonResponse({
        defaultProjectId: 'workspace',
        projects: [
          { projectId: 'workspace', label: 'Workspace' },
          { projectId: 'alpha', label: 'Alpha' },
        ],
      }),
    () => textResponse(500, 'delete failed'),
  );
  restoreFetch = fetchMock.restore;
  const hook = await renderHook(() => useProjectRegistry(), undefined);

  await hook.flush();
  const result = await hook.run((current) => current.deleteProject('alpha'));

  assert.equal(result, false);
  assert.equal(hook.result.current.mutationBusy, false);
  assert.equal(
    hook.result.current.projectError,
    'Unable to delete project. API 500: delete failed',
  );
  assert.deepEqual(hook.result.current.projects, [
    { projectId: 'workspace', label: 'Workspace' },
    { projectId: 'alpha', label: 'Alpha' },
  ]);
  hook.unmount();
});
