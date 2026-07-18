import { createAppShellView, type AppShellView } from './app-shell.js';
import { useProviderAuthState } from './use-provider-auth-state.js';

export function useAppShell(): AppShellView {
  const providerAuth = useProviderAuthState();

  return createAppShellView({
    providerAuth,
  });
}
