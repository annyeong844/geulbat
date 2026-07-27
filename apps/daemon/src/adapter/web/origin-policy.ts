/**
 * 데몬은 평문 http로만 듣는다. 앞단에서 TLS를 끊는 배치는 데몬이 알 수 없으므로
 * 그런 origin은 `GEULBAT_ALLOWED_ORIGINS`로 선언되어야 한다.
 */
const SERVED_PROTOCOL = 'http';

function normalizeAllowedOrigin(candidate: string): string {
  const url = new URL(candidate);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `GEULBAT_ALLOWED_ORIGINS must use http/https origins: ${candidate}`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      `GEULBAT_ALLOWED_ORIGINS must not include credentials: ${candidate}`,
    );
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      `GEULBAT_ALLOWED_ORIGINS entries must be bare origins: ${candidate}`,
    );
  }
  return url.origin;
}

export function readConfiguredAllowedOrigins(
  raw = process.env['GEULBAT_ALLOWED_ORIGINS'],
): ReadonlySet<string> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return new Set<string>();
  }

  const configured = new Set<string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    configured.add(normalizeAllowedOrigin(trimmed));
  }
  return configured;
}

/**
 * 요청이 도착한 origin. 브라우저의 `Origin` 헤더와 비교할 대상이므로 요청이
 * 실제로 향한 곳에서만 만든다 — `Host`가 없거나 origin으로 읽히지 않으면
 * 비교할 대상이 없고, 그때는 어떤 origin도 "같다"로 볼 수 없다.
 */
export function readRequestSelfOrigin(
  host: string | undefined,
): string | undefined {
  if (typeof host !== 'string' || host.trim() === '') {
    return undefined;
  }

  try {
    return new URL(`${SERVED_PROTOCOL}://${host}`).origin;
  } catch {
    return undefined;
  }
}

/**
 * 브라우저가 이 표면에 붙어도 되는 origin인지 판정한다.
 *
 * 데몬이 화면까지 서빙하므로 정상적인 브라우저 origin은 요청이 도착한 origin
 * 하나다. 그래서 기준은 same-origin이다. 예전에는 loopback이면 포트를 묻지 않고
 * 통과시켰는데, 그 폭은 shell과 데몬이 서로 다른 포트에 있던 위상에서만
 * 필요했고 그동안 같은 기계의 다른 로컬 페이지까지 함께 열어 두었다.
 *
 * `GEULBAT_ALLOWED_ORIGINS`는 그대로 남는다. 터널처럼 다른 origin에서 붙이겠다고
 * 운영자가 밝힌 경우이고, 추측이 아니라 선언이다.
 */
export function isAllowedBrowserOrigin(
  origin: string | undefined,
  configuredAllowedOrigins: ReadonlySet<string>,
  selfOrigin: string | undefined,
): boolean {
  if (typeof origin !== 'string') {
    return false;
  }

  return (
    (selfOrigin !== undefined && origin === selfOrigin) ||
    configuredAllowedOrigins.has(origin)
  );
}
