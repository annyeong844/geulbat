import { sha256StableJson } from '@geulbat/content-identity/stable-json';

import { getProviderAuth } from '../../auth/access.js';
import type { ProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import {
  isProviderReplayScopeId,
  type ProviderReplayScopeId,
} from '../../runtime-contracts.js';
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

export async function resolveProviderReplayScopeForRun(args: {
  providerId: ProviderRequestOptions['providerId'];
  endpoint: string;
  providerAuthRuntime: ProviderAuthRuntimeStore;
  getProviderAuthImpl?: typeof getProviderAuth;
}): Promise<ProviderReplayScopeId> {
  const auth = await (args.getProviderAuthImpl ?? getProviderAuth)({
    providerId: args.providerId,
    runtimeStore: args.providerAuthRuntime,
  });
  return createProviderReplayScopeId({
    providerId: args.providerId,
    accountId: auth.accountId,
    endpoint: args.endpoint,
  });
}

export function assertProviderReplayScope(
  actual: ProviderReplayScopeId,
  expected?: ProviderReplayScopeId,
): void {
  if (expected !== undefined && actual !== expected) {
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

export class ProviderReplayScopeMismatchError extends Error {
  readonly llmCode = 'llm_auth_failed';

  constructor() {
    super('provider replay state belongs to a different authentication scope');
    this.name = 'ProviderReplayScopeMismatchError';
  }
}

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
