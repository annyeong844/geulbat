import type { ProjectListItem } from '@geulbat/protocol/projects';
import type { ProviderAuthStatusResponse } from '@geulbat/protocol/provider-auth';

import type { ProjectWorkspaceProps } from './project-workspace-shell.js';

interface AppProviderAuthInput {
  providerAuthStatus: ProviderAuthStatusResponse | null;
  providerAuthBusy: boolean;
  providerAuthError: string | null;
  providerAuthNotice: string | null;
  handleConnectProvider: () => Promise<void> | void;
  handleDisconnectProvider: () => Promise<void> | void;
}

interface AppProjectRegistryInput {
  selectedProjectId: string;
  defaultProjectId: string;
  projects: ProjectListItem[];
  projectError: string | null;
  mutationBusy: boolean;
  selectProject: (projectId: string) => void;
  addProject: (label: string) => Promise<boolean>;
  renameProject: (projectId: string, label: string) => Promise<boolean>;
  deleteProject: (projectId: string) => Promise<boolean>;
}

interface AppShellView {
  workspaceKey: string;
  workspaceProps: ProjectWorkspaceProps;
  providerAuthNotice: string | null;
}

interface CreateAppShellViewArgs {
  providerAuth: AppProviderAuthInput;
  projectRegistry: AppProjectRegistryInput;
}

export function createAppShellView({
  providerAuth,
  projectRegistry,
}: CreateAppShellViewArgs): AppShellView {
  return {
    workspaceKey: projectRegistry.selectedProjectId,
    workspaceProps: {
      projectId: projectRegistry.selectedProjectId,
      defaultProjectId: projectRegistry.defaultProjectId,
      projects: projectRegistry.projects,
      projectRegistryError: projectRegistry.projectError,
      projectRegistryBusy: projectRegistry.mutationBusy,
      onSelectProject: projectRegistry.selectProject,
      onCreateProject: projectRegistry.addProject,
      onRenameProject: projectRegistry.renameProject,
      onDeleteProject: projectRegistry.deleteProject,
      providerAuthStatus: providerAuth.providerAuthStatus,
      providerAuthBusy: providerAuth.providerAuthBusy,
      providerAuthError: providerAuth.providerAuthError,
      onConnectProvider: providerAuth.handleConnectProvider,
      onDisconnectProvider: providerAuth.handleDisconnectProvider,
    },
    providerAuthNotice: providerAuth.providerAuthNotice,
  };
}
