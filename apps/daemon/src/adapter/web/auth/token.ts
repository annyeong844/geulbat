import { createHash, timingSafeEqual } from 'node:crypto';

const MIN_DEV_TOKEN_LENGTH = 16;

/**
 * 이 프로세스가 쓰는 shell 접속 토큰. 부팅이 한 번 정하고 그 뒤로는 바뀌지
 * 않는다.
 *
 * `process.env`에 되쓰지 않는 이유: 데몬은 PTC 컨테이너와 command-host 워커를
 * 포함해 여러 자식을 띄운다. 환경에 두면 그 자식들이 모두 값을 보게 되고,
 * 모델이 만든 코드가 도는 경계에까지 자격이 흘러간다. 메모리에만 둔다.
 */
let resolvedShellAccessToken: string | undefined;

/**
 * 부팅이 결정한 토큰을 이 프로세스에 고정한다. 두 번째 호출은 같은 값이어야
 * 한다 — 값이 도중에 바뀌면 이미 인증된 소켓과 새 요청의 판정이 갈린다.
 */
export function setResolvedShellAccessToken(token: string): void {
  assertUsableDevToken(token, 'resolved shell access token');
  if (
    resolvedShellAccessToken !== undefined &&
    resolvedShellAccessToken !== token
  ) {
    throw new Error('shell access token cannot change while the daemon runs');
  }
  resolvedShellAccessToken = token;
}

export function getConfiguredDevToken(): string {
  if (resolvedShellAccessToken !== undefined) {
    return resolvedShellAccessToken;
  }

  // 부팅이 아직 토큰을 정하지 않은 경로(테스트 하네스, 진단 도구)는 환경값을
  // 쓴다. 값이 없으면 조용히 인증을 통과시키지 않고 실패한다.
  const token = process.env['GEULBAT_DEV_TOKEN'];
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('GEULBAT_DEV_TOKEN is required');
  }
  assertUsableDevToken(token, 'GEULBAT_DEV_TOKEN');
  return token;
}

export function isValidDevToken(candidate: unknown): boolean {
  if (typeof candidate !== 'string') {
    return false;
  }

  const expected = getConfiguredDevToken();
  const candidateDigest = createHash('sha256')
    .update(candidate, 'utf8')
    .digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function assertUsableDevToken(token: string, source: string): void {
  if (token.length < MIN_DEV_TOKEN_LENGTH) {
    throw new Error(
      `${source} must be at least ${MIN_DEV_TOKEN_LENGTH} characters`,
    );
  }
}
