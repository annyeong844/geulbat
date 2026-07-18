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
  PluginMarketplaceListResponse,
  PluginMarketplaceSourceView,
} from '@geulbat/protocol/plugins';

import {
  PluginMarketplacePanel,
  type PluginMarketplaceClient,
} from './PluginMarketplacePanel.js';
import { PluginIcon } from './PluginIcon.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('official marketplace installs the exact catalog package and keeps unsupported entries inert', async () => {
  const source = sourceView('official');
  const installable = entryView({ source, name: 'workflow-helper' });
  const unsupported = entryView({
    source,
    name: 'npm-helper',
    sourceKind: 'npm',
    status: 'unsupported-source',
    contentDigest: null,
  });
  const installed = installedPlugin(source, installable);
  const installRequests: unknown[] = [];
  const uninstallRequests: string[] = [];
  const installedPlugins: InstalledPluginView[] = [];
  const uninstalledPlugins: string[] = [];
  let manageCount = 0;
  const client: PluginMarketplaceClient = {
    list: async () => ({
      sources: [source],
      entries: [installable, unsupported],
      diagnostics: [
        {
          marketplaceId: source.marketplaceId,
          entryName: unsupported.name,
          code: 'unsupported-source',
          message: 'npm entry acquisition is not implemented',
        },
      ],
    }),
    ensureOfficial: async () => {
      throw new Error('official source already exists');
    },
    add: async () => {
      throw new Error('not called');
    },
    install: async (request) => {
      installRequests.push(request);
      return { plugin: installed };
    },
    uninstall: async (installationId) => {
      uninstallRequests.push(installationId);
      return { removedInstallationId: installationId };
    },
    remove: async () => {
      throw new Error('official source cannot be removed');
    },
  };

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PluginMarketplacePanel
        client={client}
        onInstalled={(plugin) => installedPlugins.push(plugin)}
        onUninstalled={(installationId) =>
          uninstalledPlugins.push(installationId)
        }
        onManageInstalled={() => {
          manageCount += 1;
        }}
      />,
    );
  });

  assert.match(renderedText(renderer.root), /Codex official 연결됨/);
  assert.equal(
    renderer.root
      .findAllByType('button')
      .some((button) => renderedText(button) === '소스 제거'),
    false,
  );
  const workflowRow = renderer.root
    .findByProps({ 'aria-label': 'Productivity 플러그인' })
    .findByProps({
      'aria-label': 'workflow-helper 마켓 플러그인',
    });
  assert.doesNotMatch(renderedText(workflowRow), /설치 가능/);
  await act(async () => {
    findButtonByText(workflowRow, '설치').props.onClick();
  });
  assert.deepEqual(installRequests, [
    {
      marketplaceId: source.marketplaceId,
      entryId: installable.entryId,
      expectedContentDigest: installable.contentDigest,
    },
  ]);
  assert.deepEqual(installedPlugins, [installed]);
  assert.doesNotMatch(renderedText(workflowRow), /설치됨|설치 가능/);
  workflowRow.findByProps({
    'aria-label': 'workflow-helper 플러그인 메뉴',
  });
  act(() => {
    workflowRow
      .findByProps({
        'aria-label': 'workflow-helper 플러그인 메뉴',
      })
      .props.onClick();
  });
  act(() => {
    findButtonByText(workflowRow, '관리').props.onClick();
  });
  assert.equal(manageCount, 1);

  act(() => {
    workflowRow
      .findByProps({
        'aria-label': 'workflow-helper 플러그인 메뉴',
      })
      .props.onClick();
  });
  act(() => {
    workflowRow
      .findByProps({
        'aria-label': 'workflow-helper 플러그인 제거',
      })
      .props.onClick();
  });
  await act(async () => {
    workflowRow
      .findByProps({
        'aria-label': 'workflow-helper 플러그인 제거 확인',
      })
      .props.onClick();
  });
  assert.deepEqual(uninstallRequests, [installed.installationId]);
  assert.deepEqual(uninstalledPlugins, [installed.installationId]);
  assert.equal(findButtonByText(workflowRow, '설치').props.disabled, false);

  act(() => {
    renderer.root
      .findByProps({ 'aria-label': '플러그인 보기 필터' })
      .props.onClick();
  });
  act(() => {
    findButtonByText(renderer.root, 'Productivity').props.onClick();
  });
  const npmRow = renderer.root.findByProps({
    'aria-label': 'npm-helper 마켓 플러그인',
  });
  assert.equal(
    npmRow
      .findAllByType('button')
      .some((button) => renderedText(button) === '설치'),
    false,
  );
  assert.doesNotMatch(renderedText(npmRow), /지원 예정|설치 가능/);
  assert.match(
    renderedText(renderer.root),
    /npm entry acquisition is not implemented/,
  );

  act(() => renderer.unmount());
});

