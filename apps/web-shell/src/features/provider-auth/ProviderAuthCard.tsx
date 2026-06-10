import type { ProviderAuthStatusResponse } from '@geulbat/protocol/provider-auth';
import {
  getProviderAuthButtonStyle,
  providerAuthCardStyles,
} from './provider-auth-card-styles.js';

interface Props {
  status: ProviderAuthStatusResponse | null;
  busy: boolean;
  uiError?: string | null;
  onConnect: () => Promise<void> | void;
  onDisconnect: () => Promise<void> | void;
}

export function ProviderAuthCard({
  status,
  busy,
  uiError,
  onConnect,
  onDisconnect,
}: Props) {
  const state = status?.state ?? 'missing';
  const description = getDescription(status);
  const statusWarning =
    state === 'ready' ? (status?.lastErrorMessage ?? null) : null;
  const actionLabel = getActionLabel(state);

  return (
    <section
      className="provider-auth-card"
      style={providerAuthCardStyles.section}
    >
      <h3>Provider Auth</h3>
      <p style={providerAuthCardStyles.description}>{description}</p>
      {uiError ? (
        <div role="alert" style={providerAuthCardStyles.alert}>
          {uiError}
        </div>
      ) : statusWarning ? (
        <div role="alert" style={providerAuthCardStyles.alert}>
          {statusWarning}
        </div>
      ) : null}
      <div style={providerAuthCardStyles.statusRow}>
        Status: <strong>{state}</strong>
      </div>
      <div style={providerAuthCardStyles.actionRow}>
        {state === 'ready' ? (
          <button
            onClick={() => void onDisconnect()}
            disabled={busy}
            style={getProviderAuthButtonStyle('#d93025', busy)}
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={() => void onConnect()}
            disabled={busy}
            style={getProviderAuthButtonStyle('#1a73e8', busy)}
          >
            {actionLabel}
          </button>
        )}
      </div>
    </section>
  );
}

function getDescription(status: ProviderAuthStatusResponse | null): string {
  const state = status?.state ?? 'missing';
  if (state === 'pending') {
    return 'Browser login is waiting. Complete the provider login, then return here.';
  }
  if (state === 'ready') {
    if (status?.lastErrorMessage) {
      return 'Provider account is connected, but the latest token refresh did not complete cleanly.';
    }
    return 'Provider account is connected.';
  }
  if (state === 'exchange_failed') {
    return (
      status?.lastErrorMessage ?? 'Provider login failed. Retry the login flow.'
    );
  }
  if (state === 'expired') {
    return (
      status?.lastErrorMessage ??
      'Provider login session expired. Reconnect the provider.'
    );
  }
  return 'Connect a provider account to enable assistant runs.';
}

function getActionLabel(
  state: ProviderAuthStatusResponse['state'] | 'missing',
): string {
  if (state === 'pending') {
    return 'Continue Login';
  }
  if (state === 'missing') {
    return 'Connect Provider';
  }
  return 'Reconnect Provider';
}
