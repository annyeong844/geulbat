import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearProviderUsageCacheForTests,
  fetchProviderUsage,
  resolveCodexUsageUrl,
} from './provider-usage.js';

const ACCESS_TOKEN = 'test-access-token';
const ACCOUNT_ID = 'test-account-id';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// 실제 `/wham/usage` 응답 모양 — 창은 rate_limit 안에 있고 시간 단위는 초다.
function codexUsageBody(): unknown {
  return {
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 42.5,
        limit_window_seconds: 18_000,
        reset_at: 1_800_000_000,
      },
      secondary_window: {
        used_percent: 7,
        limit_window_seconds: 604_800,
      },
      tertiary_window: {
        used_percent: 12,
        limit_window_seconds: 2_592_000,
      },
    },
  };
}

test.beforeEach(() => {
  clearProviderUsageCacheForTests();
});

function findEntry(
  entries: Awaited<ReturnType<typeof fetchProviderUsage>>,
  providerId: string,
) {
  return entries.find((entry) => entry.providerId === providerId);
}

void test('the Codex usage url is derived from the configured responses url', () => {
  assert.equal(
    resolveCodexUsageUrl('https://chatgpt.com/backend-api/codex/responses'),
    'https://chatgpt.com/backend-api/wham/usage',
  );
  // 자체 호스팅/테스트 override도 같은 규칙으로 따라간다.
  assert.equal(
    resolveCodexUsageUrl('https://chatgpt.test/backend-api'),
    'https://chatgpt.test/backend-api/wham/usage',
  );
});

void test('provider-reported windows are surfaced with their reset time', async () => {
  const requested: Array<{ url: string; headers: Record<string, string> }> = [];
  const entries = await fetchProviderUsage({
    loadCredential: async (providerId) =>
      providerId === 'openai_codex_direct'
        ? { accessToken: ACCESS_TOKEN, accountId: ACCOUNT_ID }
        : null,
    fetchImpl: async (input, init) => {
      requested.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return jsonResponse(codexUsageBody());
    },
    now: () => new Date('2026-07-26T00:00:00.000Z'),
  });

  const codex = findEntry(entries, 'openai_codex_direct');
  assert.equal(codex?.state, 'reported');
  assert.ok(codex?.state === 'reported');
  assert.equal(codex.planLabel, 'plus');
  assert.equal(codex.readAt, '2026-07-26T00:00:00.000Z');
  assert.equal(codex.measurement.kind, 'windows');
  assert.ok(codex.measurement.kind === 'windows');
  assert.deepEqual(codex.measurement.windows, [
    {
      usedPercent: 42.5,
      // 초 단위 창을 분으로 옮긴다 — 18000초 = 5시간.
      windowMinutes: 300,
      resetAt: new Date(1_800_000_000 * 1000).toISOString(),
    },
    { usedPercent: 7, windowMinutes: 10_080 },
    // 30일 창도 읽는다 — 빼먹으면 월 한도가 보이지 않는다.
    { usedPercent: 12, windowMinutes: 43_200 },
  ]);
  assert.equal(requested.length, 1);
  assert.match(requested[0]?.url ?? '', /\/wham\/usage$/u);
});

void test('a provider without a stored credential is reported as not connected', async () => {
  const entries = await fetchProviderUsage({
    loadCredential: async () => null,
    fetchImpl: async () => {
      assert.fail('no request should be sent without a credential');
    },
  });

  assert.equal(
    findEntry(entries, 'openai_codex_direct')?.state,
    'not_connected',
  );
});

void test('Grok is reported as not provided because our credential is not accepted', async () => {
  const entries = await fetchProviderUsage({
    loadCredential: async () => ({
      accessToken: ACCESS_TOKEN,
      accountId: ACCOUNT_ID,
    }),
    fetchImpl: async () => {
      assert.fail('no request should be sent to a provider we cannot query');
    },
  });

  const grok = findEntry(entries, 'grok_oauth');
  assert.equal(grok?.state, 'not_provided');
  assert.ok(grok?.state === 'not_provided');
  assert.match(grok.reason, /자격증명/u);
});