void test('marketplace shows every category with six-entry previews and expands sections independently', async () => {
  const source = sourceView('official');
  const productivityRich = entryView({
    source,
    name: 'productivity-rich',
    category: 'Productivity',
    capabilities: [
      { kind: 'skills', supportStatus: 'supported', itemCount: 4 },
    ],
  });
  const productivityEntries = Array.from({ length: 7 }, (_, index) =>
    entryView({
      source,
      name: `productivity-${index + 1}`,
      category: 'Productivity',
      capabilities: [
        { kind: 'skills', supportStatus: 'supported', itemCount: 1 },
      ],
    }),
  );
  const categoryRepresentatives = [
    'Finance',
    'Communication',
    'Creativity',
    'Data & Analytics',
    'Developer Tools',
    'Education & Research',
  ].map((category, index) =>
    entryView({
      source,
      name: `ready-${index + 1}`,
      category,
      capabilities: [
        { kind: 'skills', supportStatus: 'supported', itemCount: 2 },
      ],
    }),
  );
  const appOnly = entryView({
    source,
    name: 'app-only',
    category: 'Other',
    iconAvailable: false,
    capabilities: [
      { kind: 'apps', supportStatus: 'unsupported', itemCount: 1 },
    ],
  });
  const client: PluginMarketplaceClient = {
    list: async () => ({
      sources: [source],
      entries: [
        productivityRich,
        ...productivityEntries,
        ...categoryRepresentatives,
        appOnly,
      ],
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

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PluginMarketplacePanel client={client} onInstalled={() => undefined} />,
    );
  });

  const featuredSection = renderer.root.findByProps({
    'aria-label': 'Featured 플러그인',
  });
  assert.equal(
    featuredSection.findAllByProps({ className: 'extension-list-row' }).length,
    6,
  );
  assert.equal(
    featuredSection.findByProps({
      'aria-label': 'Featured의 숨겨진 플러그인 1개 더 보기',
    }).props['aria-expanded'],
    false,
  );

  const productivitySection = renderer.root.findByProps({
    'aria-label': 'Productivity 플러그인',
  });
  assert.equal(
    renderer.root.findAllByProps({ className: 'extension-category' })[0]?.props[
      'aria-label'
    ],
    'Productivity 플러그인',
  );
  assert.equal(
    productivitySection.findAllByProps({ className: 'extension-list-row' })
      .length,
    6,
  );
  const productivityRowText = productivitySection
    .findAllByProps({ className: 'extension-list-row' })
    .map((row) => renderedText(row))
    .join(' ');
  assert.match(productivityRowText, /productivity-5/);
  assert.doesNotMatch(productivityRowText, /productivity-6/);
  assert.doesNotMatch(productivityRowText, /productivity-7/);
  assert.match(renderedText(renderer.root), /app-only/);
  assert.equal(
    renderer.root.findAllByType('img').every((image) => {
      return (
        image.props.loading === undefined && image.props.decoding === 'async'
      );
    }),
    true,
  );
  assert.equal(
    renderer.root
      .findAllByType(PluginIcon)
      .every((icon) => icon.props.defer === true),
    true,
  );
  assert.equal(
    renderer.root
      .findAllByType('img')
      .some((image) => String(image.props.src).includes('app-only')),
    false,
  );

  act(() => {
    productivitySection
      .findByProps({
        'aria-label': 'Productivity의 숨겨진 플러그인 2개 더 보기',
      })
      .props.onClick();
  });
  assert.equal(
    productivitySection.findAllByProps({ className: 'extension-list-row' })
      .length,
    8,
  );
  assert.match(renderedText(productivitySection), /productivity-7/);

  act(() => {
    featuredSection
      .findByProps({
        'aria-label': 'Featured의 숨겨진 플러그인 1개 더 보기',
      })
      .props.onClick();
  });
  assert.equal(
    featuredSection.findAllByProps({ className: 'extension-list-row' }).length,
    7,
  );

  act(() => {
    renderer.root
      .findByProps({ 'aria-label': '플러그인 보기 필터' })
      .props.onClick();
  });
  act(() => {
    findButtonByText(renderer.root, 'Productivity').props.onClick();
  });
  assert.match(renderedText(renderer.root), /Productivity/);
  assert.match(renderedText(renderer.root), /productivity-rich/);
  assert.match(renderedText(renderer.root), /productivity-7/);
  assert.doesNotMatch(renderedText(renderer.root), /ready-1/);
  assert.doesNotMatch(renderedText(renderer.root), /app-only/);

  act(() => renderer.unmount());
});

