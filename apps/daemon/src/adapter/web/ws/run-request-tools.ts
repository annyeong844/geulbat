import type { RunStartRequest } from '@geulbat/protocol/run-contract';

export function normalizeAllowedPublicToolNames(
  request: RunStartRequest,
): string[] | undefined {
  const hints = request.allowedPublicToolNames;
  if (!hints || hints.length === 0) {
    return undefined;
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const hint of hints) {
    const name = hint.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    normalized.push(name);
  }

  return normalized.length > 0 ? normalized : undefined;
}
