#!/usr/bin/env node

if (process.env.GEULBAT_GROK_CACHE_PROBE !== '1') {
  throw new Error(
    'GEULBAT_GROK_CACHE_PROBE=1 is required for the live Grok cache probe',
  );
}

const { createHash, randomUUID } = await import('node:crypto');
const { getProviderAuth } = await import('../src/daemon/auth/access.ts');
const { createProviderAuthRuntimeStore } =
  await import('../src/daemon/auth/runtime-state.ts');
const { buildSystemPrompt } =
  await import('../src/daemon/agent/prompt/build-system-prompt.ts');
const {
  buildGrokOAuthPromptCacheProjection,
  resolveGrokOAuthModelDescriptor,
  streamGrokOAuthResponses,
} = await import('../src/daemon/llm/provider/grok-oauth-transport.ts');
const { createResponsesWebSocketSessionStore } =
  await import('../src/daemon/llm/provider/transport/responses-websocket-cache.ts');

const model = resolveGrokOAuthModelDescriptor('grok-4.5');
const providerAuthRuntime = createProviderAuthRuntimeStore();
const auth = await getProviderAuth({
  providerId: 'grok_oauth',
  runtimeStore: providerAuthRuntime,
});
const repeatCount = 3;
const stableKey = randomUUID();
const routingHintKey = randomUUID();

const stable = await runCondition({
  name: 'stable_key',
  conditionId: randomUUID(),
  keyForRequest: () => stableKey,
});
const varied = await runCondition({
  name: 'varied_key',
  conditionId: randomUUID(),
  keyForRequest: () => randomUUID(),
});
const routingHint = await runCondition({
  name: 'stable_key_with_x_grok_conv_id',
  conditionId: randomUUID(),
  keyForRequest: () => routingHintKey,
  conversationRoutingId: randomUUID(),
});

const stableRepeatedHits = stable.rows
  .slice(1)
  .map((row) => row.cachedInputTokens ?? 0);
const variedHits = varied.rows.map((row) => row.cachedInputTokens ?? 0);
const routingHintRepeatedHits = routingHint.rows
  .slice(1)
  .map((row) => row.cachedInputTokens ?? 0);
const stablePeak = Math.max(...stableRepeatedHits);
const variedPeak = Math.max(...variedHits);
const routingHintPeak = Math.max(...routingHintRepeatedHits);
const allRows = [...stable.rows, ...varied.rows, ...routingHint.rows];
const accepted = allRows.every((row) => row.accepted);
const telemetryObserved = allRows.every(
  (row) => row.cachedInputTokens !== undefined,
);
const behavior =
  stablePeak > 0 && stablePeak > variedPeak
    ? 'prompt_cache_key_verified'
    : variedPeak >= stablePeak && variedPeak > 0
      ? 'implicit_content_cache'
      : 'not_verified';
const passed =
  accepted && telemetryObserved && behavior === 'prompt_cache_key_verified';

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      providerId: 'grok_oauth',
      routeFamily: model.routeFamily,
      modelId: model.wireModel,
      transport: 'responses_websocket',
      repeatCount,
      behavior,
      routingHintEffect:
        routingHintPeak > stablePeak
          ? 'helps'
          : routingHintPeak < stablePeak
            ? 'hurts'
            : 'no_measurable_effect',
      passed,
      conditions: [stable, varied, routingHint],
    },
    null,
    2,
  ),
);

if (!passed) process.exitCode = 1;

async function runCondition({
  name,
  conditionId,
  keyForRequest,
  conversationRoutingId,
}) {
  const instructions = [
    `Cache probe condition ${conditionId}.`,
    buildSystemPrompt({
      profile: 'root',
      computerSessionAvailable: false,
    }),
    'For this probe, reply with exactly OK.',
  ].join('\n\n');
  const firstProviderSessionId = keyForRequest();
  const requestFingerprintHash = createHash('sha256')
    .update(
      JSON.stringify({
        providerId: model.providerId,
        routeFamily: model.routeFamily,
        modelId: model.wireModel,
        instructions,
        input: 'Reply with exactly OK.',
      }),
    )
    .digest('hex');
  const rows = [];

  for (let index = 0; index < repeatCount; index += 1) {
    const providerSessionId =
      index === 0 ? firstProviderSessionId : keyForRequest();
    const usageKeySets = [];
    const result = await streamGrokOAuthResponses(
      {
        model,
        accessToken: auth.accessToken,
        providerSessionId,
        history: [{ kind: 'user', text: 'Reply with exactly OK.' }],
        instructions,
        reasoningEffort: 'low',
        promptCacheIntent: {
          scope: 'thread',
        },
        providerWebSocketSessions: createResponsesWebSocketSessionStore({
          ttlMs: 0,
        }),
        discoverySink: {
          recordRequest() {},
          recordEvent(event) {
            const keys = readUsageKeys(event);
            if (keys !== undefined) usageKeySets.push(keys);
          },
        },
        ...(conversationRoutingId !== undefined
          ? { conversationRoutingId }
          : {}),
      },
      {},
    );
    const projection = buildGrokOAuthPromptCacheProjection({
      model,
      providerSessionId,
      intent: { scope: 'thread' },
    });
    rows.push({
      attempt: index + 1,
      accepted: true,
      cacheKeyHash: projection.trace.cacheKeyHash,
      inputTokens: result.providerUsageTelemetry?.inputTokens,
      outputTokens: result.providerUsageTelemetry?.outputTokens,
      cachedInputTokens: result.providerUsageTelemetry?.cachedInputTokens,
      usageKeySets,
    });
  }

  return {
    name,
    requestFingerprintHash,
    conversationRoutingHint:
      conversationRoutingId === undefined ? 'absent' : 'present',
    rows,
  };
}

function readUsageKeys(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return undefined;
  }
  const response = asRecord(event.response);
  const usage = asRecord(response?.usage) ?? asRecord(event.usage);
  if (!usage) return undefined;
  const details =
    asRecord(usage.input_tokens_details) ?? asRecord(usage.inputTokensDetails);
  return {
    usage: Object.keys(usage).sort(),
    inputTokenDetails: details ? Object.keys(details).sort() : [],
  };
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}
