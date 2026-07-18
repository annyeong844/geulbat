import type {
  ProviderAuthProviderId,
  ProviderAuthStatusResponse,
} from '@geulbat/protocol/provider-auth';

import type { HomeShellProps } from './home-shell.js';

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
  homeProps: HomeShellProps;
  providerAuthNotice: string | null;
}

export interface CreateAppShellViewArgs {
  providerAuth: AppProviderAuthInput;
}

export function createAppShellView({
  providerAuth,
}: CreateAppShellViewArgs): AppShellView {
  return {
    homeProps: {
      providerAuthStatuses: providerAuth.providerAuthStatuses,
      providerAuthBusyProviderId: providerAuth.providerAuthBusyProviderId,
      providerAuthErrors: providerAuth.providerAuthErrors,
      onConnectProvider: providerAuth.handleConnectProvider,
      onDisconnectProvider: providerAuth.handleDisconnectProvider,
    },
    providerAuthNotice: providerAuth.providerAuthNotice,
  };
}
