import assert from 'node:assert/strict';
import test from 'node:test';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import type {
  InstalledPluginView,
  PluginMarketplaceEntryView,
  PluginMarketplaceSourceView,
} from '@geulbat/protocol/plugins';

import { ExtensionHub } from './ExtensionHub.js';
import type { PluginMarketplaceClient } from './PluginMarketplacePanel.js';
import type { PluginClient } from './PluginSettingsPanel.js';
import type { PluginSkillClient } from './PluginSkillSettingsPanel.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('extension hub switches between real plugin and skill catalogs in the center surface', async () => {
  const source = officialSource();
  const generalEntry = marketplaceEntry(source, 'calendar', []);
  const skillEntry = marketplaceEntry(source, 'document-skills', [
    { kind: 'skills', supportStatus: 'supported', itemCount: 2 },
  ]);
  const marketplaceClient: PluginMarketplaceClient = {
    list: async () => ({
      sources: [source],
      entries: [generalEntry, skillEntry],
      diagnostics: [],
    }),
    ensureOfficial: async () => {
      throw new Error('official source already exists');
    },
    add: async () => {
      throw new Error('not called');
    },
    install: async () => {
      throw new Error('not called');
    },
    remove: async () => {
      throw new Error('not called');
    },
  };
  const installed = installedPlugin();
  let pluginListCount = 0;
  const pluginClient: PluginClient = {
    listPlugins: async () => {
      pluginListCount += 1;
      return { plugins: [installed] };
    },
    installPlugin: async () => {
      throw new Error('not called');
    },
    setEnabled: async () => {
      throw new Error('not called');
    },
    removePlugin: async () => {
      throw new Error('not called');
    },
  };
  const skillClient: PluginSkillClient = {
    listSkills: async () => ({
      skills: [
        {
          skillRef: `geulbat-skill/installed/${'c'.repeat(64)}`,
          name: 'installed-review',
          description: '설치된 검토 스킬',
          enabled: true,
          allowImplicitInvocation: true,
          runtimeStatus: 'available',
          pluginInstallationId: installed.installationId,
          pluginName: installed.name,
          pluginDisplayName: installed.displayName,
          pluginVersion: installed.version,
        },
      ],
      diagnostics: [],
    }),
  };
  let closeCount = 0;
  const creatorKinds: Array<'plugin' | 'skill'> = [];
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <ExtensionHub
        marketplaceClient={marketplaceClient}
        pluginClient={pluginClient}
        skillClient={skillClient}
        onClose={() => {
          closeCount += 1;
        }}
        onStartCreator={(kind) => creatorKinds.push(kind)}
      />,
    );
  });
  assert.match(renderedText(renderer.root), /설치된 도구/);
  assert.match(renderedText(renderer.root), /calendar/);
  assert.match(renderedText(renderer.root), /document-skills/);

  act(() => {
    renderer.root
      .findByProps({ 'aria-label': '플러그인 관리' })
      .props.onClick();
  });
  assert.equal(
    renderer.root.findByProps({
      className: 'settings-disclosure extension-installed-management',
    }).props.open,
    true,
  );

  await act(async () => {
    renderer.root
      .findByProps({ 'aria-label': '플러그인 새로고침' })
      .props.onClick();
  });
  assert.equal(pluginListCount, 2);

  act(() => {
    renderer.root.findByProps({ 'aria-label': '만들기 메뉴' }).props.onClick();
  });
  act(() => {
    menuItemByText(renderer.root, '플러그인 만들기').props.onClick();
  });
  assert.deepEqual(creatorKinds, ['plugin']);
  assert.equal(
    renderer.root.findAllByProps({
      className: 'settings-disclosure extension-direct-install',
    }).length,
    0,
  );

  act(() => {
    renderer.root.findByProps({ type: 'search' }).props.onChange({
      currentTarget: { value: 'calendar' },
    });
  });
  assert.match(renderedText(renderer.root), /calendar/);
  assert.doesNotMatch(renderedText(renderer.root), /document-skills/);

  await act(async () => {
    tabByText(renderer.root, '스킬').props.onClick();
  });
  assert.match(renderedText(renderer.root), /installed-review/);
  assert.match(renderedText(renderer.root), /document-skills/);
  assert.doesNotMatch(renderedText(renderer.root), /calendar 마켓 플러그인/);

  act(() => {
    renderer.root.findByProps({ 'aria-label': '만들기 메뉴' }).props.onClick();
  });
  act(() => {
    menuItemByText(renderer.root, '스킬 만들기').props.onClick();
  });
  assert.deepEqual(creatorKinds, ['plugin', 'skill']);

  act(() => {
    renderer.root
      .findByProps({ 'aria-label': '확장 허브 닫기' })
      .props.onClick();
  });
  assert.equal(closeCount, 1);
  act(() => renderer.unmount());
});

function officialSource(): PluginMarketplaceSourceView {
  return {
    marketplaceId: 'marketplace-official',
    name: 'openai-curated',
    displayName: 'Codex official',
    sourceRole: 'official',
    sourceKind: 'git',
    sourceUrl: 'https://github.com/openai/plugins.git',
    requestedRef: 'main',
    resolvedRevision: `git:${'a'.repeat(40)}`,
    addedAt: '2026-07-16T00:00:00.000Z',
    refreshedAt: '2026-07-16T00:00:00.000Z',
  };
}

function marketplaceEntry(
  source: PluginMarketplaceSourceView,
  name: string,
  capabilities: PluginMarketplaceEntryView['capabilities'],
): PluginMarketplaceEntryView {
  return {
    entryId: name,
    marketplaceId: source.marketplaceId,
    marketplaceName: source.name,
    marketplaceDisplayName: source.displayName,
    name,
    displayName: name,
    version: '1.0.0',
    description: `${name} description`,
    iconAvailable: true,
    category: 'Productivity',
    sourceKind: 'local',
    status: 'installable',
    installationPolicy: 'AVAILABLE',
    authenticationPolicy: 'ON_INSTALL',
    contentDigest: `sha256:${'b'.repeat(64)}`,
    resolvedRevision: source.resolvedRevision,
    installedInstallationId: null,
    capabilities,
  };
}

function installedPlugin(): InstalledPluginView {
  return {
    installationId: 'plugin-installed',
    name: 'installed-tools',
    displayName: '설치된 도구',
    version: '1.0.0',
    description: 'already installed',
    enabled: true,
    contentDigest: `sha256:${'d'.repeat(64)}`,
    sourceKind: 'marketplace',
    installedAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    capabilities: [
      { kind: 'skills', supportStatus: 'supported', itemCount: 1 },
    ],
  };
}

function tabByText(root: ReactTestInstance, text: string): ReactTestInstance {
  const tab = root
    .findAllByProps({ role: 'tab' })
    .find((candidate) => renderedText(candidate) === text);
  assert.ok(tab, `missing tab: ${text}`);
  return tab;
}

function menuItemByText(
  root: ReactTestInstance,
  text: string,
): ReactTestInstance {
  const item = root
    .findAllByProps({ role: 'menuitem' })
    .find((candidate) => renderedText(candidate).includes(text));
  assert.ok(item, `missing menu item: ${text}`);
  return item;
}

function renderedText(node: ReactTestInstance | string): string {
  if (typeof node === 'string') {
    return node;
  }
  return node.children
    .map((child) => renderedText(child as ReactTestInstance | string))
    .join('');
}
