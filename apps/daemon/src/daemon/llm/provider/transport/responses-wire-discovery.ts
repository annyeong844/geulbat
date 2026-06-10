export interface OAuthWireDiscoveryRequestInput {
  headers: Headers | Record<string, unknown>;
  payload: unknown;
}

export interface OAuthWireDiscoveryRecordInput {
  capturedAt: string;
  request: unknown;
  events: unknown[];
}

export interface OAuthWireDiscoveryRecord {
  schemaVersion: 1;
  transport: 'chatgpt_codex_oauth_websocket';
  captureKind: 'request_response_shape';
  capturedAt: string;
  request: unknown;
  events: unknown[];
}

const STRUCTURAL_STRING_KEYS = new Set([
  'type',
  'role',
  'status',
  'phase',
  'model',
  'finish_reason',
]);

const PROVIDER_TEXT_KEYS = new Set([
  'instructions',
  'text',
  'delta',
  'arguments',
  'content',
]);

const OAUTH_HEADER_KEYS = new Set([
  'authorization',
  'chatgpt-account-id',
  'session_id',
]);

const PROVIDER_ID_KEYS = new Set([
  'id',
  'item_id',
  'response_id',
  'call_id',
  'prompt_cache_key',
  'session_id',
]);

const WINDOWS_PATH_SEPARATOR_PATTERN = String.fromCharCode(92).repeat(2);
const WINDOWS_USER_HOME_PATTERN = new RegExp(
  ['C:', 'Users', ''].join(WINDOWS_PATH_SEPARATOR_PATTERN),
  'u',
);
const WINDOWS_USER_HOME_MARKER_PATTERN = new RegExp(
  ['C:', 'Users', String.raw`[^"\s]+`].join(WINDOWS_PATH_SEPARATOR_PATTERN),
  'u',
);

const PRIVATE_MARKERS = [
  /Bearer\s+[A-Za-z0-9._~+\-/]+=*/u,
  /chatgpt-account-id["':\s]+[A-Za-z0-9._-]+/u,
  /session[_-]?id["':\s]+[A-Za-z0-9._-]+/iu,
  /\.geulbat/u,
  /\/home\/[^"\s]+/u,
  /\/Users\/[^"\s]+/u,
  /\/tmp\/[^"\s]+/u,
  /\/mnt\/c\/Users\/[^"\s]+/u,
  WINDOWS_USER_HOME_MARKER_PATTERN,
];

export function sanitizeOAuthWireDiscoveryRequest(
  input: OAuthWireDiscoveryRequestInput,
): unknown {
  return {
    headers: sanitizeHeaders(input.headers),
    payload: sanitizeValue(input.payload, []),
  };
}

export function sanitizeOAuthWireDiscoveryEvent(event: unknown): unknown {
  return sanitizeValue(event, []);
}

export function buildOAuthWireDiscoveryRecord(
  input: OAuthWireDiscoveryRecordInput,
): OAuthWireDiscoveryRecord {
  const record: OAuthWireDiscoveryRecord = {
    schemaVersion: 1,
    transport: 'chatgpt_codex_oauth_websocket',
    captureKind: 'request_response_shape',
    capturedAt: input.capturedAt,
    request: input.request,
    events: input.events,
  };
  assertOAuthWireDiscoveryRecordIsSanitized(record);
  return record;
}

export function assertOAuthWireDiscoveryRecordIsSanitized(
  record: unknown,
): void {
  const text = JSON.stringify(record) ?? '';
  for (const marker of PRIVATE_MARKERS) {
    if (marker.test(text)) {
      throw new Error('oauth wire discovery record contains private marker');
    }
  }
}

function sanitizeHeaders(
  headers: Headers | Record<string, unknown>,
): Record<string, unknown> {
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers);
  const output: Record<string, unknown> = {};
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    output[name] = OAUTH_HEADER_KEYS.has(key)
      ? '[redacted:oauth-header]'
      : sanitizeValue(value, [name]);
  }
  return output;
}

function sanitizeValue(value: unknown, path: string[]): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value, path);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitizeValue(item, [...path, String(index)]),
    );
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = sanitizeValue(nestedValue, [...path, key]);
    }
    return output;
  }
  return value;
}

function sanitizeString(value: string, path: string[]): string {
  const key = path.at(-1)?.toLowerCase();
  if (key === 'instructions') {
    return '[redacted:prompt-text]';
  }
  if (key !== undefined && PROVIDER_ID_KEYS.has(key)) {
    return '[redacted:provider-id]';
  }
  if (looksLikeLocalPath(value)) {
    return '[redacted:local-path]';
  }
  if (key !== undefined && PROVIDER_TEXT_KEYS.has(key)) {
    return '[redacted:provider-text]';
  }
  if (key !== undefined && STRUCTURAL_STRING_KEYS.has(key)) {
    return value;
  }
  return '[redacted:provider-string]';
}

const WSL_WINDOWS_USER_HOME_PREFIX = ['', 'mnt', 'c', 'Users', ''].join('/');

function looksLikeLocalPath(value: string): boolean {
  return (
    value.includes('.geulbat') ||
    value.includes(WSL_WINDOWS_USER_HOME_PREFIX) ||
    /(?:^|[\s"'])\/(?:home|Users|tmp)\//u.test(value) ||
    WINDOWS_USER_HOME_PATTERN.test(value)
  );
}
