import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPluginDeleteResponse,
  isPluginInstallRequest,
  isPluginListResponse,
  isPluginMarketplaceAddRequest,
  isPluginMarketplaceDeleteResponse,
  isPluginMarketplaceInstallRequest,
  isPluginMarketplaceListResponse,
  isPluginMarketplaceMutationResponse,
  isPluginMutationResponse,
  isPluginSkillLogicalPath,
  isPluginSkillListResponse,
} from './plugins.js';

const plugin = {
  installationId: '00000000-0000-4000-8000-000000000000',
  name: 'example-plugin',
  displayName: 'Example plugin',
  version: '1.2.3-beta.1+build.7',
  description: 'An example plugin.',
  enabled: false,
  contentDigest: `sha256:${'a'.repeat(64)}`,
  sourceKind: 'local-directory',
  installedAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  capabilities: [
    {
      kind: 'skills',
      supportStatus: 'supported',
      itemCount: 1,
    },
    {
      kind: 'mcpServers',
      supportStatus: 'partially-supported',
      itemCount: 2,
    },
    { kind: 'apps', supportStatus: 'unsupported', itemCount: 1 },
  ],
} as const;

void test('plugin install requests accept only portable computer-relative paths', () => {
  assert.equal(
    isPluginInstallRequest({ root: 'computer', path: 'plugins/example' }),
    true,
  );
  assert.equal(
    isPluginInstallRequest({ root: 'computer', path: 'plugins\\example' }),
    true,
  );
  for (const path of [
    '',
    '../example',
    'plugins/../example',
    '/opt/example',
    '\\\\server\\share\\example',
    'C:\\plugins\\example',
    'plugins/example\0hidden',
  ]) {
    assert.equal(isPluginInstallRequest({ root: 'computer', path }), false);
  }
  assert.equal(
    isPluginInstallRequest({
      root: 'computer',
      path: 'plugins/example',
      sourcePath: '/private/plugins/example',
    }),
    false,
  );
});

void test('plugin response guards admit sanitized views and reject private fields', () => {
  assert.equal(isPluginListResponse({ plugins: [plugin] }), true);
  assert.equal(isPluginMutationResponse({ plugin }), true);
  assert.equal(
    isPluginDeleteResponse({
      removedInstallationId: plugin.installationId,
    }),
    true,
  );

  assert.equal(
    isPluginListResponse({
      plugins: [{ ...plugin, sourcePath: '/private/plugins/example' }],
    }),
    false,
  );
  assert.equal(
    isPluginMutationResponse({
      plugin: { ...plugin, secretValue: 'must-not-cross-the-protocol' },
    }),
    false,
  );
  assert.equal(
    isPluginListResponse({
      plugins: [
        {
          ...plugin,
          capabilities: [plugin.capabilities[0], plugin.capabilities[0]],
        },
      ],
    }),
    false,
  );
  assert.equal(
    isPluginListResponse({
      plugins: [
        {
          ...plugin,
          capabilities: [
            {
              kind: 'mcpServers',
              supportStatus: 'partly-supported',
              itemCount: 2,
            },
          ],
        },
      ],
    }),
    false,
  );
});

void test('marketplace requests keep network sources separate from install identity', () => {
  assert.equal(
    isPluginMarketplaceAddRequest({
      sourceKind: 'git',
      url: 'https://github.com/openai/plugins.git',
      ref: 'main',
    }),
    true,
  );
  for (const url of [
    'http://github.com/openai/plugins.git',
    'https://token@github.com/openai/plugins.git',
    'https://github.com/openai/plugins.git?token=secret',
    'https://github.com/openai/plugins.git#main',
  ]) {
    assert.equal(
      isPluginMarketplaceAddRequest({ sourceKind: 'git', url }),
      false,
    );
  }
  assert.equal(
    isPluginMarketplaceAddRequest({
      sourceKind: 'git',
      url: 'https://github.com/openai/plugins.git',
      ref: '--upload-pack=unexpected',
    }),
    false,
  );

  const installRequest = {
    marketplaceId: '10000000-0000-4000-8000-000000000000',
    entryId: 'figma',
    expectedContentDigest: `sha256:${'b'.repeat(64)}`,
  };
  assert.equal(isPluginMarketplaceInstallRequest(installRequest), true);
  assert.equal(
    isPluginMarketplaceInstallRequest({
      ...installRequest,
      sourceUrl: 'https://github.com/openai/plugins.git',
    }),
    false,
  );
  assert.equal(
    isPluginMarketplaceInstallRequest({
      ...installRequest,
      sourcePath: '/private/checkout/plugins/figma',
    }),
    false,
  );
});

