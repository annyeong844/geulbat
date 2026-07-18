import { isErrorCode, type ErrorCode } from './errors.js';
import { isNumber, isRecord, isString } from './runtime-utils.js';

export const DEFAULT_PROVIDER_AUTH_PROVIDER_ID = 'openai_codex_direct' as const;

export const PROVIDER_AUTH_PROVIDER_IDS = [
  DEFAULT_PROVIDER_AUTH_PROVIDER_ID,
  'grok_oauth',
] as const;

export type ProviderAuthProviderId =
  (typeof PROVIDER_AUTH_PROVIDER_IDS)[number];

export interface ProviderAuthStartRequest {
  launcher: 'web-shell';
  providerId?: ProviderAuthProviderId;
}

export interface ProviderAuthStartResponse {
  authSessionId: string;
  authorizeUrl: string;
  expiresAt: number;
  providerId: ProviderAuthProviderId;
}

export type ProviderAuthStatusState =
  | 'missing'
  | 'pending'
  | 'ready'
  | 'exchange_failed'
  | 'expired';

interface ProviderAuthNoBootstrapSessionFields {
  authSessionId?: never;
  pollAfterMs?: never;
}

interface ProviderAuthNoErrorFields {
  lastErrorCode?: never;
  lastErrorMessage?: never;
}

interface ProviderAuthErrorFields {
  lastErrorCode: ErrorCode;
  lastErrorMessage: string;
}

export type ProviderAuthStatusResponse =
  | ({
      state: 'missing';
      ready: false;
      expiresAt?: never;
    } & ProviderAuthNoBootstrapSessionFields &
      ProviderAuthNoErrorFields)
  | ({
      state: 'pending';
      ready: false;
      authSessionId: string;
      expiresAt: number;
      pollAfterMs: number;
    } & ProviderAuthNoErrorFields)
  | ({
      state: 'ready';
      ready: true;
      expiresAt?: number;
    } & ProviderAuthNoBootstrapSessionFields &
      (ProviderAuthNoErrorFields | ProviderAuthErrorFields))
  | ({
      state: 'ready';
      ready: false;
      authSessionId: string;
      expiresAt: number;
    } & ProviderAuthNoErrorFields & { pollAfterMs?: never })
  | ({
      state: 'exchange_failed';
      ready: false;
    } & ProviderAuthNoBootstrapSessionFields &
      ProviderAuthErrorFields & { expiresAt?: never })
  | ({
      state: 'exchange_failed';
      ready: false;
      authSessionId: string;
      expiresAt: number;
    } & ProviderAuthErrorFields & { pollAfterMs?: never })
  | ({
      state: 'expired';
      ready: false;
      expiresAt?: number;
    } & ProviderAuthNoBootstrapSessionFields &
      ProviderAuthErrorFields)
  | ({
      state: 'expired';
      ready: false;
      authSessionId: string;
      expiresAt: number;
    } & ProviderAuthErrorFields & { pollAfterMs?: never });

export interface ProviderAuthLogoutResponse {
  ok: true;
}

const PROVIDER_AUTH_STATUS_STATES = [
  'missing',
  'pending',
  'ready',
  'exchange_failed',
  'expired',
] as const;

export function isProviderAuthProviderId(
  value: unknown,
): value is ProviderAuthProviderId {
  return (
    typeof value === 'string' &&
    (PROVIDER_AUTH_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export function isProviderAuthStatusState(
  value: unknown,
): value is ProviderAuthStatusState {
  return (
    typeof value === 'string' &&
    (PROVIDER_AUTH_STATUS_STATES as readonly string[]).includes(value)
  );
}

export function isProviderAuthStartResponse(
  value: unknown,
): value is ProviderAuthStartResponse {
  return (
    isRecord(value) &&
    isString(value.authSessionId) &&
    isString(value.authorizeUrl) &&
    isNumber(value.expiresAt) &&
    isProviderAuthProviderId(value.providerId)
  );
}

export function isProviderAuthStatusResponse(
  value: unknown,
): value is ProviderAuthStatusResponse {
  if (!isRecord(value) || !isProviderAuthStatusState(value.state)) {
    return false;
  }

  switch (value.state) {
    case 'missing':
      return (
        value.ready === false &&
        value.authSessionId === undefined &&
        value.expiresAt === undefined &&
        value.pollAfterMs === undefined &&
        hasNoProviderAuthStatusError(value)
      );
    case 'pending':
      return (
        value.ready === false &&
        isString(value.authSessionId) &&
        isNumber(value.expiresAt) &&
        isNumber(value.pollAfterMs) &&
        Number.isInteger(value.pollAfterMs) &&
        value.pollAfterMs > 0 &&
        hasNoProviderAuthStatusError(value)
      );
    case 'ready':
      if (value.ready === true) {
        return (
          value.authSessionId === undefined &&
          value.pollAfterMs === undefined &&
          (value.expiresAt === undefined || isNumber(value.expiresAt)) &&
          hasOptionalProviderAuthStatusError(value)
        );
      }
      return (
        value.ready === false &&
        isString(value.authSessionId) &&
        isNumber(value.expiresAt) &&
        value.pollAfterMs === undefined &&
        hasNoProviderAuthStatusError(value)
      );
    case 'exchange_failed':
      return (
        value.ready === false &&
        value.pollAfterMs === undefined &&
        hasProviderAuthStatusError(value) &&
        hasNoProviderAuthStatusExpiry(value)
      );
    case 'expired':
      return (
        value.ready === false &&
        value.pollAfterMs === undefined &&
        hasProviderAuthStatusError(value) &&
        hasOptionalProviderAuthStatusExpiry(value)
      );
  }
}

function hasProviderAuthStatusError(value: {
  lastErrorCode?: unknown;
  lastErrorMessage?: unknown;
}): boolean {
  return isErrorCode(value.lastErrorCode) && isString(value.lastErrorMessage);
}

function hasNoProviderAuthStatusError(value: {
  lastErrorCode?: unknown;
  lastErrorMessage?: unknown;
}): boolean {
  return (
    value.lastErrorCode === undefined && value.lastErrorMessage === undefined
  );
}

function hasOptionalProviderAuthStatusError(value: {
  lastErrorCode?: unknown;
  lastErrorMessage?: unknown;
}): boolean {
  return (
    hasNoProviderAuthStatusError(value) || hasProviderAuthStatusError(value)
  );
}

function hasNoProviderAuthStatusExpiry(value: {
  authSessionId?: unknown;
  expiresAt?: unknown;
}): boolean {
  if (value.authSessionId === undefined) {
    return value.expiresAt === undefined;
  }
  return isString(value.authSessionId) && isNumber(value.expiresAt);
}

function hasOptionalProviderAuthStatusExpiry(value: {
  authSessionId?: unknown;
  expiresAt?: unknown;
}): boolean {
  if (value.authSessionId === undefined) {
    return value.expiresAt === undefined || isNumber(value.expiresAt);
  }
  return isString(value.authSessionId) && isNumber(value.expiresAt);
}

export function isProviderAuthLogoutResponse(
  value: unknown,
): value is ProviderAuthLogoutResponse {
  return isRecord(value) && value.ok === true;
}
