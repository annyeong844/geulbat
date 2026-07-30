import { Buffer } from 'node:buffer';

import type {
  PublicHttpReadFailureReason,
  PublicHttpReadInvocation,
  PublicHttpReadOutcome,
} from '../daemon/utils/public-http-read-port.js';

export const PUBLIC_HTTP_READ_PROTOCOL_VERSION = 2;

export interface PublicHttpReadRequest extends PublicHttpReadInvocation {
  version: typeof PUBLIC_HTTP_READ_PROTOCOL_VERSION;
}

export type PublicHttpReadResponse =
  | (Extract<PublicHttpReadOutcome, { ok: true }> & {
      version: typeof PUBLIC_HTTP_READ_PROTOCOL_VERSION;
    })
  | (Extract<PublicHttpReadOutcome, { ok: false }> & {
      version: typeof PUBLIC_HTTP_READ_PROTOCOL_VERSION;
    });

const REQUEST_KEYS = new Set([
  'bodyBase64',
  'headers',
  'maxResponseBytes',
  'method',
  'responseBodyMode',
  'timeoutMs',
  'url',
  'version',
]);
const SUCCESS_KEYS = new Set([
  'bodyBase64',
  'contentLength',
  'contentType',
  'location',
  'ok',
  'status',
  'version',
]);
const FAILURE_KEYS = new Set(['message', 'ok', 'reasonCode', 'version']);
const FAILURE_REASONS = new Set<PublicHttpReadFailureReason>([
  'aborted',
  'dns_blocked',
  'host_unavailable',
  'invalid_request',
  'invalid_response',
  'network_error',
  'response_too_large',
  'timeout',
]);

export function parsePublicHttpReadRequest(
  value: unknown,
): PublicHttpReadRequest | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, REQUEST_KEYS) ||
    value.version !== PUBLIC_HTTP_READ_PROTOCOL_VERSION ||
    typeof value.url !== 'string' ||
    (value.method !== 'GET' &&
      value.method !== 'HEAD' &&
      value.method !== 'POST') ||
    !isStringRecord(value.headers) ||
    (value.bodyBase64 !== undefined && !isCanonicalBase64(value.bodyBase64)) ||
    (value.responseBodyMode !== 'full' &&
      value.responseBodyMode !== 'discard') ||
    (value.maxResponseBytes !== undefined &&
      !isPositiveInteger(value.maxResponseBytes)) ||
    (value.timeoutMs !== undefined && !isPositiveFinite(value.timeoutMs))
  ) {
    return undefined;
  }
  return value as unknown as PublicHttpReadRequest;
}

export function parsePublicHttpReadResult(
  value: unknown,
): PublicHttpReadResponse | undefined {
  if (
    !isRecord(value) ||
    value.version !== PUBLIC_HTTP_READ_PROTOCOL_VERSION ||
    typeof value.ok !== 'boolean'
  ) {
    return undefined;
  }
  if (value.ok) {
    if (
      !hasOnlyKeys(value, SUCCESS_KEYS) ||
      !Number.isInteger(value.status) ||
      (value.status as number) < 0 ||
      !isNullableString(value.location) ||
      !isNullableString(value.contentType) ||
      !isNullableNonNegativeFinite(value.contentLength) ||
      !isCanonicalBase64(value.bodyBase64)
    ) {
      return undefined;
    }
  } else if (
    !hasOnlyKeys(value, FAILURE_KEYS) ||
    typeof value.reasonCode !== 'string' ||
    !FAILURE_REASONS.has(value.reasonCode as PublicHttpReadFailureReason) ||
    typeof value.message !== 'string'
  ) {
    return undefined;
  }
  return value as PublicHttpReadResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNonNegativeFinite(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  );
}
