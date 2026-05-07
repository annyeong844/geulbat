import { createAppShellView } from './app-shell.js';
import { useProjectRegistry } from './use-project-registry.js';
import { useProviderAuthState } from './use-provider-auth-state.js';

type CreateAppShellViewArgs = Parameters<typeof createAppShellView>[0];

export function useAppShell(): ReturnType<typeof createAppShellView> {
  const providerAuth = useProviderAuthState();
  const projectRegistry = useProjectRegistry();

  const providerAuthInput: CreateAppShellViewArgs['providerAuth'] = {
    providerAuthStatus: providerAuth.providerAuthStatus,
    providerAuthBusy: providerAuth.providerAuthBusy,
    providerAuthError: providerAuth.providerAuthError,
    providerAuthNotice: providerAuth.providerAuthNotice,
    handleConnectProvider: providerAuth.handleConnectProvider,
    handleDisconnectProvider: providerAuth.handleDisconnectProvider,
  };

  const projectRegistryInput: CreateAppShellViewArgs['projectRegistry'] = {
    selectedProjectId: projectRegistry.selectedProjectId,
    defaultProjectId: projectRegistry.defaultProjectId,
    projects: projectRegistry.projects,
    projectError: projectRegistry.projectError,
    mutationBusy: projectRegistry.mutationBusy,
    selectProject: projectRegistry.selectProject,
    addProject: projectRegistry.addProject,
    renameProject: projectRegistry.renameProject,
    deleteProject: projectRegistry.deleteProject,
  };

  return createAppShellView({
    providerAuth: providerAuthInput,
    projectRegistry: projectRegistryInput,
  });
}
