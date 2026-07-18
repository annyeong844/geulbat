import type {
  ProviderAuthProviderId,
  ProviderAuthStatusResponse,
} from '@geulbat/protocol/provider-auth';
import {
  getProviderAuthButtonStyle,
  providerAuthCardStyles,
} from './provider-auth-card-styles.js';

type ProviderAuthStatusByProvider = Record<
  ProviderAuthProviderId,
  ProviderAuthStatusResponse | null
>;
type ProviderAuthErrorByProvider = Record<
  ProviderAuthProviderId,
  string | null
>;

interface Props {
  statuses: ProviderAuthStatusByProvider;
  busyProviderId: ProviderAuthProviderId | null;
  uiErrors?: ProviderAuthErrorByProvider;
  onConnect: (providerId: ProviderAuthProviderId) => Promise<void> | void;
  onDisconnect: (providerId: ProviderAuthProviderId) => Promise<void> | void;
}

const PROVIDER_ROWS: Array<{
  providerId: ProviderAuthProviderId;
  label: string;
}> = [
  { providerId: 'openai_codex_direct', label: 'Codex' },
  { providerId: 'grok_oauth', label: 'Grok' },
];

export function ProviderAuthCard({
  statuses,
  busyProviderId,
  uiErrors,
  onConnect,
  onDisconnect,
}: Props) {
  return (
    <section
      className="provider-auth-card"
      style={providerAuthCardStyles.section}
    >
      <h3>Provider Auth</h3>
      <div style={providerAuthCardStyles.providerList}>
        {PROVIDER_ROWS.map((row) => (
          <ProviderAuthRow
            key={row.providerId}
            providerId={row.providerId}
            label={row.label}
            status={statuses[row.providerId]}
            busy={busyProviderId !== null}
            rowBusy={busyProviderId === row.providerId}
            uiError={uiErrors?.[row.providerId] ?? null}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderAuthRow({
  providerId,
  label,
  status,
  busy,
  rowBusy,
  uiError,
  onConnect,
  onDisconnect,
}: {
  providerId: ProviderAuthProviderId;
  label: string;
  status: ProviderAuthStatusResponse | null;
  busy: boolean;
  rowBusy: boolean;
  uiError: string | null;
  onConnect: (providerId: ProviderAuthProviderId) => Promise<void> | void;
  onDisconnect: (providerId: ProviderAuthProviderId) => Promise<void> | void;
}) {
  const state = status?.state ?? 'missing';
  const description = getDescription(status);
  const statusWarning =
    state === 'ready' ? (status?.lastErrorMessage ?? null) : null;
  const actionLabel = rowBusy ? 'Working...' : getActionLabel(state);

  return (
    <div style={providerAuthCardStyles.providerRow}>
      <div style={providerAuthCardStyles.providerHeader}>
        <strong>{label}</strong>
        <span style={providerAuthCardStyles.statusLabel}>{state}</span>
      </div>
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
      <div style={providerAuthCardStyles.actionRow}>
        {state === 'ready' ? (
          <button
            onClick={() => void onDisconnect(providerId)}
            disabled={busy}
            style={getProviderAuthButtonStyle('danger', busy)}
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={() => void onConnect(providerId)}
            disabled={busy}
            style={getProviderAuthButtonStyle('primary', busy)}
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
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
