import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { isToolObjectParameters } from '../types.js';
import { createWebSearchTool, searchWeb } from './web-search.js';

function duckDuckGoHtmlResult(
  args: {
    title?: string;
    url?: string;
    snippet?: string;
  } = {},
): Buffer {
  const resultUrl = args.url ?? 'https://www.typescriptlang.org/docs/handbook/';
  const redirectUrl = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(
    resultUrl,
  )}`;
  return Buffer.from(
    `<div class="result results_links">
      <a class="result__a" rel="nofollow" href="${redirectUrl}">${
        args.title ?? 'TypeScript <b>Handbook</b>'
      }</a>
      <a class="result__snippet">${
        args.snippet ?? 'Read &amp; learn the current handbook.'
      }</a>
    </div>`,
    'utf8',
  );
}

function duckDuckGoLiteResult(): Buffer {
  return Buffer.from(
    `<table>
      <tr><td><a rel="nofollow" href="https://example.com/current">Current example</a></td></tr>
      <tr><td class="result-snippet">A keyless lite result.</td></tr>
    </table>`,
    'utf8',
  );
}

void test('web_search exposes query-only read metadata and keyless fallback guidance', () => {
  const tool = createWebSearchTool();

  assert.equal(tool.name, 'web_search');
  assert.equal(tool.sideEffectLevel, 'read');
  assert.equal(tool.requiresApproval, false);
  assert.equal(tool.mayMutateComputerFiles, false);
  assert.equal(tool.recoveryStrategy, 'replay_safe');
  assert.match(tool.description, /Codex OAuth/u);
  assert.match(tool.description, /keyless DuckDuckGo/u);
  assert.match(tool.description, /fetch_url/u);

  const parameters = tool.parameters;
  assert.ok(isToolObjectParameters(parameters));
  assert.deepEqual(parameters.required, ['query']);
  assert.deepEqual(Object.keys(parameters.properties), ['query']);
});

void test('web_search no longer reads or forwards a separate search API key', async () => {
  let observedKeys: string[] = [];
  const tool = createWebSearchTool({
    searchWeb: async (args) => {
      observedKeys = Object.keys(args).sort();
      return {
        ok: true,
        provider: 'duckduckgo',
        providerVariant: 'html',
        query: args.query.trim(),
        results: [],
        resultCount: 0,
        attempts: [],
        untrusted: true,
      };
    },
  });

  const result = await tool.execute(
    { query: '  durable agent run  ' },
    { callId: 'call-web-search-success' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(observedKeys, ['query']);
  assert.doesNotMatch(result.output, /api.?key|subscription-token/iu);
});

void test('searchWeb uses the existing Codex OAuth runtime and returns cited source cards', async () => {
  let observed:
    | {
        model: string;
        providerSessionId: string;
        query: string;
      }
    | undefined;
  const answer = 'The current handbook is available from the cited source.';
  const result = await searchWeb({
    query: ' TypeScript handbook ',
    nativeSearch: {
      model: 'gpt-5.6-sol',
      providerSessionId: 'run-search-1',
      runtime: {
        search: async (args) => {
          observed = {
            model: args.model,
            providerSessionId: args.providerSessionId,
            query: args.query,
          };
          return {
            ok: true,
            answer,
            results: [
              {
                title: 'TypeScript Handbook',
                url: 'https://www.typescriptlang.org/docs/handbook/',
                snippet: '',
              },
            ],
          } as const;
        },
      },
    },
    duckDuckGoRequest: async () => {
      assert.fail('DuckDuckGo must not run after Codex succeeds');
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail('expected a successful Codex search');
  }
  assert.equal(result.provider, 'codex');
  assert.equal(result.query, 'TypeScript handbook');
  assert.equal(result.answer, answer);
  assert.deepEqual(result.attempts, []);
  assert.deepEqual(observed, {
    model: 'gpt-5.6-sol',
    providerSessionId: 'run-search-1',
    query: 'TypeScript handbook',
  });
  assert.deepEqual(result.results[0], {
    ref: result.results[0]?.ref,
    title: 'TypeScript Handbook',
    url: 'https://www.typescriptlang.org/docs/handbook/',
    snippet: '',
    source: 'www.typescriptlang.org',
  });
  assert.match(
    result.results[0]?.ref ?? '',
    /^web_search_result:sha256:[0-9a-f]{64}$/u,
  );
});

void test('searchWeb visibly falls back from Codex auth failure to keyless DuckDuckGo', async () => {
  const result = await searchWeb({
    query: 'current TypeScript release',
    nativeSearch: {
      model: 'gpt-5.6-sol',
      providerSessionId: 'run-search-auth-fallback',
      runtime: {
        search: async () => ({
          ok: false,
          reasonCode: 'provider_unauthorized',
          message: 'provider authentication failed',
        }),
      },
    },
    duckDuckGoRequest: async () => ({
      status: 200,
      body: duckDuckGoHtmlResult(),
    }),
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail('expected DuckDuckGo fallback success');
  }
  assert.equal(result.provider, 'duckduckgo');
  assert.equal(result.providerVariant, 'html');
  assert.equal(result.resultCount, 1);
  assert.deepEqual(result.attempts, [
    {
      provider: 'codex',
      status: 'failed',
      reasonCode: 'provider_unauthorized',
      message: 'provider authentication failed',
    },
  ]);
});

void test('searchWeb exposes Codex and HTML failures when DuckDuckGo lite succeeds', async () => {
  const requestedHosts: string[] = [];
  const result = await searchWeb({
    query: 'current information',
    nativeSearch: {
      model: 'gpt-5.6-sol',
      providerSessionId: 'run-search-lite-fallback',
      runtime: {
        search: async () => ({
          ok: false,
          reasonCode: 'provider_error',
          message: 'provider request failed',
        }),
      },
    },
    duckDuckGoRequest: async (args) => {
      requestedHosts.push(args.url.hostname);
      if (args.url.hostname === 'html.duckduckgo.com') {
        return { status: 503, body: Buffer.alloc(0) };
      }
      return { status: 200, body: duckDuckGoLiteResult() };
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail('expected DuckDuckGo lite fallback success');
  }
  assert.equal(result.provider, 'duckduckgo');
  assert.equal(result.providerVariant, 'lite');
  assert.deepEqual(requestedHosts, [
    'html.duckduckgo.com',
    'lite.duckduckgo.com',
  ]);
  assert.deepEqual(result.attempts, [
    {
      provider: 'codex',
      status: 'failed',
      reasonCode: 'provider_error',
      message: 'provider request failed',
    },
    {
      provider: 'duckduckgo',
      endpoint: 'html',
      status: 'failed',
      reasonCode: 'provider_error',
      message: 'DuckDuckGo search returned HTTP 503.',
    },
  ]);
  assert.deepEqual(result.results[0], {
    ref: result.results[0]?.ref,
    title: 'Current example',
    url: 'https://example.com/current',
    snippet: 'A keyless lite result.',
    source: 'example.com',
  });
});

void test('searchWeb parses keyless HTML cards and filters unsafe result URLs', async () => {
  const body = Buffer.concat([
    duckDuckGoHtmlResult(),
    Buffer.from(
      `<a class="result__a" rel="nofollow" href="javascript:alert(1)">Unsafe</a>
       <a class="result__a" rel="nofollow" href="http://localhost/private">Private</a>`,
      'utf8',
    ),
  ]);
  const first = await searchWeb({
    query: ' TypeScript docs ',
    duckDuckGoRequest: async () => ({ status: 200, body }),
  });
  const second = await searchWeb({
    query: 'TypeScript docs',
    duckDuckGoRequest: async () => ({ status: 200, body }),
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) {
    assert.fail('expected successful DuckDuckGo searches');
  }
  assert.equal(first.provider, 'duckduckgo');
  assert.equal(first.resultCount, 1);
  assert.deepEqual(first.results[0], {
    ref: first.results[0]?.ref,
    title: 'TypeScript Handbook',
    url: 'https://www.typescriptlang.org/docs/handbook/',
    snippet: 'Read & learn the current handbook.',
    source: 'www.typescriptlang.org',
  });
  assert.equal(first.results[0]?.ref, second.results[0]?.ref);
  assert.deepEqual(first.attempts, [
    {
      provider: 'codex',
      status: 'skipped',
      reasonCode: 'provider_not_available',
      message:
        'Codex native web search is unavailable because the active run is not using the Codex OAuth provider.',
    },
  ]);
});

void test('searchWeb applies the shared public-network DNS guard to keyless fallback', async () => {
  const result = await searchWeb({
    query: 'query',
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'network_error');
  assert.deepEqual(
    result.attempts.map((attempt) => ({
      provider: attempt.provider,
      endpoint: attempt.endpoint,
      reasonCode: attempt.reasonCode,
    })),
    [
      {
        provider: 'codex',
        endpoint: undefined,
        reasonCode: 'provider_not_available',
      },
      {
        provider: 'duckduckgo',
        endpoint: 'html',
        reasonCode: 'network_error',
      },
      {
        provider: 'duckduckgo',
        endpoint: 'lite',
        reasonCode: 'network_error',
      },
    ],
  );
});

void test('searchWeb reports caller cancellation without starting DNS lookup or fallback', async () => {
  const controller = new AbortController();
  controller.abort();
  let lookupCalled = false;

  const result = await searchWeb({
    query: 'query',
    signal: controller.signal,
    lookup: async () => {
      lookupCalled = true;
      return [{ address: '93.184.216.34', family: 4 }];
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'aborted');
  assert.equal(lookupCalled, false);
  assert.deepEqual(result.attempts, []);
});

void test('searchWeb returns every provider failure when no fallback succeeds', async () => {
  const result = await searchWeb({
    query: 'query',
    nativeSearch: {
      model: 'gpt-5.6-sol',
      providerSessionId: 'run-search-all-fail',
      runtime: {
        search: async () => ({
          ok: false,
          reasonCode: 'provider_rate_limited',
          message: 'provider rate limited',
        }),
      },
    },
    duckDuckGoRequest: async () => ({
      status: 200,
      body: Buffer.from('<html><body>No results</body></html>', 'utf8'),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.provider, 'duckduckgo');
  assert.equal(result.reasonCode, 'invalid_response');
  assert.equal(result.attempts.length, 3);
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.reasonCode),
    ['provider_rate_limited', 'invalid_response', 'invalid_response'],
  );
});
