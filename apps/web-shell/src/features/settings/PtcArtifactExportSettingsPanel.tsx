import { useCallback, useEffect, useState } from 'react';

import type {
  PtcArtifactExportPolicy,
  PtcArtifactExportSettingsStatus,
} from '@geulbat/protocol/ptc-artifacts';

import {
  ptcArtifactExportSettingsClient,
  type PtcArtifactExportSettingsClient,
} from '../../lib/api/ptc-artifact-export.js';
import {
  getProviderAuthButtonStyle,
  providerAuthCardStyles as styles,
} from '../provider-auth/provider-auth-card-styles.js';

interface PtcArtifactExportSettingsPanelProps {
  client?: PtcArtifactExportSettingsClient;
}

/** 화면 입력은 파일 개수·MB 단위. wire/policy는 바이트. */
interface PolicyDraft {
  maxFiles: string;
  maxFileMb: string;
  maxTotalMb: string;
}

const MIB = 1024 * 1024;

/**
 * 빈 칸에서 바로 켤 때 쓰는 실사용 기본 한도.
 * PTC 한 실행의 플롯·CSV 묶음 정도(파일 십수 개, 파일당 수 MB)를 기준으로 잡고
 * 회색 placeholder(개 / MB)로만 보이며 입력하면 사라진다.
 */
const DEFAULT_LIMITS = {
  maxFiles: 16,
  maxFileMb: 8,
  maxTotalMb: 32,
} as const;

const EMPTY_DRAFT: PolicyDraft = {
  maxFiles: '',
  maxFileMb: '',
  maxTotalMb: '',
};

type ViewState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      status: PtcArtifactExportSettingsStatus;
      draft: PolicyDraft;
      saving: boolean;
      error?: string;
    };

