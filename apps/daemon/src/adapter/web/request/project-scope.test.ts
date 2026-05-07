import test from 'node:test';
import assert from 'node:assert/strict';

import { createProjectRegistryStore } from '../../../daemon/files/project-registry-state.js';
import { testProjectId } from '../../../test-support/project-id.js';
import {
  readProjectIdParam,
  readProjectWorkspaceScope,
  readProjectWorkspaceScopeFromBody,
  readProjectWorkspaceScopeFromQuery,
  readThreadIdParam,
} from './project-scope.js';

function createTestProjectRegistry() {
  const projectRegistry = createProjectRegistryStore({
    root: '/tmp/project-scope-local',
  });
  projectRegistry.replaceProjectRegistry([
    { projectId: testProjectId('workspace'), label: 'Workspace' },
    { projectId: testProjectId('draft'), label: 'Draft' },
  ]);
  return projectRegistry;
}

void test('readProjectWorkspaceScopeFromQuery resolves canonical workspace roots', () => {
  const projectRegistry = createTestProjectRegistry();
  const result = readProjectWorkspaceScopeFromQuery('workspace', {
    projectRegistry,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.projectId, 'workspace');
    assert.match(result.workspaceRoot, /workspace$/);
  }
});

void test('readProjectWorkspaceScopeFromBody reports missing projectId as bad_request', () => {
  const result = readProjectWorkspaceScopeFromBody(
    {},
    {
      projectRegistry: createTestProjectRegistry(),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'bad_request');
    assert.equal(result.message, 'projectId must be a string');
  }
});

void test('readProjectWorkspaceScope reports missing projectId as bad_request', () => {
  const result = readProjectWorkspaceScope(undefined, {
    projectRegistry: createTestProjectRegistry(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'bad_request');
    assert.equal(result.message, 'projectId is required');
  }
});

void test('readProjectIdParam rejects unknown project ids', () => {
  const result = readProjectIdParam('unknown-project', {
    projectRegistry: createTestProjectRegistry(),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'not_found');
    assert.equal(result.message, 'unknown projectId: unknown-project');
  }
});

void test('readThreadIdParam rejects malformed thread ids', () => {
  const result = readThreadIdParam('../thread');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'bad_request');
    assert.equal(result.message, 'invalid threadId');
  }
});

void test('readProjectWorkspaceScope can use an injected project registry store', () => {
  const projectRegistry = createTestProjectRegistry();

  const result = readProjectWorkspaceScope('draft', { projectRegistry });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.projectId, 'draft');
    assert.match(result.workspaceRoot, /draft$/);
  }
});
