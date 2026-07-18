import { useState, type ReactNode } from 'react';

import {
  McpServerPanel,
  type McpServerClient,
} from '../features/mcp/McpServerPanel.js';

type SettingsSection = 'mcp';

interface HomeSettingsProps {
  mcpDisabled?: boolean;
  mcpClient?: McpServerClient;
  onClose: () => void;
}

interface HomeCenterSurfaceProps {
  settingsOpen: boolean;
  extensionsOpen?: boolean;
  // 아티팩트 표면 — 설정이 닫혀 있고 artifact 노드가 있으면 편집기 대신
  // 중앙 넓은 화면을 아티팩트가 차지한다
  artifact?: ReactNode;
  editor: ReactNode;
  extensions?: ReactNode;
  settings: ReactNode;
}

export function HomeCenterSurface({
  settingsOpen,
  extensionsOpen = false,
  artifact = null,
  editor,
  extensions = null,
  settings,
}: HomeCenterSurfaceProps) {
  const artifactOpen = !settingsOpen && !extensionsOpen && artifact !== null;
  const editorHidden = settingsOpen || extensionsOpen || artifactOpen;
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
      {artifactOpen ? artifact : null}
    </>
  );
}

export function HomeSettings({
  mcpDisabled = false,
  mcpClient,
  onClose,
}: HomeSettingsProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('mcp');

  return (
    <section className="home-settings" aria-label="설정">
      <header className="settings-header">
        <div>
          <span className="settings-eyebrow">글밭 홈</span>
          <h1>설정</h1>
          <p>확장 도구를 한곳에서 관리합니다.</p>
        </div>
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
        </nav>

        <div className="settings-page">
          {activeSection === 'mcp' ? (
            <McpServerPanel
              disabled={mcpDisabled}
              {...(mcpClient ? { client: mcpClient } : {})}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
