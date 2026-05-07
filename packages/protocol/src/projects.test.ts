import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDefaultProjectDeleteConflictMessage,
  getDefaultProjectRenameConflictMessage,
  getProjectRegistryDeleteDescription,
  getSelectedProjectDeleteConflictMessage,
  isProjectListResponse,
} from './projects.js';

void test('isProjectListResponse requires canonical project ids', () => {
  assert.equal(
    isProjectListResponse({
      defaultProjectId: 'workspace',
      projects: [
        { projectId: 'workspace', label: 'Workspace' },
        { projectId: 'story-notes', label: 'Story Notes' },
      ],
    }),
    true,
  );

  assert.equal(
    isProjectListResponse({
      defaultProjectId: 'workspace',
      projects: [{ projectId: '../escape', label: 'Bad' }],
    }),
    false,
  );
});

void test('project mutation messaging stays explicit about fixed default and registry-only delete semantics', () => {
  assert.equal(
    getDefaultProjectRenameConflictMessage(),
    'Default project label is fixed and cannot be renamed.',
  );
  assert.equal(
    getDefaultProjectDeleteConflictMessage(),
    'Default project is kept in the registry and cannot be deleted.',
  );
  assert.equal(
    getSelectedProjectDeleteConflictMessage(),
    'Switch to another project before removing this project from the registry.',
  );
  assert.equal(
    getProjectRegistryDeleteDescription(),
    'Removing a project only unregisters it. Workspace files stay on disk.',
  );
});
