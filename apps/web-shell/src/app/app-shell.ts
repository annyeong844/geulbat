import type {
  ProviderAuthProviderId,
  ProviderAuthStatusResponse,
} from '@geulbat/protocol/provider-auth';

import type { ProjectWorkspaceProps } from './project-workspace-shell.js';

interface AppProviderAuthInput {
  providerAuthStatuses: Record<
    ProviderAuthProviderId,
    ProviderAuthStatusResponse | null
  >;
  providerAuthBusyProviderId: ProviderAuthProviderId | null;
  providerAuthErrors: Record<ProviderAuthProviderId, string | null>;
  providerAuthNotice: string | null;
  handleConnectProvider: (
    providerId?: ProviderAuthProviderId,
  ) => Promise<void> | void;
  handleDisconnectProvider: (
    providerId?: ProviderAuthProviderId,
  ) => Promise<void> | void;
}

export interface AppShellView {
  workspaceKey: string;
  workspaceProps: ProjectWorkspaceProps;
  providerAuthNotice: string | null;
}

export interface CreateAppShellViewArgs {
  providerAuth: AppProviderAuthInput;
}

export function createAppShellView({
  providerAuth,
}: CreateAppShellViewArgs): AppShellView {
  return {
    workspaceKey: 'home',
    workspaceProps: {
      providerAuthStatuses: providerAuth.providerAuthStatuses,
      providerAuthBusyProviderId: providerAuth.providerAuthBusyProviderId,
      providerAuthErrors: providerAuth.providerAuthErrors,
      onConnectProvider: providerAuth.handleConnectProvider,
      onDisconnectProvider: providerAuth.handleDisconnectProvider,
    },
    providerAuthNotice: providerAuth.providerAuthNotice,
  };
}
