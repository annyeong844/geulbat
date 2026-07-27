import {
  clearStoredPtcCallbackTransportPolicy,
  resolvePtcCallbackTransportPolicy,
  writeStoredPtcCallbackTransportPolicy,
  type PtcCallbackTransportPolicy,
} from './ptc/callback/callback-transport-policy-record.js';

export { resolvePtcCallbackTransportPolicy };
export type { PtcCallbackTransportPolicy };

// PTC transition spec v7 §3 (2026-07-27) — 조립이 "운영자 정책이 어디 사는가"를 정하고,
// 라우트는 그 포트만 쓴다. 라우트가 Home 경로나 레코드 형식을 알면 저장 위치가 두 곳에서
// 정의되기 때문이다.

export type PtcCallbackTransportSettingsStatus =
  | { state: 'disabled' }
  | {
      state: 'ready';
      source: 'environment' | 'stored';
      policy: PtcCallbackTransportPolicy;
    };

export interface PtcCallbackTransportSettingsPort {
  getStatus: () => Promise<PtcCallbackTransportSettingsStatus>;
  savePolicy: (policy: PtcCallbackTransportPolicy) => Promise<void>;
  clearPolicy: () => Promise<void>;
}

export function createPtcCallbackTransportSettingsPort(deps: {
  homeStateRoot: string;
}): PtcCallbackTransportSettingsPort {
  return {
    getStatus: () => {
      const resolved = resolvePtcCallbackTransportPolicy({
        homeStateRoot: deps.homeStateRoot,
      });
      if (resolved.policy === undefined) {
        return Promise.resolve({ state: 'disabled' });
      }
      return Promise.resolve({
        state: 'ready',
        // 환경이 관리 중이면 표면은 그 사실을 알려야 한다 — 저장된 값을 보여 주면
        // 운영자가 본 값과 실제 적용 값이 갈라진다.
        source: resolved.source === 'environment' ? 'environment' : 'stored',
        policy: resolved.policy,
      });
    },
    savePolicy: (policy) =>
      writeStoredPtcCallbackTransportPolicy({
        homeStateRoot: deps.homeStateRoot,
        policy,
      }),
    clearPolicy: () =>
      clearStoredPtcCallbackTransportPolicy(deps.homeStateRoot),
  };
}
