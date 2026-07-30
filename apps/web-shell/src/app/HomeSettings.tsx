import { useState, type ComponentProps, type ReactNode } from 'react';

import {
  McpServerPanel,
  type McpServerClient,
} from '../features/mcp/McpServerPanel.js';
import { ProviderAuthCard } from '../features/provider-auth/ProviderAuthCard.js';
import { ProviderUsageCard } from '../features/provider-usage/ProviderUsageCard.js';
import { fetchProviderUsage } from '../lib/api/provider-usage.js';
import { PtcArtifactExportSettingsPanel } from '../features/settings/PtcArtifactExportSettingsPanel.js';

export type SettingsSection = 'providers' | 'usage' | 'mcp' | 'ptc';

interface HomeSettingsProps {
  providerAuthCard: ComponentProps<typeof ProviderAuthCard>;
  initialSection?: SettingsSection;
  /** 사용량 조회 주입 — 테스트가 실제 네트워크 없이 상태를 잠근다. */
  loadProviderUsage?: ComponentProps<typeof ProviderUsageCard>['loadUsage'];
  mcpDisabled?: boolean;
  mcpClient?: McpServerClient;
  onClose: () => void;
}

interface HomeCenterSurfaceProps {
  settingsOpen: boolean;
  extensionsOpen?: boolean;
  sessionsOpen?: boolean;
  reviewOpen?: boolean;
  // 아티팩트 표면 — 설정이 닫혀 있고 artifact 노드가 있으면 편집기 대신
  // 중앙 넓은 화면을 아티팩트가 차지한다
  artifact?: ReactNode;
  editor: ReactNode;
  extensions?: ReactNode;
  settings: ReactNode;
  sessions?: ReactNode;
  review?: ReactNode;
}

export function HomeCenterSurface({
  settingsOpen,
  extensionsOpen = false,
  sessionsOpen = false,
  reviewOpen = false,
  artifact = null,
  editor,
  extensions = null,
  settings,
  sessions = null,
  review = null,
}: HomeCenterSurfaceProps) {
  const artifactOpen =
    !settingsOpen &&
    !extensionsOpen &&
    !sessionsOpen &&
    !reviewOpen &&
    artifact !== null;
  const editorHidden =
    settingsOpen ||
    extensionsOpen ||
    sessionsOpen ||
    reviewOpen ||
    artifactOpen;
  return (
    <>
      <div
        className="home-editor-surface"
        hidden={editorHidden}
        aria-hidden={editorHidden}
      >
        {editor}
      </div>
      {settingsOpen ? settings : null}
      {extensionsOpen ? extensions : null}
      {sessionsOpen ? sessions : null}
      {reviewOpen ? review : null}
      {artifactOpen ? artifact : null}
    </>
  );
}

export function HomeSettings({
  providerAuthCard,
  initialSection = 'providers',
  loadProviderUsage = fetchProviderUsage,
  mcpDisabled = false,
  mcpClient,
  onClose,
}: HomeSettingsProps) {
  const [activeSection, setActiveSection] =
    useState<SettingsSection>(initialSection);

  return (
    <section className="home-settings" aria-label="설정">
      <header className="settings-header">
        <button
          type="button"
          className="settings-close"
          aria-label="설정 닫기"
          title="편집기로 돌아가기"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="설정 메뉴">
          <button
            type="button"
            className={activeSection === 'providers' ? 'active' : ''}
            aria-label="AI 제공자 연결 설정"
            aria-current={activeSection === 'providers' ? 'page' : undefined}
            onClick={() => setActiveSection('providers')}
          >
            <span className="settings-nav-icon" aria-hidden="true">
              ◉
            </span>
            <span>AI 제공자</span>
          </button>
          <button
            type="button"
            className={activeSection === 'usage' ? 'active' : ''}
            aria-label="사용량 설정"
            aria-current={activeSection === 'usage' ? 'page' : undefined}
            onClick={() => setActiveSection('usage')}
          >
            <span className="settings-nav-icon" aria-hidden="true">
              ▤
            </span>
            <span>사용량</span>
          </button>
          <button
            type="button"
            className={activeSection === 'mcp' ? 'active' : ''}
            aria-label="MCP 서버 설정"
            aria-current={activeSection === 'mcp' ? 'page' : undefined}
            onClick={() => setActiveSection('mcp')}
          >
            <span className="settings-nav-icon" aria-hidden="true">
              ⌘
            </span>
            <span>MCP 서버</span>
          </button>
          <button
            type="button"
            className={activeSection === 'ptc' ? 'active' : ''}
            aria-label="PTC 아티팩트 설정"
            aria-current={activeSection === 'ptc' ? 'page' : undefined}
            onClick={() => setActiveSection('ptc')}
          >
            <span className="settings-nav-icon" aria-hidden="true">
              ◫
            </span>
            <span>PTC 아티팩트</span>
          </button>
        </nav>

        <div className="settings-page">
          {activeSection === 'providers' ? (
            <ProviderAuthCard {...providerAuthCard} />
          ) : null}
          {activeSection === 'usage' ? (
            <ProviderUsageCard loadUsage={loadProviderUsage} />
          ) : null}
          {activeSection === 'mcp' ? (
            <McpServerPanel
              disabled={mcpDisabled}
              {...(mcpClient ? { client: mcpClient } : {})}
            />
          ) : null}
          {activeSection === 'ptc' ? <PtcArtifactExportSettingsPanel /> : null}
        </div>
      </div>
    </section>
  );
}
