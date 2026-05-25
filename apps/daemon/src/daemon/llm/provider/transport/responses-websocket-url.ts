export function resolveCodexWebSocketUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  const codexUrl = normalized.endsWith('/codex/responses')
    ? normalized
    : normalized.endsWith('/codex')
      ? `${normalized}/responses`
      : `${normalized}/codex/responses`;
  const url = new URL(codexUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  return url.toString();
}
