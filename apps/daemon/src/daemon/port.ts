const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * OS가 빈 포트를 고르게 하는 요청. 제품 실행은 포트를 지정하지 않으므로 여기로
 * 온다: 고정 포트가 이미 점유되어 앱이 아예 열리지 않는 실패를 없앤다. 실제로
 * bind된 포트는 listen 뒤에 admission lock에 기록되어 발견 가능해진다.
 *
 * 개발 흐름의 고정 포트는 데몬의 관심사가 아니다. 그 값은
 * `scripts/dev-daemon-port.mjs`가 소유하고 dev supervisor가 `PORT`로 넘긴다.
 */
export const EPHEMERAL_DAEMON_PORT = 0;

/**
 * `PORT`가 있으면 그 값만 쓰고, 없으면 OS가 고르게 한다. 값이 있는데 유효하지
 * 않으면 조용히 다른 포트로 넘어가지 않는다 — 지정한 포트로 열리지 않았다는
 * 사실이 드러나야 한다.
 */
export function readDaemonPort(value?: string): number {
  if (value === undefined) {
    return EPHEMERAL_DAEMON_PORT;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new Error(`invalid PORT: ${value}`);
  }

  return parsed;
}
