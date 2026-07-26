import { HomeShell } from './HomeShell.js';
import { useProviderAuthState } from './use-provider-auth-state.js';
import './App.css';

export function App() {
  const providerAuth = useProviderAuthState();

  return (
    <>
      <HomeShell
        providerAuthStatuses={providerAuth.providerAuthStatuses}
        providerAuthBusyProviderId={providerAuth.providerAuthBusyProviderId}
        providerAuthErrors={providerAuth.providerAuthErrors}
        onConnectProvider={providerAuth.handleConnectProvider}
        onDisconnectProvider={providerAuth.handleDisconnectProvider}
      />
      {providerAuth.providerAuthNotice ? (
        <div className="app-toast" role="status" aria-live="polite">
          {providerAuth.providerAuthNotice}
        </div>
      ) : null}
    </>
  );
}
