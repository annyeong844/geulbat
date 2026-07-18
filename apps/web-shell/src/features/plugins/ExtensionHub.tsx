import { useState } from 'react';

import {
  PluginSettingsPanel,
  type PluginClient,
  type PluginPanelRequest,
} from './PluginSettingsPanel.js';
import {
  PluginSkillSettingsPanel,
  type PluginSkillClient,
} from './PluginSkillSettingsPanel.js';
import type { PluginMarketplaceClient } from './PluginMarketplacePanel.js';

type ExtensionHubTab = 'plugins' | 'skills';
export type ExtensionCreatorKind = 'plugin' | 'skill';

interface Props {
  disabled?: boolean;
  marketplaceClient?: PluginMarketplaceClient;
  pluginClient?: PluginClient;
  skillClient?: PluginSkillClient;
  onClose: () => void;
  onStartCreator: (kind: ExtensionCreatorKind) => void;
}

const TAB_COPY: Record<
  ExtensionHubTab,
  { title: string; description: string; searchPlaceholder: string }
> = {
  plugins: {
    title: '플러그인',
    description:
      'Codex 공식 marketplace의 플러그인을 찾아 글밭에 직접 설치하고 관리합니다.',
    searchPlaceholder: '플러그인 검색',
  },
  skills: {
    title: '스킬',
    description:
      '설치된 스킬과 Codex 공식 marketplace에서 제공하는 스킬을 함께 찾습니다.',
    searchPlaceholder: '스킬 검색',
  },
};

const PLUGIN_PANEL_COPY: Record<
  PluginPanelRequest,
  { title: string; description: string; searchPlaceholder: string }
> = {
  browse: {
    title: '플러그인',
    description: '즐겨 쓰는 도구 어디서나 글밭과 함께 작업하세요.',
    searchPlaceholder: '플러그인 검색',
  },
  manage: {
    title: '플러그인 관리',
    description: '설치된 플러그인의 사용 여부와 보관 상태를 관리합니다.',
    searchPlaceholder: '설치된 플러그인 검색',
  },
};

export function ExtensionHub({
  disabled = false,
  marketplaceClient,
  pluginClient,
  skillClient,
  onClose,
  onStartCreator,
}: Props) {
  const [activeTab, setActiveTab] = useState<ExtensionHubTab>('plugins');
  const [query, setQuery] = useState('');
  const [pluginPanel, setPluginPanel] = useState<PluginPanelRequest>('browse');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [creatorMenuOpen, setCreatorMenuOpen] = useState(false);
  const copy =
    activeTab === 'plugins' ? PLUGIN_PANEL_COPY[pluginPanel] : TAB_COPY.skills;

  const selectTab = (tab: ExtensionHubTab) => {
    setActiveTab(tab);
    setQuery('');
    setCreatorMenuOpen(false);
    if (tab === 'plugins') {
      setPluginPanel('browse');
    }
  };

  const refreshPlugins = () => {
    setPluginPanel('browse');
    setRefreshVersion((current) => current + 1);
  };

  return (
    <section className="extension-hub" aria-label="플러그인과 스킬">
      <header className="extension-hub-header">
        <div className="extension-hub-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'plugins'}
            onClick={() => selectTab('plugins')}
          >
            플러그인
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'skills'}
            onClick={() => selectTab('skills')}
          >
            스킬
          </button>
        </div>
        <div className="extension-hub-actions">
          {activeTab === 'plugins' ? (
            <>
              <button
                type="button"
                className="extension-hub-icon-action"
                aria-label="플러그인 새로고침"
                title="플러그인 새로고침"
                onClick={refreshPlugins}
              >
                ↻
              </button>
              <button
                type="button"
                className="extension-hub-icon-action"
                aria-label="플러그인 관리"
                aria-pressed={pluginPanel === 'manage'}
                title="플러그인 관리"
                onClick={() => setPluginPanel('manage')}
              >
                ⚙
              </button>
            </>
          ) : null}
          <div className="extension-create-menu">
            <button
              type="button"
              className="extension-create-action"
              aria-label="만들기 메뉴"
              aria-haspopup="menu"
              aria-expanded={creatorMenuOpen}
              onClick={() => setCreatorMenuOpen((open) => !open)}
            >
              만들기⌄
            </button>
            {creatorMenuOpen ? (
              <div className="extension-create-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCreatorMenuOpen(false);
                    onStartCreator('plugin');
                  }}
                >
                  <strong>플러그인 만들기</strong>
                  <span>@plugin_creator로 채팅에서 시작</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCreatorMenuOpen(false);
                    onStartCreator('skill');
                  }}
                >
                  <strong>스킬 만들기</strong>
                  <span>@skill_creator로 채팅에서 시작</span>
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="settings-close"
            aria-label="확장 허브 닫기"
            title="편집기로 돌아가기"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>

      <div className="extension-hub-scroll">
        <div className="extension-hub-intro">
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
          <label className="extension-search">
            <span aria-hidden="true">⌕</span>
            <span className="sr-only">{copy.searchPlaceholder}</span>
            <input
              type="search"
              value={query}
              placeholder={copy.searchPlaceholder}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        </div>

        <div className="extension-hub-content">
          {activeTab === 'plugins' ? (
            <PluginSettingsPanel
              key={`plugin-panel-${refreshVersion}`}
              disabled={disabled}
              query={query}
              requestedPanel={pluginPanel}
              onRequestManage={() => setPluginPanel('manage')}
              {...(pluginClient ? { client: pluginClient } : {})}
              {...(marketplaceClient ? { marketplaceClient } : {})}
            />
          ) : (
            <PluginSkillSettingsPanel
              disabled={disabled}
              query={query}
              {...(skillClient ? { client: skillClient } : {})}
              {...(marketplaceClient ? { marketplaceClient } : {})}
            />
          )}
        </div>
      </div>
    </section>
  );
}
