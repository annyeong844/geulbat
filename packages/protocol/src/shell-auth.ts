export const DEV_TOKEN_HEADER_NAME = 'X-Geulbat-Dev-Token';

/**
 * 데몬이 서빙하는 진입 문서에 shell 접속 토큰을 싣는 자리.
 *
 * `<meta>`인 이유: CSP가 `default-src 'self'`라 인라인 스크립트를 실행할 수
 * 없고, 스크립트 해시를 매 요청 계산하는 것보다 값을 마크업으로 두는 것이
 * 단순하다. 문서 자체는 same-origin에서만 읽힌다.
 */
export const SHELL_ACCESS_TOKEN_META_NAME = 'geulbat-shell-access-token';
