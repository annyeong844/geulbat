/**
 * 개발 흐름의 고정 데몬 포트. 소유자가 하나여야 하는 값이다: dev supervisor가
 * 이 포트로 데몬을 띄우고 점유를 확인하며, Vite dev server가 같은 주소로 `/api`를
 * proxy한다. 두 값이 어긋나면 데몬은 뜨지만 화면이 API에 닿지 못하고, 그 실패는
 * 브라우저 콘솔에서만 보인다.
 *
 * 제품 실행은 이 값을 쓰지 않는다. 데몬은 `PORT`가 없으면 OS가 고른 포트로
 * 열리고(`EPHEMERAL_DAEMON_PORT`), 실제 포트는 admission lock에 기록된다.
 */
export const DEV_DAEMON_PORT = 3456;
