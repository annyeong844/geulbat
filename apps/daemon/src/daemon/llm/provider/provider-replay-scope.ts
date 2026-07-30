import { sha256StableJson } from '@geulbat/content-identity/stable-json';

import {
  isProviderReplayScopeId,
  type ProviderReplayScopeId,
} from '../../runtime-contracts.js';
import { ProviderReplayScopeMismatchError } from './provider-error.js';
import type { ProviderRequestOptions } from './provider-options.js';

const PROVIDER_REPLAY_SCOPE_CONTRACT = 'provider_replay_scope_v1';

export function createProviderReplayScopeId(args: {
  providerId: ProviderRequestOptions['providerId'];
  accountId: string;
  endpoint: string;
}): ProviderReplayScopeId {
  return `sha256:${sha256StableJson({
    contract: PROVIDER_REPLAY_SCOPE_CONTRACT,
    providerId: args.providerId,
    accountId: requireNonEmpty(args.accountId, 'accountId'),
    endpoint: normalizeEndpoint(args.endpoint),
  })}`;
}

export function assertProviderReplayScope(
  actual: ProviderReplayScopeId | null | undefined,
  expected?: ProviderReplayScopeId,
): void {
  // Undefined is reserved for current-process normalized/test history. Every
  // persisted provider-native item is rehydrated with either its digest or
  // explicit null, so durable replay cannot bypass this comparison.
  if (expected !== undefined && actual !== undefined && actual !== expected) {
    throw new ProviderReplayScopeMismatchError();
  }
}

export function requireProviderReplayScopeId(
  value: unknown,
): ProviderReplayScopeId {
  if (!isProviderReplayScopeId(value)) {
    throw new ProviderReplayScopeMismatchError();
  }
  return value;
}

export { ProviderReplayScopeMismatchError };

function normalizeEndpoint(value: string): string {
  const endpoint = new URL(requireNonEmpty(value, 'endpoint'));
  endpoint.hash = '';
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '');
  return endpoint.toString();
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === '') {
    throw new Error(`provider replay ${label} is required`);
  }
  return normalized;
}
