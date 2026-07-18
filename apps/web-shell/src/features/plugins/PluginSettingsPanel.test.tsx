import test from 'node:test';
import assert from 'node:assert/strict';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type {
  InstalledPluginView,
  PluginMarketplaceSourceView,
} from '@geulbat/protocol/plugins';

import {
  PluginSettingsPanel,
  type PluginClient,
} from './PluginSettingsPanel.js';
import type { PluginMarketplaceClient } from './PluginMarketplacePanel.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('plugin settings installs from a portable path, toggles, and removes a managed copy', async () => {
  const requests: unknown[] = [];
  const initial = pluginView({
    installationId: 'plugin-initial',
    name: 'starter-plugin',
    displayName: '시작 플러그인',
    enabled: false,
  });
  const added = pluginView({
    installationId: 'plugin-added',
    name: 'writing-tools',
    displayName: '글쓰기 도구',
    enabled: false,
    capabilities: [
      {
        kind: 'skills',
        supportStatus: 'supported',
        itemCount: 2,
      },
      {
        kind: 'mcpServers',
        supportStatus: 'partially-supported',
        itemCount: 2,
      },
      { kind: 'hooks', supportStatus: 'unsupported', itemCount: 1 },
    ],
  });
  const client: PluginClient = {
    listPlugins: async () => ({ plugins: [initial] }),
    installPlugin: async (request) => {
      requests.push(request);
      return { plugin: added };
    },
    setEnabled: async (installationId, enabled) => {
      requests.push({ installationId, enabled });
      return { plugin: { ...added, enabled } };
    },
    removePlugin: async (installationId) => {
      requests.push({ remove: installationId });
      return { removedInstallationId: installationId };
    },
  };

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PluginSettingsPanel
        client={client}
        marketplaceClient={emptyMarketplaceClient()}
        requestedPanel="manage"
      />,
    );
  });
  assert.match(renderedText(renderer.root), /시작 플러그인/);

  act(() => {
    renderer.root.findByProps({ id: 'plugin-source-path' }).props.onChange({
      currentTarget: { value: 'D:\\workspace\\writing-tools' },
    });
  });
  await act(async () => {
    await directInstallForm(renderer.root).props.onSubmit({
      preventDefault() {},
    });
  });
  assert.deepEqual(requests, []);
  assert.match(
    renderedText(renderer.root.findByProps({ role: 'alert' })),
    /상대경로/,
  );

  act(() => {
    renderer.root.findByProps({ id: 'plugin-source-path' }).props.onChange({
      currentTarget: { value: 'plugins/writing-tools' },
    });
  });
  await act(async () => {
    await directInstallForm(renderer.root).props.onSubmit({
      preventDefault() {},
    });
  });

  assert.deepEqual(requests[0], {
    root: 'computer',
    path: 'plugins/writing-tools',
  });
  assert.match(renderedText(renderer.root), /스킬 2개/);
  assert.match(renderedText(renderer.root), /사용 가능/);
  assert.match(renderedText(renderer.root), /MCP 서버 2개/);
  assert.match(renderedText(renderer.root), /MCP 설정에서 관리/);
  assert.match(renderedText(renderer.root), /지원되지 않음/);
  assert.match(renderedText(renderer.root), /서버별 켜기\/끄기 설정은 유지/);
  assert.match(renderedText(renderer.root), /앱·훅은 아직 실행하지/);

  await act(async () => {
    renderer.root
      .findByProps({
        'aria-label': '글쓰기 도구 플러그인 사용',
      })
      .props.onClick();
  });
  assert.deepEqual(requests[1], {
    installationId: 'plugin-added',
    enabled: true,
  });
  assert.match(renderedText(renderer.root), /패키지 사용 설정됨/);
  assert.doesNotMatch(
    renderedText(
      renderer.root.findByProps({ 'aria-label': '글쓰기 도구 플러그인' }),
    ),
    /연결됨/,
  );

  act(() => {
    renderer.root
      .findByProps({ 'aria-label': '글쓰기 도구 플러그인 제거' })
      .props.onClick();
  });
  const confirmation = renderer.root.findByProps({ role: 'group' });
  assert.equal(
    confirmation.props['aria-label'],
    '글쓰기 도구 플러그인 제거 확인',
  );
  assert.match(
    renderedText(confirmation),
    /관리 저장소와 MCP 서버 2개를 함께 제거할까요/,
  );
  await act(async () => {
    confirmation
      .findByProps({
        'aria-label': '글쓰기 도구 플러그인 관리 저장소에서 제거',
      })
      .props.onClick();
  });
  assert.deepEqual(requests[2], { remove: 'plugin-added' });
  assert.doesNotMatch(renderedText(renderer.root), /글쓰기 도구/);

  act(() => renderer.unmount());
});

