import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProjectSelector } from './ProjectSelector.js';
import { brandProjectId } from '../../lib/id-brand-helpers.js';

void test('ProjectSelector renders daemon-derived project options', () => {
  const html = renderToStaticMarkup(
    <ProjectSelector
      projects={[
        { projectId: brandProjectId('workspace'), label: 'Workspace' },
        { projectId: brandProjectId('manuscript'), label: 'Manuscript' },
      ]}
      selectedProjectId="workspace"
      disabled={false}
      onSelect={() => {}}
    />,
  );

  assert.match(html, /Current project/);
  assert.match(
    html,
    /<option value="workspace" selected="">Workspace<\/option>/,
  );
  assert.match(html, /<option value="manuscript">Manuscript<\/option>/);
});

void test('ProjectSelector renders a switch gate note while disabled', () => {
  const html = renderToStaticMarkup(
    <ProjectSelector
      projects={[
        { projectId: brandProjectId('workspace'), label: 'Workspace' },
      ]}
      selectedProjectId="workspace"
      disabled={true}
      helperText="Finish or cancel the current run before switching projects."
      uiError="Unable to load project list."
      onSelect={() => {}}
    />,
  );

  assert.match(html, /disabled=""/);
  assert.match(
    html,
    /Finish or cancel the current run before switching projects/,
  );
  assert.match(html, /role="alert"/);
});
