import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addPluginMarketplace,
  ensureOfficialPluginMarketplace,
  installPlugin,
  installMarketplacePlugin,
  listPluginMarketplaces,
  listPluginSkills,
  listPlugins,
  removePluginMarketplace,
  removePlugin,
  setPluginEnabled,
} from './plugins.js';

void test('plugin APIs use portable computer paths and authenticated global routes', async (t) => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (init?.body) {
      assert.equal(
        new Headers(init.headers).get('content-type'),
        'application/json',
      );
    }
    calls.push({
      url,
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
    });

    if (url === '/api/plugins/skills') {
      return jsonResponse({ skills: [], diagnostics: [] });
    }
    if (url === '/api/plugins/marketplaces' && method === 'GET') {
      return jsonResponse({ sources: [], entries: [], diagnostics: [] });
    }
    if (url === '/api/plugins/marketplaces/official' && method === 'POST') {
      return jsonResponse({ marketplace: marketplaceSourceView('official') });
    }
    if (url === '/api/plugins/marketplaces' && method === 'POST') {
      return jsonResponse({ marketplace: marketplaceSourceView('custom') });
    }
    if (url === '/api/plugins/marketplaces/install') {
      return jsonResponse({ plugin: marketplacePluginView() });
    }
    if (url.startsWith('/api/plugins/marketplaces/') && method === 'DELETE') {
      return jsonResponse({
        removedMarketplaceId: '00000000-0000-4000-8000-000000000001',
      });
    }
    if (method === 'GET') {
      return jsonResponse({ plugins: [] });
    }
    if (method === 'DELETE') {
      return jsonResponse({ removedInstallationId: 'plugin/one' });
    }
    return jsonResponse({ plugin: pluginView(false) });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await listPlugins();
  await listPluginSkills();
  await listPluginMarketplaces();
  await ensureOfficialPluginMarketplace();
  await addPluginMarketplace({
    sourceKind: 'git',
    url: 'https://github.com/example/plugins.git',
    ref: 'main',
  });
  await installMarketplacePlugin({
    marketplaceId: '00000000-0000-4000-8000-000000000001',
    entryId: 'workflow-helper',
    expectedContentDigest: `sha256:${'b'.repeat(64)}`,
  });
  await removePluginMarketplace('00000000-0000-4000-8000-000000000001');
  await installPlugin({ root: 'computer', path: 'plugins/my-plugin' });
  await setPluginEnabled('plugin/one', false);
  await removePlugin('plugin/one');

  assert.deepEqual(calls, [
    { url: '/api/plugins', method: 'GET' },
    { url: '/api/plugins/skills', method: 'GET' },
    { url: '/api/plugins/marketplaces', method: 'GET' },
    { url: '/api/plugins/marketplaces/official', method: 'POST' },
    {
      url: '/api/plugins/marketplaces',
      method: 'POST',
      body: {
        sourceKind: 'git',
        url: 'https://github.com/example/plugins.git',
        ref: 'main',
      },
    },
    {
      url: '/api/plugins/marketplaces/install',
      method: 'POST',
      body: {
        marketplaceId: '00000000-0000-4000-8000-000000000001',
        entryId: 'workflow-helper',
        expectedContentDigest: `sha256:${'b'.repeat(64)}`,
      },
    },
    {
      url: '/api/plugins/marketplaces/00000000-0000-4000-8000-000000000001',
      method: 'DELETE',
    },
    {
      url: '/api/plugins',
      method: 'POST',
      body: { root: 'computer', path: 'plugins/my-plugin' },
    },
    {
      url: '/api/plugins/plugin%2Fone/enabled',
      method: 'PATCH',
      body: { enabled: false },
    },
    { url: '/api/plugins/plugin%2Fone', method: 'DELETE' },
  ]);
});

function pluginView(enabled: boolean) {
  return {
    installationId: 'plugin/one',
    name: 'example-plugin',
    displayName: '예시 플러그인',
    version: '1.0.0',
    description: '테스트 플러그인',
    enabled,
    contentDigest: `sha256:${'a'.repeat(64)}`,
    sourceKind: 'local-directory',
    installedAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    capabilities: [],
  };
}

function marketplaceSourceView(sourceRole: 'official' | 'custom') {
  return {
    marketplaceId: '00000000-0000-4000-8000-000000000001',
    name: 'openai-curated',
    displayName: 'Codex official',
    sourceRole,
    sourceKind: 'git',
    sourceUrl: 'https://github.com/openai/plugins.git',
    requestedRef: 'main',
    resolvedRevision: `git:${'a'.repeat(40)}`,
    addedAt: '2026-07-16T00:00:00.000Z',
    refreshedAt: '2026-07-16T00:00:00.000Z',
  };
}

function marketplacePluginView() {
  return {
    ...pluginView(false),
    contentDigest: `sha256:${'b'.repeat(64)}`,
    sourceKind: 'marketplace',
    marketplaceSource: {
      marketplaceId: '00000000-0000-4000-8000-000000000001',
      marketplaceName: 'openai-curated',
      marketplaceDisplayName: 'Codex official',
      entryId: 'workflow-helper',
      resolvedRevision: `git:${'a'.repeat(40)}`,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