void test('official marketplace is connected by daemon policy without a caller-supplied URL', async () => {
  const source = sourceView('official');
  const responses: PluginMarketplaceListResponse[] = [
    { sources: [], entries: [], diagnostics: [] },
    { sources: [source], entries: [], diagnostics: [] },
  ];
  let ensureCount = 0;
  const addRequests: unknown[] = [];
  const client: PluginMarketplaceClient = {
    list: async () =>
      responses.shift() ?? { sources: [source], entries: [], diagnostics: [] },
    ensureOfficial: async () => {
      ensureCount += 1;
      return { marketplace: source };
    },
    add: async (request) => {
      addRequests.push(request);
      return { marketplace: source };
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
      <PluginMarketplacePanel client={client} onInstalled={() => undefined} />,
    );
  });

  assert.equal(ensureCount, 1);
  assert.deepEqual(addRequests, []);
  assert.match(renderedText(renderer.root), /Codex official 연결됨/);
  assert.doesNotMatch(renderedText(renderer.root), /OpenAI 공개 소스 추가/);

  act(() => renderer.unmount());
});

void test('personal marketplace remains optional and only personal sources can be removed', async () => {
  const official = sourceView('official');
  const custom = sourceView('custom');
  const customEntry = entryView({ source: custom, name: 'my-helper' });
  const removedSources: string[] = [];
  const client: PluginMarketplaceClient = {
    list: async () => ({
      sources: [official, custom],
      entries: [customEntry],
      diagnostics: [],
    }),
    ensureOfficial: async () => {
      throw new Error('not called');
    },
    add: async () => {
      throw new Error('not called');
    },
    install: async () => {
      throw new Error('not called');
    },
    remove: async (marketplaceId) => {
      removedSources.push(marketplaceId);
      return { removedMarketplaceId: marketplaceId };
    },
  };

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PluginMarketplacePanel client={client} onInstalled={() => undefined} />,
    );
  });
  act(() => {
    findButtonByText(renderer.root, '개인용 · 1').props.onClick();
    findButtonByText(renderer.root, '소스 제거').props.onClick();
  });
  const confirmation = renderer.root.findByProps({ role: 'group' });
  assert.match(renderedText(confirmation), /설치한 사본은 유지/);
  await act(async () => {
    findButtonByText(confirmation, '제거').props.onClick();
  });
  assert.deepEqual(removedSources, [custom.marketplaceId]);
  assert.doesNotMatch(renderedText(renderer.root), /my-helper/);

  act(() => renderer.unmount());
});

