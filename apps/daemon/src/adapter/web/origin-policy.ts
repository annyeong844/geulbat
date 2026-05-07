const LOOPBACK_ORIGIN_PATTERN =
  /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/;

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

export function isAllowedBrowserOrigin(
  origin: string | undefined,
  configuredAllowedOrigins: ReadonlySet<string>,
): boolean {
  return (
    typeof origin === 'string' &&
    (LOOPBACK_ORIGIN_PATTERN.test(origin) ||
      configuredAllowedOrigins.has(origin))
  );
}
