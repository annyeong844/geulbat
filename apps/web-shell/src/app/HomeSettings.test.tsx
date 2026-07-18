import test from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import type { McpServerClient } from '../features/mcp/McpServerPanel.js';
import { HomeCenterSurface, HomeSettings } from './HomeSettings.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

// 연결 상태 표시·재연결은 어시스턴트 타이틀 점이 담당한다 — 설정에는
// 연결 탭이 더 이상 없다.
void test('HomeSettings owns MCP administration without a connection tab', async () => {
  let closeCount = 0;
  const client = emptyMcpClient();
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = TestRenderer.create(
      <HomeSettings
        mcpClient={client}
        onClose={() => {
          closeCount += 1;
        }}
      />,
    );
  });

  assert.match(renderedText(renderer.root), /연결된 MCP 서버가 없습니다/);
  assert.equal(
    renderer.root.findAllByProps({ 'aria-label': '연결 설정' }).length,
    0,
  );

  act(() => {
    renderer.root.findByProps({ 'aria-label': '설정 닫기' }).props.onClick();
  });
  assert.equal(closeCount, 1);

  act(() => renderer.unmount());
});

void test('HomeCenterSurface keeps editor-local state across center overlays', () => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<CenterSurfaceHarness />);
  });

  act(() => {
    renderer.root
      .findByProps({ 'aria-label': '편집기 상태 변경' })
      .props.onClick();
    renderer.root.findByProps({ 'aria-label': '설정 전환' }).props.onClick();
  });
  assert.match(renderedText(renderer.root), /설정 화면/);

  act(() => {
    renderer.root.findByProps({ 'aria-label': '설정 전환' }).props.onClick();
    renderer.root.findByProps({ 'aria-label': '확장 전환' }).props.onClick();
  });
  assert.match(renderedText(renderer.root), /확장 화면/);

  act(() => {
    renderer.root.findByProps({ 'aria-label': '확장 전환' }).props.onClick();
  });
  assert.match(renderedText(renderer.root), /편집기 상태 1/);

  act(() => renderer.unmount());
});

function CenterSurfaceHarness() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="설정 전환"
        onClick={() => setSettingsOpen((open) => !open)}
      />
      <button
        type="button"
        aria-label="확장 전환"
        onClick={() => setExtensionsOpen((open) => !open)}
      />
      <HomeCenterSurface
        settingsOpen={settingsOpen}
        extensionsOpen={extensionsOpen}
        editor={<StatefulEditor />}
        extensions={<div>확장 화면</div>}
        settings={<div>설정 화면</div>}
      />
    </>
  );
}

function StatefulEditor() {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      aria-label="편집기 상태 변경"
      onClick={() => setCount((current) => current + 1)}
    >
      편집기 상태 {count}
    </button>
  );
}

function emptyMcpClient(): McpServerClient {
  return {
    listServers: async () => ({ servers: [] }),
    addServer: async () => {
      throw new Error('not called');
    },
    setEnabled: async () => {
      throw new Error('not called');
    },
    installTool: async () => {
      throw new Error('not called');
    },
    uninstallTool: async () => {
      throw new Error('not called');
    },
    removeServer: async () => {
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
