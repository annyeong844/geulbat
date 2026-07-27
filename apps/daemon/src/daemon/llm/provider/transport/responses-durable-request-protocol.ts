export const RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION = 1 as const;
export const RESPONSES_DURABLE_REQUEST_FRAME_PREFIX =
  'GEULBAT_RESPONSES_DURABLE_REQUEST_V1 ' as const;
export const RESPONSES_DURABLE_REQUEST_REDACTION_REPLACEMENT =
  '[provider-credential-redacted]' as const;

export interface ResponsesDurableRequestSerializedError {
  message: string;
  llmCode?: string;
  status?: number;
  retryAfterMs?: number;
}

export type ResponsesDurableRequestInputFrame =
  | {
      version: typeof RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION;
      kind: 'initialize';
      transportKind: 'websocket';
      requestIdentity: string;
      webSocketUrl: string;
      headers: [string, string][];
      serializedPayload: string;
      redactionMarkers: string[];
      completionEventTypes?: string[];
    }
  | {
      version: typeof RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION;
      kind: 'initialize';
      transportKind: 'http_json_sse';
      requestIdentity: string;
      requestUrl: string;
      headers: [string, string][];
      serializedPayload: string;
      redactionMarkers: string[];
    }
  | {
      version: typeof RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION;
      kind: 'commit';
      requestIdentity: string;
      subscriptionId: string;
      terminalArtifactPath: string;
    };

export type ResponsesDurableRequestFrame =
  | {
      version: typeof RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION;
      kind: 'accepted';
      requestIdentity: string;
      subscriptionId: string;
    }
  | {
      version: typeof RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION;
      kind: 'event';
      requestIdentity: string;
      subscriptionId: string;
      event: Record<string, unknown>;
    }
  | {
      version: typeof RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION;
      kind: 'completed';
      requestIdentity: string;
      subscriptionId: string;
    }
  | {
      version: typeof RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION;
      kind: 'failed';
      requestIdentity: string;
      subscriptionId: string;
      error: ResponsesDurableRequestSerializedError;
    };

export interface ResponsesDurableRequestTerminalArtifact {
  version: typeof RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION;
  requestIdentity: string;
  dispatched: boolean;
  events: Record<string, unknown>[];
  terminal:
    | { kind: 'completed' }
    | {
        kind: 'failed';
        error: ResponsesDurableRequestSerializedError;
      };
}

export function encodeResponsesDurableRequestFrame(
  frame: ResponsesDurableRequestInputFrame | ResponsesDurableRequestFrame,
): string {
  return `${RESPONSES_DURABLE_REQUEST_FRAME_PREFIX}${JSON.stringify(frame)}\n`;
}

export function parseResponsesDurableRequestInputFrame(
  value: unknown,
): ResponsesDurableRequestInputFrame | undefined {
  if (!isProtocolRecord(value)) {
    return undefined;
  }
  if (
    value['kind'] === 'initialize' &&
    typeof value['requestIdentity'] === 'string' &&
    typeof value['serializedPayload'] === 'string' &&
    isStringArray(value['redactionMarkers']) &&
    isStringPairArray(value['headers'])
  ) {
    if (
      value['transportKind'] === 'websocket' &&
      typeof value['webSocketUrl'] === 'string' &&
      value['requestUrl'] === undefined &&
      (value['completionEventTypes'] === undefined ||
        isStringArray(value['completionEventTypes']))
    ) {
      return {
        version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
        kind: 'initialize',
        transportKind: 'websocket',
        requestIdentity: value['requestIdentity'],
        webSocketUrl: value['webSocketUrl'],
        headers: value['headers'],
        serializedPayload: value['serializedPayload'],
        redactionMarkers: value['redactionMarkers'],
        ...(value['completionEventTypes'] === undefined
          ? {}
          : { completionEventTypes: value['completionEventTypes'] }),
      };
    }
    if (
      value['transportKind'] === 'http_json_sse' &&
      typeof value['requestUrl'] === 'string' &&
      value['webSocketUrl'] === undefined &&
      value['completionEventTypes'] === undefined
    ) {
      return {
        version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
        kind: 'initialize',
        transportKind: 'http_json_sse',
        requestIdentity: value['requestIdentity'],
        requestUrl: value['requestUrl'],
        headers: value['headers'],
        serializedPayload: value['serializedPayload'],
        redactionMarkers: value['redactionMarkers'],
      };
    }
  }
  if (
    value['kind'] === 'commit' &&
    typeof value['requestIdentity'] === 'string' &&
    typeof value['subscriptionId'] === 'string' &&
    typeof value['terminalArtifactPath'] === 'string'
  ) {
    return {
      version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
      kind: 'commit',
      requestIdentity: value['requestIdentity'],
      subscriptionId: value['subscriptionId'],
      terminalArtifactPath: value['terminalArtifactPath'],
    };
  }
  return undefined;
}