void test('plugin settings reports list failures through an alert', async () => {
  const client: PluginClient = {
    listPlugins: async () => {
      throw new Error('offline');
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
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PluginSettingsPanel
        client={client}
        marketplaceClient={emptyMarketplaceClient()}
        requestedPanel="manage"
      />,
    );
  });

  const alert = renderer.root.findByProps({ role: 'alert' });
  assert.match(renderedText(alert), /offline/);
  assert.doesNotMatch(
    renderedText(renderer.root),
    /설치된 플러그인이 없습니다/,
  );
  assert.equal(
    renderer.root.findByProps({ id: 'plugin-source-path' }).props.disabled,
    true,
  );
  assert.equal(
    renderer.root.findByProps({ 'aria-label': '플러그인 설치' }).props.disabled,
    true,
  );

  act(() => renderer.unmount());
});

void test('plugin settings waits for the initial list before allowing an install', async () => {
  let resolveList!: (value: { plugins: InstalledPluginView[] }) => void;
  const listResponse = new Promise<{ plugins: InstalledPluginView[] }>(
    (resolve) => {
      resolveList = resolve;
    },
  );
  let installCount = 0;
  const client: PluginClient = {
    listPlugins: async () => listResponse,
    installPlugin: async () => {
      installCount += 1;
      throw new Error('must remain disabled');
    },
    setEnabled: async () => {
      throw new Error('not called');
    },
    removePlugin: async () => {
      throw new Error('not called');
    },
  };

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PluginSettingsPanel
        client={client}
        marketplaceClient={emptyMarketplaceClient()}
        requestedPanel="manage"
      />,
    );
  });

  const input = renderer.root.findByProps({ id: 'plugin-source-path' });
  const submit = renderer.root.findByProps({
    'aria-label': '플러그인 설치',
  });
  assert.equal(input.props.disabled, true);
  assert.equal(submit.props.disabled, true);
  await act(async () => {
    await directInstallForm(renderer.root).props.onSubmit({
      preventDefault() {},
    });
  });
  assert.equal(installCount, 0);

  await act(async () => {
    resolveList({ plugins: [] });
    await listResponse;
  });
  assert.equal(
    renderer.root.findByProps({ id: 'plugin-source-path' }).props.disabled,
    false,
  );

  act(() => renderer.unmount());
});

void test('plugin settings loads the official catalog alongside installed plugins', async () => {
  const client: PluginClient = {
    listPlugins: async () => ({ plugins: [] }),
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
  let marketplaceListCount = 0;
  const source = officialMarketplaceSource();
  const marketplaceClient: PluginMarketplaceClient = {
    list: async () => {
      marketplaceListCount += 1;
      return { sources: [source], entries: [], diagnostics: [] };
    },
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

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PluginSettingsPanel
        client={client}
        marketplaceClient={marketplaceClient}
      />,
    );
  });
  assert.equal(marketplaceListCount, 1);
  assert.match(renderedText(renderer.root), /설치된 플러그인이 없습니다/);
  assert.match(renderedText(renderer.root), /Codex 공식 플러그인/);

  act(() => renderer.unmount());
});

void test('plugin browse hides marketplace source internals and gives installed icons an immediate tooltip label', async () => {
  const installed = pluginView({
    installationId: 'plugin-tooltip',
    name: 'pdf-tools',
    displayName: 'PDF',
    enabled: true,
  });
  const client: PluginClient = {
    listPlugins: async () => ({ plugins: [installed] }),
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

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PluginSettingsPanel
        client={client}
        marketplaceClient={emptyMarketplaceClient()}
      />,
    );
  });

  const installedIcon = renderer.root.findByProps({
    className: 'extension-installed-item',
  });
  assert.equal(installedIcon.props['aria-label'], 'PDF · 사용 중');
  assert.equal(installedIcon.props['data-tooltip'], 'PDF');
  assert.equal(installedIcon.props.tabIndex, 0);
  assert.doesNotMatch(renderedText(renderer.root), /Marketplace 소스 관리/);
  assert.equal(
    renderer.root.findAllByProps({ id: 'plugin-marketplace-url' }).length,
    0,
  );

  act(() => renderer.unmount());
});

function emptyMarketplaceClient(): PluginMarketplaceClient {
  const source = officialMarketplaceSource();
  return {
    list: async () => ({ sources: [source], entries: [], diagnostics: [] }),
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
}

function officialMarketplaceSource(): PluginMarketplaceSourceView {
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

function directInstallForm(root: ReactTestInstance): ReactTestInstance {
  const form = root
    .findAllByType('form')
    .find(
      (candidate) =>
        candidate.findAllByProps({ id: 'plugin-source-path' }).length === 1,
    );
  assert.ok(form, 'missing direct plugin install form');
  return form;
}

function pluginView({
  installationId,
  name,
  displayName,
  enabled,
  capabilities = [],
}: {
  installationId: string;
  name: string;
  displayName: string;
  enabled: boolean;
  capabilities?: InstalledPluginView['capabilities'];
}): InstalledPluginView {
  return {
    installationId,
    name,
    displayName,
    version: '1.0.0',
    description: '테스트 플러그인',
    enabled,
    contentDigest: `sha256:${'a'.repeat(64)}`,
    sourceKind: 'local-directory',
    installedAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    capabilities,
  };
}

function renderedText(node: ReactTestInstance | string): string {
  if (typeof node === 'string') {
    return node;
  }
  return node.children
    .map((child) => renderedText(child as ReactTestInstance | string))
    .join('');
}
