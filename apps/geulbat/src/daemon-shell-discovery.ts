/**
 * 지금 도는 데몬의 화면 주소를 찾는다.
 *
 * 제품 데몬은 `PORT` 없이 열리므로 포트를 OS가 고른다. 사람이 그 값을 알 수
 * 없으니 소유권을 기록한 admission lock이 접속 지점도 함께 나른다. 이 모듈은
 * 그 기록을 주소로 바꾸고, "이미 도는 데몬이 있는가"를 판정한다.
 *
 * 파일 접근과 프로세스 생존 확인은 주입받는다 — 판정 규칙만 여기 있고 테스트는
 * 파일시스템 없이 그 규칙을 잠근다.
 */

interface DiscoveredDaemonShell {
  /** 브라우저로 열 주소. */
  url: string;
  /** 기록을 남긴 데몬 프로세스. 살아있는지는 호출부가 판정한다. */
  pid: number;
}

interface DaemonShellDiscoveryDeps {
  /** admission lock의 소유자 기록. 없으면 `null`. */
  readLockOwner: () => Promise<{ pid: number; port?: number } | null>;
  /** 기록된 프로세스가 살아있는가. */
  isProcessAlive: (pid: number) => boolean;
}

/**
 * 살아있는 데몬의 화면 주소. 아래 세 경우는 모두 `null`이다.
 *
 * 1. lock이 없다 — 데몬이 없다
 * 2. lock에 포트가 없다 — bind 전이거나 기록 전이다
 * 3. 기록된 프로세스가 죽었다 — lock이 남았을 뿐이다
 *
 * `null`은 "새로 띄워야 한다"는 뜻이고, 값이 있으면 "그것을 열라"는 뜻이다.
 * 죽은 데몬의 주소를 돌려주면 CLI가 열리지 않는 창을 띄운다.
 */
export async function discoverRunningDaemonShell(
  deps: DaemonShellDiscoveryDeps,
): Promise<DiscoveredDaemonShell | null> {
  const owner = await deps.readLockOwner();
  if (owner === null || owner.port === undefined) {
    return null;
  }
  if (!deps.isProcessAlive(owner.pid)) {
    return null;
  }

  return { pid: owner.pid, url: buildDaemonShellUrl(owner.port) };
}

/**
 * 데몬은 기본적으로 loopback에만 바인딩하므로 주소도 loopback이다. 호스트 이름을
 * 설정에서 읽지 않는 이유: 여기서 다른 호스트를 쓰면 브라우저가 데몬이 실제로
 * 듣지 않는 주소를 연다.
 */
export function buildDaemonShellUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}