export function parseResponsesDurableRequestFrame(
  value: unknown,
): ResponsesDurableRequestFrame | undefined {
  if (
    !isProtocolRecord(value) ||
    typeof value['requestIdentity'] !== 'string' ||
    typeof value['subscriptionId'] !== 'string'
  ) {
    return undefined;
  }
  const common = {
    version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
    requestIdentity: value['requestIdentity'],
    subscriptionId: value['subscriptionId'],
  } as const;
  if (value['kind'] === 'accepted' || value['kind'] === 'completed') {
    return { ...common, kind: value['kind'] };
  }
  if (value['kind'] === 'event' && isRecord(value['event'])) {
    return { ...common, kind: 'event', event: value['event'] };
  }
  if (value['kind'] === 'failed') {
    const error = parseSerializedError(value['error']);
    return error === undefined
      ? undefined
      : { ...common, kind: 'failed', error };
  }
  return undefined;
}

export function parseResponsesDurableRequestTerminalArtifact(
  value: unknown,
): ResponsesDurableRequestTerminalArtifact | undefined {
  if (
    !isProtocolRecord(value) ||
    typeof value['requestIdentity'] !== 'string' ||
    typeof value['dispatched'] !== 'boolean' ||
    !Array.isArray(value['events']) ||
    !value['events'].every(isRecord) ||
    !isRecord(value['terminal'])
  ) {
    return undefined;
  }
  const terminal =
    value['terminal']['kind'] === 'completed'
      ? ({ kind: 'completed' } as const)
      : value['terminal']['kind'] === 'failed'
        ? (() => {
            const error = parseSerializedError(value['terminal']['error']);
            return error === undefined
              ? undefined
              : ({ kind: 'failed', error } as const);
          })()
        : undefined;
  if (terminal === undefined) {
    return undefined;
  }
  return {
    version: RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION,
    requestIdentity: value['requestIdentity'],
    dispatched: value['dispatched'],
    events: value['events'],
    terminal,
  };
}

export function serializeResponsesDurableRequestError(
  error: unknown,
): ResponsesDurableRequestSerializedError {
  const message =
    error instanceof Error ? error.message : 'provider request failed';
  if (error === null || typeof error !== 'object') {
    return { message };
  }
  const llmCode = Reflect.get(error, 'llmCode');
  const status = Reflect.get(error, 'status');
  const retryAfterMs = Reflect.get(error, 'retryAfterMs');
  return {
    message,
    ...(typeof llmCode === 'string' ? { llmCode } : {}),
    ...(typeof status === 'number' && Number.isFinite(status)
      ? { status }
      : {}),
    ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
      ? { retryAfterMs }
      : {}),
  };
}

export function hydrateResponsesDurableRequestError(
  serialized: ResponsesDurableRequestSerializedError,
): Error {
  return Object.assign(new Error(serialized.message), {
    ...(serialized.llmCode === undefined
      ? {}
      : { llmCode: serialized.llmCode }),
    ...(serialized.status === undefined ? {} : { status: serialized.status }),
    ...(serialized.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: serialized.retryAfterMs }),
  });
}

function parseSerializedError(
  value: unknown,
): ResponsesDurableRequestSerializedError | undefined {
  if (!isRecord(value) || typeof value['message'] !== 'string') {
    return undefined;
  }
  const llmCode = value['llmCode'];
  const status = value['status'];
  const retryAfterMs = value['retryAfterMs'];
  if (
    (llmCode !== undefined && typeof llmCode !== 'string') ||
    (status !== undefined &&
      (typeof status !== 'number' || !Number.isFinite(status))) ||
    (retryAfterMs !== undefined &&
      (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs)))
  ) {
    return undefined;
  }
  return {
    message: value['message'],
    ...(llmCode === undefined ? {} : { llmCode }),
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function isProtocolRecord(value: unknown): value is Record<string, unknown> & {
  version: typeof RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION;
} {
  return (
    isRecord(value) &&
    value['version'] === RESPONSES_DURABLE_REQUEST_PROTOCOL_VERSION
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isStringPairArray(value: unknown): value is [string, string][] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        typeof item[0] === 'string' &&
        typeof item[1] === 'string',
    )
  );
}
