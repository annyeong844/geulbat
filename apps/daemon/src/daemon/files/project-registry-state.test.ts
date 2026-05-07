import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  createProjectRegistryStore,
  DEFAULT_PROJECT_ID,
} from './project-registry-state.js';

void test('createProjectRegistryStore isolates roots and registry entries per instance', () => {
  const firstRoot = resolve('/tmp/geulbat-first');
  const secondRoot = resolve('/tmp/geulbat-second');
  const first = createProjectRegistryStore({ root: firstRoot });
  const second = createProjectRegistryStore({ root: secondRoot });

  assert.equal(
    first.resolveProjectRoot(DEFAULT_PROJECT_ID),
    resolve(firstRoot, 'workspace'),
  );
  assert.equal(
    second.resolveProjectRoot(DEFAULT_PROJECT_ID),
    resolve(secondRoot, 'workspace'),
  );

  first.replaceProjectRegistry([
    { projectId: DEFAULT_PROJECT_ID, label: 'Workspace' },
    { projectId: 'alpha' as typeof DEFAULT_PROJECT_ID, label: 'Alpha' },
  ]);

  assert.equal(first.isKnownProjectId('alpha'), true);
  assert.equal(second.isKnownProjectId('alpha'), false);
  assert.equal(
    first.resolveProjectRoot('alpha' as typeof DEFAULT_PROJECT_ID),
    resolve(firstRoot, 'alpha'),
  );
  assert.equal(
    second.resolveProjectRoot(DEFAULT_PROJECT_ID),
    resolve(secondRoot, 'workspace'),
  );
});

void test('configureProjectRegistryRoot rematerializes workspace roots without mutating labels', () => {
  const beforeRoot = resolve('/tmp/geulbat-before');
  const afterRoot = resolve('/tmp/geulbat-after');
  const store = createProjectRegistryStore({ root: beforeRoot });
  store.replaceProjectRegistry([
    { projectId: DEFAULT_PROJECT_ID, label: 'Workspace' },
    { projectId: 'draft' as typeof DEFAULT_PROJECT_ID, label: 'Draft' },
  ]);

  store.configureProjectRegistryRoot(afterRoot);

  assert.deepEqual(store.listProjects(), [
    { projectId: DEFAULT_PROJECT_ID, label: 'Workspace' },
    { projectId: 'draft' as typeof DEFAULT_PROJECT_ID, label: 'Draft' },
  ]);
  assert.equal(
    store.resolveProjectRoot('draft' as typeof DEFAULT_PROJECT_ID),
    resolve(afterRoot, 'draft'),
  );
});
