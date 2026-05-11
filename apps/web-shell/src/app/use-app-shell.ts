import { createAppShellView, type AppShellView } from './app-shell.js';
import { useProjectRegistry } from './use-project-registry.js';
import { useProviderAuthState } from './use-provider-auth-state.js';

export function useAppShell(): AppShellView {
  const providerAuth = useProviderAuthState();
  const projectRegistry = useProjectRegistry();

  return createAppShellView({
    providerAuth,
    projectRegistry,
  });
}
