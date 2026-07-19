const DEFAULT_CODEX_RESPONSES_URL =
  'https://chatgpt.com/backend-api/codex/responses';

export function resolveCodexResponsesUrl(configuredUrl?: string): string {
  const normalized = (
    configuredUrl ??
    process.env.GEULBAT_BACKEND_URL ??
    DEFAULT_CODEX_RESPONSES_URL
  ).replace(/\/+$/u, '');
  if (normalized.endsWith('/codex/responses')) {
    return normalized;
  }
  if (normalized.endsWith('/codex')) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

export function resolveCodexWebSocketUrl(baseUrl: string): string {
  const url = new URL(resolveCodexResponsesUrl(baseUrl));
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  }
  if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }
  return url.toString();
}
