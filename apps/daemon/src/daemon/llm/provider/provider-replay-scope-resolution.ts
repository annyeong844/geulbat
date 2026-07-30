import { getProviderAuth } from '../../auth/access.js';
import type { ProviderAuthRuntimeStore } from '../../auth/runtime-state.js';
import type { ProviderReplayScopeId } from '../../runtime-contracts.js';
import { resolveGrokOAuthModelDescriptor } from './grok-oauth-transport.js';
import type { ProviderRequestOptions } from './provider-options.js';
import { createProviderReplayScopeId } from './provider-replay-scope.js';
import { loadQwenTokenPlanConfig } from './qwen/config.js';
import { resolveCodexResponsesUrl } from './transport/responses-websocket-url.js';

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
