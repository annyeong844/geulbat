const SHELL_AUTH_FAILURE_WINDOW_MS = 60_000;
export const SHELL_AUTH_FAILURE_LIMIT = 8;
export const MAX_SHELL_AUTH_FAILURE_WINDOWS = 1024;

interface AuthFailureWindow {
  count: number;
  resetAt: number;
}

const authFailureWindows = new Map<string, AuthFailureWindow>();

function deriveShellAuthRateLimitKey(
  remoteAddress: string | null | undefined,
): string {
  if (typeof remoteAddress !== 'string' || remoteAddress.trim() === '') {
    return 'unknown';
  }
  return remoteAddress.trim();
}

export function clearShellAuthFailures(
  remoteAddress: string | null | undefined,
): void {
  authFailureWindows.delete(deriveShellAuthRateLimitKey(remoteAddress));
}

export function recordShellAuthFailure(
  remoteAddress: string | null | undefined,
  now = Date.now(),
): {
  limited: boolean;
  retryAfterSeconds: number;
} {
  pruneExpiredShellAuthFailureWindows(now);
  const key = deriveShellAuthRateLimitKey(remoteAddress);
  const existing = authFailureWindows.get(key);

  if (!existing || now >= existing.resetAt) {
    const resetAt = now + SHELL_AUTH_FAILURE_WINDOW_MS;
    authFailureWindows.set(key, { count: 1, resetAt });
    pruneShellAuthFailureWindowsToCap(key);
    return {
      limited: false,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  authFailureWindows.set(key, existing);
  pruneShellAuthFailureWindowsToCap(key);
  return {
    limited: existing.count > SHELL_AUTH_FAILURE_LIMIT,
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

export function resetShellAuthFailureRateLimitForTests(): void {
  authFailureWindows.clear();
}

export function getShellAuthFailureWindowCountForTests(): number {
  return authFailureWindows.size;
}

function pruneExpiredShellAuthFailureWindows(now: number): void {
  for (const [key, window] of authFailureWindows) {
    if (now >= window.resetAt) {
      authFailureWindows.delete(key);
    }
  }
}

function pruneShellAuthFailureWindowsToCap(
  protectedKey: string | undefined,
): void {
  if (authFailureWindows.size <= MAX_SHELL_AUTH_FAILURE_WINDOWS) {
    return;
  }

  const candidates = [...authFailureWindows.entries()]
    .filter(([key]) => key !== protectedKey)
    .sort((left, right) => left[1].resetAt - right[1].resetAt);

  while (
    authFailureWindows.size > MAX_SHELL_AUTH_FAILURE_WINDOWS &&
    candidates.length > 0
  ) {
    const entry = candidates.shift();
    if (!entry) {
      break;
    }
    authFailureWindows.delete(entry[0]);
  }
}
