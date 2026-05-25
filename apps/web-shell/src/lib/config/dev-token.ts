const UNRESOLVED_VITE_PLACEHOLDER = /^%[A-Z0-9_]+%$/;

export function normalizeConfiguredDevToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '' || UNRESOLVED_VITE_PLACEHOLDER.test(trimmed)) {
    return null;
  }
  return trimmed;
}
