import { sha256StableJson } from '@geulbat/content-identity/stable-json';

import { getProviderAuth } from '../../auth/access.js';
import type { ProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import {
  isProviderReplayScopeId,
  type ProviderReplayScopeId,
} from '../../runtime-contracts.js';
import { ProviderReplayScopeMismatchError } from './provider-error.js';
import type { ProviderRequestOptions } from './provider-options.js';

import { resolveGrokOAuthModelDescriptor } from './grok-oauth-transport.js';
import { loadQwenTokenPlanConfig } from './qwen/config.js';
import { resolveCodexResponsesUrl } from './transport/responses-websocket-url.js';
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
  providerRequestOptions: ProviderRequestOptions;
  providerAuthRuntime: ProviderAuthRuntimeStore;
  getProviderAuthImpl?: typeof getProviderAuth;
  loadQwenTokenPlanConfigImpl?: typeof loadQwenTokenPlanConfig;
}): Promise<ProviderReplayScopeId> {
  if (args.providerRequestOptions.providerId === 'qwen_token_plan') {
    const config = await (
      args.loadQwenTokenPlanConfigImpl ?? loadQwenTokenPlanConfig
    )({ model: args.providerRequestOptions.model });
    return createProviderReplayScopeId({
      providerId: args.providerRequestOptions.providerId,
      accountId: config.credentialIdentity,
      endpoint: config.chatCompletionsUrl,
    });
  }

  const auth = await (args.getProviderAuthImpl ?? getProviderAuth)({
    providerId: args.providerRequestOptions.providerId,
    runtimeStore: args.providerAuthRuntime,
  });
  const endpoint =
    args.providerRequestOptions.providerId === 'grok_oauth'
      ? resolveGrokOAuthModelDescriptor(args.providerRequestOptions.model)
          .baseUrl
      : resolveCodexResponsesUrl();
  return createProviderReplayScopeId({
    providerId: args.providerRequestOptions.providerId,
    accountId: auth.accountId,
    endpoint,
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
