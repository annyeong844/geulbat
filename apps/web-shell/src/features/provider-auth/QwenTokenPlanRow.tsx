import { useEffect, useState, type FormEvent } from 'react';

import {
  connectQwenTokenPlan,
  disconnectQwenTokenPlan,
  getQwenTokenPlanStatus,
  type QwenTokenPlanRegion,
  type QwenTokenPlanStatus,
} from '../../lib/api/qwen-token-plan.js';
import {
  getProviderAuthButtonStyle,
  providerAuthCardStyles,
} from './provider-auth-card-styles.js';

interface QwenTokenPlanApi {
  getStatus: typeof getQwenTokenPlanStatus;
  connect: typeof connectQwenTokenPlan;
  disconnect: typeof disconnectQwenTokenPlan;
}

const DEFAULT_API: QwenTokenPlanApi = {
  getStatus: getQwenTokenPlanStatus,
  connect: connectQwenTokenPlan,
  disconnect: disconnectQwenTokenPlan,
};

export function QwenTokenPlanRow({
  api = DEFAULT_API,
}: {
  api?: QwenTokenPlanApi;
}) {
  const [status, setStatus] = useState<QwenTokenPlanStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [region, setRegion] = useState<QwenTokenPlanRegion>('global');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .getStatus()
      .then((next) => {
        if (active) {
          setStatus(next);
          setRegion(next.region);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(toUiError(reason, 'Qwen 연결 상태를 불러오지 못했습니다.'));
        }
      });
    return () => {
      active = false;
    };
  }, [api]);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (apiKey.trim() === '') {
      setError('Token Plan API 키를 입력해 주세요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.connect({ apiKey, region });
      setStatus(next);
      setApiKey('');
      setEditing(false);
    } catch (reason: unknown) {
      setError(toUiError(reason, 'Qwen 연결에 실패했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.disconnect();
      setStatus(await api.getStatus());
      setEditing(false);
    } catch (reason: unknown) {
      setError(toUiError(reason, 'Qwen 연결 해제에 실패했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const ready = status?.state === 'ready';
  const environmentManaged = ready && status.source === 'environment';
  const stateLabel = status === null ? '확인 중' : ready ? '연결됨' : '미연결';
  const closeEditor = () => {
    setApiKey('');
    setError(null);
    setEditing(false);
  };

  return (
    <div style={providerAuthCardStyles.providerRow}>
      <div style={providerAuthCardStyles.providerHeader}>
        <span
          aria-label={stateLabel}
          title={stateLabel}
          style={{
            ...providerAuthCardStyles.statusDot,
            background: ready ? 'var(--secondary)' : 'var(--outline-variant)',
          }}
        />
        <strong>Qwen</strong>
        {status === null ? (
          <button
            type="button"
            disabled
            style={getProviderAuthButtonStyle('primary', true)}
          >
            확인 중…
          </button>
        ) : environmentManaged ? (
          <span style={providerAuthCardStyles.connectionBadge}>환경 변수</span>
        ) : ready ? (
          <button
            type="button"
            onClick={() => void disconnect()}
            disabled={busy}
            style={getProviderAuthButtonStyle('danger', busy)}
          >
            {busy ? '처리 중…' : '연결 해제'}
          </button>
        ) : editing ? (
          <button
            type="button"
            onClick={closeEditor}
            disabled={busy}
            aria-expanded="true"
            style={getProviderAuthButtonStyle('danger', busy)}
          >
            취소
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
            disabled={busy}
            aria-expanded="false"
            style={getProviderAuthButtonStyle('primary', busy)}
          >
            연결
          </button>
        )}
      </div>
      {environmentManaged ? (
        <p style={providerAuthCardStyles.description}>환경 변수로 연결됨</p>
      ) : null}
      {status?.state === 'missing' && editing ? (
        <form
          style={providerAuthCardStyles.credentialEditor}
          onSubmit={(event) => void connect(event)}
        >
          <p style={providerAuthCardStyles.editorIntro}>
            Qwen3.8 Max Preview · Alibaba ModelStudio Token Plan
            <br />
            OAuth가 아닌 Token Plan API 키로 연결합니다.
          </p>
          <div style={providerAuthCardStyles.fieldGrid}>
            <label style={providerAuthCardStyles.fieldLabel}>
              <span>API 키</span>
              <input
                aria-label="Qwen Token Plan API 키"
                type="password"
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setApiKey(event.target.value)}
                disabled={busy}
                placeholder="BAILIAN Token Plan API 키"
                style={providerAuthCardStyles.fieldControl}
              />
            </label>
            <label style={providerAuthCardStyles.fieldLabel}>
              <span>리전</span>
              <select
                aria-label="Qwen Token Plan 리전"
                value={region}
                onChange={(event) =>
                  setRegion(event.target.value as QwenTokenPlanRegion)
                }
                disabled={busy}
                style={providerAuthCardStyles.fieldControl}
              >
                <option value="global">Global / Singapore</option>
                <option value="china">China / Beijing</option>
              </select>
            </label>
          </div>
          <div style={providerAuthCardStyles.editorFooter}>
            <p style={providerAuthCardStyles.securityNote}>
              키는 브라우저에 저장하지 않습니다. daemon은 기본 사용자 프로필에
              저장하며 Git 작업 트리 안의 저장 경로는 거부합니다.
            </p>
            <button
              type="submit"
              disabled={busy}
              style={getProviderAuthButtonStyle('primary', busy)}
            >
              {busy ? '처리 중…' : '연결'}
            </button>
          </div>
        </form>
      ) : null}
      {error ? (
        <div role="alert" style={providerAuthCardStyles.alert}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

function toUiError(reason: unknown, fallback: string): string {
  return reason instanceof Error ? `${fallback} ${reason.message}` : fallback;
}
