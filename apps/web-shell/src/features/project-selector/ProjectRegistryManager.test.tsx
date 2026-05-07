import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  getProjectRegistryDeleteDescription,
  getSelectedProjectDeleteConflictMessage,
} from '@geulbat/protocol/projects';
import { ProjectRegistryManager } from './ProjectRegistryManager.js';
import { brandProjectId } from '../../lib/id-brand-helpers.js';

void test('ProjectRegistryManager renders add form and project metadata badges', () => {
  const html = renderToStaticMarkup(
    <ProjectRegistryManager
      projects={[
        { projectId: brandProjectId('workspace'), label: 'Workspace' },
        { projectId: brandProjectId('manuscript'), label: 'Manuscript' },
      ]}
      defaultProjectId="workspace"
      selectedProjectId="workspace"
      disabled={false}
      busy={false}
      onCreate={async () => true}
      onRename={async () => true}
      onDelete={async () => true}
    />,
  );

  assert.match(html, /Manage projects/);
  assert.match(html, /placeholder="New project label"/);
  assert.match(html, /default/);
  assert.match(html, /current/);
  assert.match(html, /Rename/);
  assert.match(html, /Delete/);
});

void test('ProjectRegistryManager renders disabled helper note', () => {
  const html = renderToStaticMarkup(
    <ProjectRegistryManager
      projects={[
        { projectId: brandProjectId('workspace'), label: 'Workspace' },
      ]}
      defaultProjectId="workspace"
      selectedProjectId="workspace"
      disabled={true}
      busy={false}
      helperText="Finish or cancel the current run before managing projects."
      onCreate={async () => true}
      onRename={async () => true}
      onDelete={async () => true}
    />,
  );

  assert.match(html, /disabled=""/);
  assert.match(
    html,
    /Finish or cancel the current run before managing projects/,
  );
});

void test('ProjectRegistryManager explains registry-only delete semantics and selected-project block', () => {
  const html = renderToStaticMarkup(
    <ProjectRegistryManager
      projects={[
        { projectId: brandProjectId('workspace'), label: 'Workspace' },
        { projectId: brandProjectId('manuscript'), label: 'Manuscript' },
      ]}
      defaultProjectId="workspace"
      selectedProjectId="manuscript"
      disabled={false}
      busy={false}
      onCreate={async () => true}
      onRename={async () => true}
      onDelete={async () => true}
    />,
  );

  assert.match(html, new RegExp(getSelectedProjectDeleteConflictMessage()));
  assert.doesNotMatch(html, new RegExp(getProjectRegistryDeleteDescription()));
});
