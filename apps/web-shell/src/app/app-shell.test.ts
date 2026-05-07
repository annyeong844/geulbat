import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProjectListItem } from '@geulbat/protocol/projects';

import { brandProjectId } from '../lib/id-brand-helpers.js';
import { createAppShellView } from './app-shell.js';

type CreateAppShellViewArgs = Parameters<typeof createAppShellView>[0];

const PROJECT_ID = brandProjectId('workspace');

function createProjectStub(): ProjectListItem {
  return {
    projectId: PROJECT_ID,
    label: 'Workspace',
  };
}

function createProviderAuthStub(): CreateAppShellViewArgs['providerAuth'] {
  return {
    providerAuthStatus: {
      state: 'ready',
      ready: true,
    },
    providerAuthBusy: true,
    providerAuthError: 'auth failed',
    providerAuthNotice: 'Provider auth refreshed.',
    handleConnectProvider: () => {},
    handleDisconnectProvider: () => {},
  };
}

function createProjectRegistryStub(): CreateAppShellViewArgs['projectRegistry'] {
  return {
    selectedProjectId: PROJECT_ID,
    defaultProjectId: PROJECT_ID,
    projects: [createProjectStub()],
    projectError: 'registry failed',
    mutationBusy: true,
    selectProject: () => {},
    addProject: async () => true,
    renameProject: async () => true,
    deleteProject: async () => true,
  };
}

void test('createAppShellView maps provider auth and project registry inputs into workspace props and toast notice', () => {
  const providerAuth = createProviderAuthStub();
  const projectRegistry = createProjectRegistryStub();

  const shell = createAppShellView({
    providerAuth,
    projectRegistry,
  });

  assert.equal(shell.workspaceKey, PROJECT_ID);
  assert.equal(shell.providerAuthNotice, 'Provider auth refreshed.');
  assert.equal(shell.workspaceProps.projectId, PROJECT_ID);
  assert.equal(shell.workspaceProps.defaultProjectId, PROJECT_ID);
  assert.equal(shell.workspaceProps.projectRegistryError, 'registry failed');
  assert.equal(shell.workspaceProps.projectRegistryBusy, true);
  assert.equal(shell.workspaceProps.projects, projectRegistry.projects);
  assert.equal(
    shell.workspaceProps.providerAuthStatus,
    providerAuth.providerAuthStatus,
  );
  assert.equal(shell.workspaceProps.providerAuthBusy, true);
  assert.equal(shell.workspaceProps.providerAuthError, 'auth failed');
  assert.equal(
    shell.workspaceProps.onConnectProvider,
    providerAuth.handleConnectProvider,
  );
  assert.equal(
    shell.workspaceProps.onDisconnectProvider,
    providerAuth.handleDisconnectProvider,
  );
});