void test('marketplace response guards admit named provenance and reject private state', () => {
  const source = {
    marketplaceId: '10000000-0000-4000-8000-000000000000',
    name: 'openai-curated',
    displayName: 'Codex official',
    sourceRole: 'official',
    sourceKind: 'git',
    sourceUrl: 'https://github.com/openai/plugins.git',
    requestedRef: 'main',
    resolvedRevision: `git:${'c'.repeat(40)}`,
    addedAt: '2026-07-16T00:00:00.000Z',
    refreshedAt: '2026-07-16T00:00:00.000Z',
  } as const;
  const entry = {
    entryId: 'figma',
    marketplaceId: source.marketplaceId,
    marketplaceName: source.name,
    marketplaceDisplayName: source.displayName,
    name: 'figma',
    displayName: 'Figma',
    version: '1.0.0',
    description: 'Use Figma workflows.',
    iconAvailable: true,
    category: 'Creativity',
    sourceKind: 'local',
    status: 'installable',
    installationPolicy: 'AVAILABLE',
    authenticationPolicy: 'ON_INSTALL',
    contentDigest: `sha256:${'d'.repeat(64)}`,
    resolvedRevision: source.resolvedRevision,
    installedInstallationId: null,
    capabilities: plugin.capabilities,
  } as const;
  const response = { sources: [source], entries: [entry], diagnostics: [] };

  assert.equal(isPluginMarketplaceListResponse(response), true);
  assert.equal(
    isPluginMarketplaceListResponse({
      ...response,
      entries: [{ ...entry, iconAvailable: undefined }],
    }),
    false,
  );
  assert.equal(
    isPluginMarketplaceMutationResponse({ marketplace: source }),
    true,
  );
  assert.equal(
    isPluginMarketplaceDeleteResponse({
      removedMarketplaceId: source.marketplaceId,
    }),
    true,
  );
  assert.equal(
    isPluginMarketplaceListResponse({
      ...response,
      sources: [{ ...source, sourceRole: 'third-party' }],
    }),
    false,
  );
  assert.equal(
    isPluginMarketplaceListResponse({
      ...response,
      sources: [{ ...source, managedPath: '/private/marketplaces/source' }],
    }),
    false,
  );
  assert.equal(
    isPluginMarketplaceListResponse({
      ...response,
      entries: [{ ...entry, downloadUrl: 'https://example.com/private.tgz' }],
    }),
    false,
  );

  const marketplacePlugin = {
    ...plugin,
    sourceKind: 'marketplace',
    marketplaceSource: {
      marketplaceId: source.marketplaceId,
      marketplaceName: source.name,
      marketplaceDisplayName: source.displayName,
      entryId: entry.entryId,
      resolvedRevision: source.resolvedRevision,
    },
  } as const;
  assert.equal(isPluginListResponse({ plugins: [marketplacePlugin] }), true);
  assert.equal(
    isPluginListResponse({
      plugins: [{ ...marketplacePlugin, marketplaceSource: undefined }],
    }),
    false,
  );
  assert.equal(
    isPluginListResponse({
      plugins: [
        { ...plugin, marketplaceSource: marketplacePlugin.marketplaceSource },
      ],
    }),
    false,
  );
});

void test('plugin skill response guards admit public catalog metadata only', () => {
  const skill = {
    skillRef: `geulbat-skill/${plugin.installationId}/${'b'.repeat(64)}`,
    name: 'example-skill',
    description: 'Use the example workflow.',
    enabled: true,
    allowImplicitInvocation: false,
    runtimeStatus: 'available',
    pluginInstallationId: plugin.installationId,
    pluginName: plugin.name,
    pluginDisplayName: plugin.displayName,
    pluginVersion: plugin.version,
  } as const;
  const diagnostic = {
    pluginInstallationId: plugin.installationId,
    pluginName: plugin.name,
    code: 'managed-package-invalid',
    message: 'managed plugin package is missing, invalid, or inconsistent',
  } as const;

  assert.equal(
    isPluginSkillListResponse({ skills: [skill], diagnostics: [diagnostic] }),
    true,
  );
  assert.equal(isPluginSkillLogicalPath('geulbat-skill'), true);
  assert.equal(isPluginSkillLogicalPath(skill.skillRef), true);
  assert.equal(isPluginSkillLogicalPath('geulbat-skill-shadow/path'), false);
  assert.equal(
    isPluginSkillListResponse({
      skills: [
        {
          ...skill,
          enabled: false,
          runtimeStatus: 'unavailable-tool-dependencies',
        },
      ],
      diagnostics: [],
    }),
    true,
  );
  assert.equal(
    isPluginSkillListResponse({
      skills: [{ ...skill, sourcePath: '/private/plugins/example' }],
      diagnostics: [],
    }),
    false,
  );
  assert.equal(
    isPluginSkillListResponse({
      skills: [{ ...skill, skillRef: 'geulbat-skill/not-a-valid-ref' }],
      diagnostics: [],
    }),
    false,
  );
  assert.equal(
    isPluginSkillListResponse({
      skills: [{ ...skill, skillRef: `${skill.skillRef}/unexpected` }],
      diagnostics: [],
    }),
    false,
  );
  assert.equal(
    isPluginSkillListResponse({
      skills: [{ ...skill, pluginInstallationId: 'different-installation' }],
      diagnostics: [],
    }),
    false,
  );
  assert.equal(
    isPluginSkillListResponse({
      skills: [{ ...skill, runtimeStatus: 'silently-fallback' }],
      diagnostics: [],
    }),
    false,
  );
  assert.equal(
    isPluginSkillListResponse({
      skills: [],
      diagnostics: [{ ...diagnostic, managedPath: '/private/managed/path' }],
    }),
    false,
  );
});
