import { useCallback, useEffect, useState } from 'react';

import type { ProviderAuthProviderId } from '@geulbat/protocol/provider-auth';
import type {
  ProviderUsageEntry,
  ProviderUsageWindow,
} from '@geulbat/protocol/provider-usage';

import {
  getProviderAuthButtonStyle,
  providerAuthCardStyles as styles,
} from '../provider-auth/provider-auth-card-styles.js';

/**
 * 제공자가 보고하는 사용량 카드.
 *
 * 우리가 토큰을 세지 않는다 — 표시되는 값은 모두 제공자가 계산한 것이다. 그래서
 * 조회에 실패하면 0이나 추정치로 채우지 않고 실패를 그대로 보여준다.
 */

const PROVIDER_LABELS: Record<ProviderAuthProviderId, string> = {
  openai_codex_direct: 'Codex',
  grok_oauth: 'Grok',
};

interface Props {
  loadUsage: (options?: {
    forceRefresh?: boolean;
  }) => Promise<{ providers: ProviderUsageEntry[] }>;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; providers: ProviderUsageEntry[] }
  | { kind: 'failed'; message: string };

export function ProviderUsageCard({ loadUsage }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const refresh = useCallback(
    async (forceRefresh: boolean) => {
      setState({ kind: 'loading' });
      try {
        const response = await loadUsage(
          forceRefresh ? { forceRefresh: true } : undefined,
        );
        setState({ kind: 'loaded', providers: response.providers });
      } catch {
        // 조회 실패를 빈 값으로 위장하지 않는다.
        setState({
          kind: 'failed',
          message: '사용량을 불러오지 못했습니다. 데몬 연결을 확인해 주세요.',
        });
      }
    },
    [loadUsage],
  );

  useEffect(() => {
    // 첫 표시는 캐시를 쓴다 — 설정을 열 때마다 원격 왕복을 기다리지 않는다.
    void refresh(false);
  }, [refresh]);

  return (
    <section className="provider-usage-card" style={styles.section}>
      <h3>사용량</h3>
      <p style={styles.description}>
        제공자가 보고한 값입니다. 글밭이 직접 계산하지 않습니다. 잠시 전에 읽은
        값을 그대로 보여주며, 다시 불러오기를 누르면 제공자에게 새로 묻습니다.
      </p>

      {state.kind === 'failed' ? (
        <p style={styles.alert} role="alert">
          {state.message}
        </p>
      ) : null}

      <div style={styles.providerList}>
        {state.kind === 'loading' ? (
          <p style={styles.description}>불러오는 중…</p>
        ) : null}
        {state.kind === 'loaded'
          ? state.providers.map((entry) => (
              <ProviderUsageRow key={entry.providerId} entry={entry} />
            ))
          : null}
      </div>

      <div style={styles.actionRow}>
        <button
          type="button"
          style={getProviderAuthButtonStyle(
            'primary',
            state.kind === 'loading',
          )}
          disabled={state.kind === 'loading'}
          onClick={() => void refresh(true)}
        >
          다시 불러오기
        </button>
      </div>
    </section>
  );
}

function ProviderUsageRow({ entry }: { entry: ProviderUsageEntry }) {
  const label = PROVIDER_LABELS[entry.providerId];
  return (
    <div style={styles.providerRow}>
      <div style={styles.providerHeader}>
        <span
          style={{
            ...styles.statusDot,
            background:
              entry.state === 'reported'
                ? 'var(--primary)'
                : entry.state === 'failed'
                  ? 'var(--error)'
                  : 'var(--outline-variant)',
          }}
          aria-hidden="true"
        />
        <span>{label}</span>
        <span style={styles.connectionBadge}>{describeState(entry)}</span>
      </div>
      <ProviderUsageDetail entry={entry} />
    </div>
  );
}

function describeState(entry: ProviderUsageEntry): string {
  switch (entry.state) {
    case 'not_connected':
      return '연결 안 됨';
    case 'not_provided':
      return '제공 안 함';
    case 'failed':
      return '조회 실패';
    case 'reported':
      return entry.planLabel ?? '보고됨';
  }
}

function ProviderUsageDetail({ entry }: { entry: ProviderUsageEntry }) {
  if (entry.state === 'not_connected') {
    return (
      <p style={styles.editorIntro}>
        연결하면 제공자가 보고하는 사용량을 볼 수 있습니다.
      </p>
    );
  }
  if (entry.state === 'not_provided') {
    return <p style={styles.editorIntro}>{entry.reason}</p>;
  }
  if (entry.state === 'failed') {
    return (
      <p style={styles.editorIntro} role="alert">
        {entry.message}
      </p>
    );
  }
  return (
    <div style={{ marginTop: 8 }}>
      {entry.measurement.windows.map((window, index) => (
        <UsageWindowBar
          key={`${window.windowMinutes ?? 'window'}-${index}`}
          window={window}
        />
      ))}
      <p style={styles.securityNote}>{formatReadAt(entry.readAt)}</p>
    </div>
  );
}

function UsageWindowBar({ window }: { window: ProviderUsageWindow }) {
  const percent = clampPercent(window.usedPercent);
  const name = formatWindowLength(window.windowMinutes);
  return (
    <div style={{ margin: '0 0 10px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 8,
          fontFamily: 'var(--font-ui-label)',
          fontSize: 12,
          color: 'var(--on-surface-variant)',
        }}
      >
        <span>{name}</span>
        <span>{`${percent.toFixed(percent < 10 ? 1 : 0)}% 사용`}</span>
      </div>
      <div
        role="meter"
        aria-label={`${name} 사용률`}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 6,
          marginTop: 5,
          borderRadius: 999,
          background: 'var(--surface-container-low)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${percent}%`,
            height: '100%',
            background: percent >= 90 ? 'var(--error)' : 'var(--primary)',
          }}
        />
      </div>
      {window.resetAt !== undefined ? (
        <p style={{ ...styles.securityNote, marginTop: 4 }}>
          {`${formatResetAt(window.resetAt)} 초기화`}
        </p>
      ) : null}
    </div>
  );
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

function formatWindowLength(windowMinutes: number | undefined): string {
  if (windowMinutes === undefined) {
    return '사용 한도';
  }
  if (windowMinutes % (60 * 24) === 0) {
    return `${windowMinutes / (60 * 24)}일 한도`;
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}시간 한도`;
  }
  return `${windowMinutes}분 한도`;
}

function formatResetAt(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleString();
}

function formatReadAt(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? `조회 시각 ${iso}`
    : `${parsed.toLocaleTimeString()} 기준`;
}