void test('a provider with no usage adapter is reported as not provided', async () => {
  // 어댑터가 없는 제공자는 조용히 0을 만들지 않고 미제공으로 남는다. 지금은
  // Codex/Grok 둘 다 어댑터가 있어 이 경로는 미지의 제공자 id로만 도달한다.
  const entries = await fetchProviderUsage({
    loadCredential: async () => ({
      accessToken: ACCESS_TOKEN,
      accountId: ACCOUNT_ID,
    }),
    fetchImpl: async () => jsonResponse(codexUsageBody()),
    providerIds: ['unknown_provider' as never],
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.state, 'not_provided');
});

void test('a refused usage request is reported as failed rather than as zero usage', async () => {
  const entries = await fetchProviderUsage({
    loadCredential: async (providerId) =>
      providerId === 'openai_codex_direct'
        ? { accessToken: ACCESS_TOKEN, accountId: ACCOUNT_ID }
        : null,
    fetchImpl: async () => jsonResponse({ error: 'nope' }, 403),
  });

  const codex = findEntry(entries, 'openai_codex_direct');
  assert.equal(codex?.state, 'failed');
  assert.ok(codex?.state === 'failed');
  assert.match(codex.message, /403/u);
});

void test('an unrecognized usage payload is reported as failed rather than invented', async () => {
  const entries = await fetchProviderUsage({
    loadCredential: async (providerId) =>
      providerId === 'openai_codex_direct'
        ? { accessToken: ACCESS_TOKEN, accountId: ACCOUNT_ID }
        : null,
    fetchImpl: async () =>
      jsonResponse({ rate_limits: [{ limit_id: 'codex' }] }),
  });

  assert.equal(findEntry(entries, 'openai_codex_direct')?.state, 'failed');
});

void test('a transport failure never puts credential material in the result', async () => {
  const entries = await fetchProviderUsage({
    loadCredential: async (providerId) =>
      providerId === 'openai_codex_direct'
        ? { accessToken: ACCESS_TOKEN, accountId: ACCOUNT_ID }
        : null,
    fetchImpl: async () => {
      throw new Error(`socket closed while sending ${ACCESS_TOKEN}`);
    },
  });

  const serialized = JSON.stringify(entries);
  assert.equal(findEntry(entries, 'openai_codex_direct')?.state, 'failed');
  // 오류 메시지가 토큰을 실어 올 수 있으므로 결과 전체에 자격증명이 없어야 한다.
  assert.equal(serialized.includes(ACCESS_TOKEN), false);
  assert.equal(serialized.includes(ACCOUNT_ID), false);
});

void test('a repeated read is served from cache so opening settings stays fast', async () => {
  let calls = 0;
  const deps = {
    loadCredential: async (providerId: 'openai_codex_direct' | 'grok_oauth') =>
      providerId === 'openai_codex_direct'
        ? { accessToken: ACCESS_TOKEN, accountId: ACCOUNT_ID }
        : null,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(codexUsageBody());
    },
  };

  await fetchProviderUsage(deps);
  await fetchProviderUsage(deps);
  assert.equal(calls, 1);

  // 새로고침은 캐시를 건너뛴다.
  await fetchProviderUsage({ ...deps, forceRefresh: true });
  assert.equal(calls, 2);
});

void test('a failed read is not cached so a transient outage does not stick', async () => {
  let calls = 0;
  const deps = {
    loadCredential: async (providerId: 'openai_codex_direct' | 'grok_oauth') =>
      providerId === 'openai_codex_direct'
        ? { accessToken: ACCESS_TOKEN, accountId: ACCOUNT_ID }
        : null,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: 'down' }, 503);
    },
  };

  await fetchProviderUsage(deps);
  await fetchProviderUsage(deps);
  assert.equal(calls, 2);
});
