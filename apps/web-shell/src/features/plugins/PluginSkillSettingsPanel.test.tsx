import test from 'node:test';
import assert from 'node:assert/strict';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type { PluginMarketplaceSourceView } from '@geulbat/protocol/plugins';

import type { PluginMarketplaceClient } from './PluginMarketplacePanel.js';
import {
  PluginSkillSettingsPanel,
  type PluginSkillClient,
} from './PluginSkillSettingsPanel.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('plugin skill settings shows provenance, invocation policy, and runtime availability', async () => {
  const client: PluginSkillClient = {
    listSkills: async () => ({
      skills: [
        {
          skillRef: `geulbat-skill/plugin-writing/${'a'.repeat(64)}`,
          name: 'draft-review',
          description: '원고의 흐름과 장면 전환을 검토합니다.',
          enabled: true,
          allowImplicitInvocation: true,
          runtimeStatus: 'available',
          pluginInstallationId: 'plugin-writing',
          pluginName: 'writing-tools',
          pluginDisplayName: '글쓰기 도구',
          pluginVersion: '1.2.0',
        },
        {
          skillRef: `geulbat-skill/plugin-writing/${'b'.repeat(64)}`,
          name: 'private-notes',
          description: '직접 요청한 메모만 정리합니다.',
          enabled: false,
          allowImplicitInvocation: false,
          runtimeStatus: 'available',
          pluginInstallationId: 'plugin-writing',
          pluginName: 'writing-tools',
          pluginDisplayName: '글쓰기 도구',
          pluginVersion: '1.2.0',
        },
        {
          skillRef: `geulbat-skill/plugin-research/${'c'.repeat(64)}`,
          name: 'library-research',
          description: '외부 자료를 조사합니다.',
          enabled: true,
          allowImplicitInvocation: false,
          runtimeStatus: 'unavailable-tool-dependencies',
          pluginInstallationId: 'plugin-research',
          pluginName: 'research-tools',
          pluginDisplayName: '자료 조사',
          pluginVersion: '2.0.0',
        },
      ],
      diagnostics: [
        {
          pluginInstallationId: 'plugin-broken',
          pluginName: 'broken-tools',
          code: 'managed-package-invalid',
          message: '관리 사본의 무결성을 확인하지 못했습니다.',
        },
      ],
    }),
  };

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PluginSkillSettingsPanel
        client={client}
        marketplaceClient={emptyMarketplaceClient()}
      />,
    );
  });

  const text = renderedText(renderer.root);
  assert.match(text, /draft-review/);
  assert.match(text, /글쓰기 도구 · 1\.2\.0/);
  assert.match(text, /대화 문맥에서 선택 가능/);
  assert.match(text, /private-notes/);
  assert.match(text, /플러그인 사용 중지/);
  assert.match(text, /직접 요청할 때만/);
  assert.match(text, /library-research/);
  assert.match(text, /필요한 도구 없음/);
  assert.match(text, /broken-tools 플러그인/);
  assert.match(text, /포함된 스크립트는 자동으로 실행하지 않습니다/);

  act(() => renderer.unmount());
});

void test('plugin skill settings reports list failures without claiming an empty inventory', async () => {
  const client: PluginSkillClient = {
    listSkills: async () => {
      throw new Error('offline');
    },
  };

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PluginSkillSettingsPanel
        client={client}
        marketplaceClient={emptyMarketplaceClient()}
      />,
    );
  });

  const alert = renderer.root.findByProps({ role: 'alert' });
  assert.match(renderedText(alert), /offline/);
  assert.doesNotMatch(renderedText(renderer.root), /설치된 스킬이 없습니다/);

  act(() => renderer.unmount());
});

function emptyMarketplaceClient(): PluginMarketplaceClient {
  const source: PluginMarketplaceSourceView = {
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

function renderedText(node: ReactTestInstance | string): string {
  if (typeof node === 'string') {
    return node;
  }
  return node.children
    .map((child) => renderedText(child as ReactTestInstance | string))
    .join('');
}
