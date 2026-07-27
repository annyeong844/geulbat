import type {
  ProviderAuthProviderId,
  ProviderAuthStatusResponse,
} from '@geulbat/protocol/provider-auth';
import { isProviderAuthConnectedStatus } from '../../lib/api/provider-auth.js';
import { QwenTokenPlanRow } from './QwenTokenPlanRow.js';
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

export interface ProviderAuthCardProps {
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
}: ProviderAuthCardProps) {
  return (
    <section
      className="provider-auth-card"
      style={providerAuthCardStyles.section}
    >
      <h3>AI 제공자 연결</h3>
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
        <QwenTokenPlanRow />
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
  const connected = isProviderAuthConnectedStatus(status);
  const displayState = state === 'ready' && !connected ? 'pending' : state;
  const description = getDescription(status);
  const statusWarning = connected ? (status?.lastErrorMessage ?? null) : null;
  const actionLabel = rowBusy ? '처리 중…' : getActionLabel(displayState);

  // 시선 이동 최소화 — 상태 점·이름·행동이 한 줄에 붙어 있다
  return (
    <div style={providerAuthCardStyles.providerRow}>
      <div style={providerAuthCardStyles.providerHeader}>
        <span
          aria-label={getStateLabel(displayState)}
          title={getStateLabel(displayState)}
          style={{
            ...providerAuthCardStyles.statusDot,
            background: getStateDotColor(displayState),
          }}
        />
        <strong>{label}</strong>
        {connected ? (
          <button
            onClick={() => void onDisconnect(providerId)}
            disabled={busy}
            style={getProviderAuthButtonStyle('danger', busy)}
          >
            {rowBusy ? '처리 중…' : '연결 해제'}
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
      {description !== null ? (
        <p style={providerAuthCardStyles.description}>{description}</p>
      ) : null}
      {uiError ? (
        <div role="alert" style={providerAuthCardStyles.alert}>
          {uiError}
        </div>
      ) : statusWarning ? (
        <div role="alert" style={providerAuthCardStyles.alert}>
          {statusWarning}
        </div>
      ) : null}
    </div>
  );
}

// 연결됨·미연결의 평시 상태는 점과 버튼만으로 읽힌다 — 설명문은
// 사용자가 행동해야 하는 예외 상태에만 붙인다.
function getDescription(
  status: ProviderAuthStatusResponse | null,
): string | null {
  const state = status?.state ?? 'missing';
  if (status?.state === 'ready' && !status.ready) {
    return '로그인 결과를 확인하고 있습니다. 잠시 후 연결 상태가 갱신됩니다.';
  }
  if (state === 'pending') {
    return '브라우저 로그인이 진행 중입니다. 제공자 로그인을 마친 뒤 이곳으로 돌아와 주세요.';
  }
  if (state === 'exchange_failed') {
    return (
      status?.lastErrorMessage ??
      '로그인에 실패했습니다. 로그인 과정을 다시 시도해 주세요.'
    );
  }
  if (state === 'expired') {
    return (
      status?.lastErrorMessage ??
      '로그인 세션이 만료되었습니다. 제공자를 다시 연결해 주세요.'
    );
  }
  return null;
}

function getStateDotColor(
  state: ProviderAuthStatusResponse['state'] | 'missing',
): string {
  if (state === 'ready') {
    return 'var(--secondary)';
  }
  if (state === 'pending') {
    return 'var(--tertiary)';
  }
  if (state === 'exchange_failed' || state === 'expired') {
    return 'var(--error)';
  }
  return 'var(--outline-variant)';
}

function getStateLabel(
  state: ProviderAuthStatusResponse['state'] | 'missing',
): string {
  if (state === 'ready') {
    return '연결됨';
  }
  if (state === 'pending') {
    return '로그인 대기';
  }
  if (state === 'exchange_failed') {
    return '로그인 실패';
  }
  if (state === 'expired') {
    return '만료됨';
  }
  return '미연결';
}

function getActionLabel(
  state: ProviderAuthStatusResponse['state'] | 'missing',
): string {
  if (state === 'pending') {
    return '로그인 계속하기';
  }
  if (state === 'missing') {
    return '연결';
  }
  return '다시 연결';
}