export function PtcArtifactExportSettingsPanel({
  client = ptcArtifactExportSettingsClient,
}: PtcArtifactExportSettingsPanelProps) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const status = await client.getStatus();
      setState({
        kind: 'ready',
        status,
        draft: draftFromStatus(status),
        saving: false,
      });
    } catch {
      setState({
        kind: 'ready',
        status: { state: 'disabled' },
        draft: EMPTY_DRAFT,
        saving: false,
        error:
          '아티팩트 내보내기 설정을 불러오지 못했습니다. 데몬 연결과 설정 파일을 확인해 주세요.',
      });
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') {
    return (
      <section style={styles.section}>
        <header className="settings-page-heading">
          <div>
            <h2>PTC 아티팩트</h2>
            <p>설정을 불러오는 중…</p>
          </div>
        </header>
      </section>
    );
  }

  const environmentManaged =
    state.status.state === 'ready' && state.status.source === 'environment';
  const updateDraft = (field: keyof PolicyDraft, value: string) => {
    setState((current) =>
      current.kind === 'loading'
        ? current
        : {
            kind: 'ready',
            status: current.status,
            draft: { ...current.draft, [field]: value },
            saving: current.saving,
          },
    );
  };
  const enable = async () => {
    const policy = parsePolicyDraft(state.draft);
    if (policy === null) {
      setState({
        ...state,
        error:
          '한도는 비우거나 1 이상 숫자로 입력해 주세요. 용량은 MB 단위입니다.',
      });
      return;
    }
    setState({
      kind: 'ready',
      status: state.status,
      draft: state.draft,
      saving: true,
    });
    try {
      const status = await client.enable(policy);
      setState({
        kind: 'ready',
        status,
        draft: draftFromStatus(status),
        saving: false,
      });
    } catch {
      setState({
        ...state,
        saving: false,
        error: '아티팩트 내보내기 설정을 켜지 못했습니다.',
      });
    }
  };
  const disable = async () => {
    setState({
      kind: 'ready',
      status: state.status,
      draft: state.draft,
      saving: true,
    });
    try {
      const status = await client.disable();
      setState({
        kind: 'ready',
        status,
        draft: draftFromStatus(status),
        saving: false,
      });
    } catch {
      setState({
        ...state,
        saving: false,
        error: '아티팩트 내보내기 설정을 끄지 못했습니다.',
      });
    }
  };

  return (
    <section style={styles.section}>
      <header className="settings-page-heading">
        <div>
          <h2>PTC 아티팩트</h2>
          <p>
            코드가 <code>/geulbat/artifacts</code>에 만든 파일을 실행 결과에서
            다시 열거나 내려받을 수 있게 합니다. 파일 내용은 모델 대화 기록에
            넣지 않습니다.
          </p>
        </div>
      </header>

      <p style={styles.description}>
        상태:{' '}
        {state.status.state === 'disabled'
          ? '꺼짐'
          : state.status.source === 'environment'
            ? '환경에서 관리 중'
            : '켜짐'}
      </p>
      {environmentManaged ? (
        <p style={styles.alert}>
          환경변수로 관리되는 값입니다. 이 화면에서는 변경하거나 끌 수 없습니다.
        </p>
      ) : null}
      {state.error ? (
        <p style={styles.alert} role="alert">
          {state.error}
        </p>
      ) : null}

      <div style={styles.credentialEditor}>
        <div style={styles.fieldGrid}>
          <PolicyField
            label="실행당 최대 파일 수"
            value={state.draft.maxFiles}
            placeholder={`${DEFAULT_LIMITS.maxFiles}개`}
            disabled={environmentManaged || state.saving}
            onChange={(value) => updateDraft('maxFiles', value)}
          />
          <PolicyField
            label="파일당 최대"
            value={state.draft.maxFileMb}
            placeholder={`${DEFAULT_LIMITS.maxFileMb} MB`}
            disabled={environmentManaged || state.saving}
            onChange={(value) => updateDraft('maxFileMb', value)}
          />
          <PolicyField
            label="실행당 전체 최대"
            value={state.draft.maxTotalMb}
            placeholder={`${DEFAULT_LIMITS.maxTotalMb} MB`}
            disabled={environmentManaged || state.saving}
            onChange={(value) => updateDraft('maxTotalMb', value)}
          />
        </div>
        <div style={styles.editorFooter}>
          <div style={styles.actionRow}>
            <button
              type="button"
              style={getProviderAuthButtonStyle(
                'primary',
                environmentManaged || state.saving,
              )}
              disabled={environmentManaged || state.saving}
              onClick={() => void enable()}
            >
              켜기
            </button>
            <button
              type="button"
              style={getProviderAuthButtonStyle(
                'danger',
                environmentManaged ||
                  state.saving ||
                  state.status.state === 'disabled',
              )}
              disabled={
                environmentManaged ||
                state.saving ||
                state.status.state === 'disabled'
              }
              onClick={() => void disable()}
            >
              끄기
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function PolicyField(props: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label style={styles.fieldLabel}>
      {props.label}
      <input
        style={styles.fieldControl}
        type="text"
        inputMode="decimal"
        placeholder={props.placeholder}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function draftFromStatus(status: PtcArtifactExportSettingsStatus): PolicyDraft {
  if (status.state === 'disabled') {
    return EMPTY_DRAFT;
  }
  return {
    maxFiles: String(status.policy.maxFiles),
    maxFileMb: formatMb(status.policy.maxFileBytes),
    maxTotalMb: formatMb(status.policy.maxTotalBytes),
  };
}

function parsePolicyDraft(draft: PolicyDraft): PtcArtifactExportPolicy | null {
  const maxFiles = parseCountField(draft.maxFiles, DEFAULT_LIMITS.maxFiles);
  const maxFileBytes = parseMbField(draft.maxFileMb, DEFAULT_LIMITS.maxFileMb);
  const maxTotalBytes = parseMbField(
    draft.maxTotalMb,
    DEFAULT_LIMITS.maxTotalMb,
  );
  if (maxFiles === null || maxFileBytes === null || maxTotalBytes === null) {
    return null;
  }
  return { maxFiles, maxFileBytes, maxTotalBytes };
}

/** 비어 있으면 기본 개수, 값이 있으면 양의 정수(개 접미사 허용). */
function parseCountField(raw: string, fallback: number): number | null {
  const trimmed = stripCountUnit(raw);
  if (trimmed === '') {
    return fallback;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** 비어 있으면 기본 MB→바이트, 값이 있으면 MB 숫자(MB 접미사 허용). */
function parseMbField(raw: string, fallbackMb: number): number | null {
  const trimmed = stripMbUnit(raw);
  if (trimmed === '') {
    return fallbackMb * MIB;
  }
  const mb = Number(trimmed);
  if (!Number.isFinite(mb) || mb <= 0) {
    return null;
  }
  const bytes = mb * MIB;
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

function stripCountUnit(raw: string): string {
  return raw
    .trim()
    .replace(/\s*개\s*$/u, '')
    .trim();
}

function stripMbUnit(raw: string): string {
  return raw
    .trim()
    .replace(/\s*MB\s*$/iu, '')
    .trim();
}

function formatMb(bytes: number): string {
  const mb = bytes / MIB;
  if (Number.isInteger(mb)) {
    return String(mb);
  }
  // 정수 MiB가 아닌 기존 저장값도 읽기 쉽게 소수로 보여 준다.
  return String(Math.round(mb * 1000) / 1000);
}