void test('plugin marketplace reports catalog load failures without showing an empty success state', async () => {
  const client: PluginMarketplaceClient = {
    list: async () => {
      throw new Error('catalog offline');
    },
    ensureOfficial: async () => {
      throw new Error('not called');
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
      <PluginMarketplacePanel client={client} onInstalled={() => undefined} />,
    );
  });

  assert.match(
    renderedText(renderer.root.findByProps({ role: 'alert' })),
    /catalog offline/,
  );
  assert.doesNotMatch(
    renderedText(renderer.root),
    /표시할 플러그인이 없습니다/,
  );

  act(() => renderer.unmount());
});

function sourceView(
  sourceRole: PluginMarketplaceSourceView['sourceRole'],
): PluginMarketplaceSourceView {
  const official = sourceRole === 'official';
  return {
    marketplaceId: official
      ? '00000000-0000-4000-8000-000000000001'
      : '00000000-0000-4000-8000-000000000003',
    name: official ? 'openai-curated' : 'personal-tools',
    displayName: official ? 'Codex official' : 'Personal tools',
    sourceRole,
    sourceKind: 'git',
    sourceUrl: official
      ? 'https://github.com/openai/plugins.git'
      : 'https://github.com/example/plugins.git',
    requestedRef: 'main',
    resolvedRevision: `git:${official ? 'a' : 'c'}`.padEnd(
      44,
      official ? 'a' : 'c',
    ),
    addedAt: '2026-07-16T00:00:00.000Z',
    refreshedAt: '2026-07-16T00:00:00.000Z',
  };
}

function entryView(args: {
  source: PluginMarketplaceSourceView;
  name: string;
  category?: string;
  capabilities?: PluginMarketplaceEntryView['capabilities'];
  iconAvailable?: boolean;
  sourceKind?: PluginMarketplaceEntryView['sourceKind'];
  status?: PluginMarketplaceEntryView['status'];
  contentDigest?: string | null;
}): PluginMarketplaceEntryView {
  return {
    entryId: args.name,
    marketplaceId: args.source.marketplaceId,
    marketplaceName: args.source.name,
    marketplaceDisplayName: args.source.displayName,
    name: args.name,
    displayName: args.name,
    version: '1.0.0',
    description: `${args.name} description`,
    iconAvailable: args.iconAvailable ?? true,
    category: args.category ?? 'Productivity',
    sourceKind: args.sourceKind ?? 'local',
    status: args.status ?? 'installable',
    installationPolicy: 'AVAILABLE',
    authenticationPolicy: 'ON_INSTALL',
    contentDigest:
      args.contentDigest === undefined
        ? `sha256:${'b'.repeat(64)}`
        : args.contentDigest,
    resolvedRevision: args.source.resolvedRevision,
    installedInstallationId: null,
    capabilities: args.capabilities ?? [
      { kind: 'skills', supportStatus: 'supported', itemCount: 1 },
    ],
  };
}

function installedPlugin(
  source: PluginMarketplaceSourceView,
  entry: PluginMarketplaceEntryView,
): InstalledPluginView {
  return {
    installationId: '00000000-0000-4000-8000-000000000002',
    name: entry.name,
    displayName: entry.displayName,
    version: entry.version ?? '1.0.0',
    description: entry.description,
    enabled: false,
    contentDigest: entry.contentDigest!,
    sourceKind: 'marketplace',
    marketplaceSource: {
      marketplaceId: source.marketplaceId,
      marketplaceName: source.name,
      marketplaceDisplayName: source.displayName,
      entryId: entry.entryId,
      resolvedRevision: source.resolvedRevision,
    },
    installedAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    capabilities: entry.capabilities,
  };
}

function findButtonByText(
  root: ReactTestInstance,
  text: string,
): ReactTestInstance {
  const button = root
    .findAllByType('button')
    .find((candidate) => renderedText(candidate) === text);
  assert.ok(button, `missing button: ${text}`);
  return button;
}

function renderedText(node: ReactTestInstance | string): string {
  if (typeof node === 'string') {
    return node;
  }
  return node.children
    .map((child) => renderedText(child as ReactTestInstance | string))
    .join('');
}
