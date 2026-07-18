import test from 'node:test';
import assert from 'node:assert/strict';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import type { McpServerView } from '@geulbat/protocol/mcp';

import { McpServerPanel, type McpServerClient } from './McpServerPanel.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('MCP panel adds, toggles, and removes a global stdio server', async () => {
  const requests: unknown[] = [];
  const initial = serverView({
    serverId: 'server-initial',
    name: '기존 MCP',
    enabled: false,
  });
  const added = serverView({
    serverId: 'server-added',
    name: '파일 도구',
    enabled: true,
    state: 'ready',
    advertisedToolCount: 3,
    availableToolNames: ['read_file', 'write_file'],
  });
  const client: McpServerClient = {
    listServers: async () => ({ servers: [initial] }),
    addServer: async (request) => {
      requests.push(request);
      return { server: added };
    },
    setEnabled: async (serverId, enabled) => {
      requests.push({ serverId, enabled });
      return {
        server: serverView({
          serverId,
          name: '파일 도구',
          enabled,
          state: enabled ? 'ready' : 'disabled',
        }),
      };
    },
    installTool: async (serverId, toolName) => {
      requests.push({ install: { serverId, toolName } });
      return {
        server: serverView({
          serverId,
          name: '파일 도구',
          enabled: true,
          state: 'ready',
          advertisedToolCount: 3,
          availableToolNames: ['read_file', 'write_file'],
          installedToolNames: [toolName],
          activeToolNames: [toolName],
        }),
      };
    },
    uninstallTool: async (serverId, toolName) => {
      requests.push({ uninstall: { serverId, toolName } });
      return {
        server: serverView({
          serverId,
          name: '파일 도구',
          enabled: true,
          state: 'ready',
          advertisedToolCount: 3,
          availableToolNames: ['read_file', 'write_file'],
        }),
      };
    },
    removeServer: async (serverId) => {
      requests.push({ remove: serverId });
      return { removedServerId: serverId };
    },
  };

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<McpServerPanel client={client} />);
  });
  assert.match(renderedText(renderer.root), /기존 MCP/);

  await act(async () => {
    renderer.root
      .findByProps({ 'aria-label': 'MCP 서버 추가' })
      .props.onClick();
  });
  await act(async () => {
    changeField(renderer, '예: 파일 도구', '파일 도구');
    changeField(renderer, '예: npx', 'npx');
    changeField(
      renderer,
      '-y\n@modelcontextprotocol/server-filesystem',
      '-y\n@modelcontextprotocol/server-filesystem\n/srv/files',
    );
    changeField(renderer, 'API_KEY', 'MCP_API_KEY');
    changeField(renderer, 'SDK 기본값', '2500');
    changeField(renderer, 'SDK 요청 기본값', '9000');
    changeField(renderer, '기본 2000ms', '1500');
  });
  await act(async () => {
    await renderer.root.findByType('form').props.onSubmit({
      preventDefault() {},
    });
  });

  assert.deepEqual(requests[0], {
    name: '파일 도구',
    enabled: true,
    transport: {
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/files'],
      envKeys: ['MCP_API_KEY'],
      connectionTimeoutMs: 2500,
      requestTimeoutMs: 9000,
      shutdownGraceMs: 1500,
    },
  });
  assert.doesNotMatch(renderedText(renderer.root), /read_file/);
  assert.match(
    renderedText(renderer.root),
    /서버 제공 3개 · 설치 가능 2개 · 설치됨 0개 · 모델 비노출 1개/,
  );

  await act(async () => {
    buttonWithText(renderer, '도구 관리').props.onClick();
  });
  assert.match(renderedText(renderer.root), /read_file/);
  assert.match(
    renderedText(renderer.root),
    /이름 목록과 설치한 실행 스키마만 유지합니다/,
  );
  await act(async () => {
    buttonWithText(
      toolRowWithText(renderer, 'read_file'),
      '스키마 설치',
    ).props.onClick();
  });
  assert.deepEqual(requests[1], {
    install: { serverId: 'server-added', toolName: 'read_file' },
  });
  assert.match(renderedText(renderer.root), /설치됨 1개/);
  assert.match(
    renderedText(toolRowWithText(renderer, 'read_file')),
    /설치됨 · 활성/,
  );

  await act(async () => {
    buttonWithText(
      toolRowWithText(renderer, 'read_file'),
      '스키마 제거',
    ).props.onClick();
  });
  assert.deepEqual(requests[2], {
    uninstall: { serverId: 'server-added', toolName: 'read_file' },
  });

  await act(async () => {
    buttonWithText(renderer, '끄기').props.onClick();
  });
  assert.deepEqual(requests[3], {
    serverId: 'server-added',
    enabled: false,
  });

  await act(async () => {
    const addedRow = rowWithText(renderer, '파일 도구');
    buttonWithText(addedRow, '제거').props.onClick();
  });
  await act(async () => {
    const dialog = renderer.root.findByProps({ role: 'alertdialog' });
    buttonWithText(dialog, '제거').props.onClick();
  });
  assert.deepEqual(requests[4], { remove: 'server-added' });
  assert.doesNotMatch(renderedText(renderer.root), /파일 도구/);

  await act(async () => {
    renderer.unmount();
  });
});

void test('plugin-provided MCP keeps its server preference without exposing direct removal', async () => {
  const requests: unknown[] = [];
  const source = {
    kind: 'plugin',
    installationId: 'plugin-writing-tools',
    name: 'writing-tools',
    displayName: '글쓰기 도구',
    version: '1.2.3',
    contentDigest: `sha256:${'a'.repeat(64)}`,
    serverName: 'research',
  } as const;
  const client: McpServerClient = {
    listServers: async () => ({
      servers: [
        serverView({
          serverId: 'plugin-writing-tools-research',
          name: '자료 조사',
          enabled: true,
          state: 'disabled',
          source,
          disabledReason: 'plugin-disabled',
        }),
      ],
    }),
    addServer: async () => {
      throw new Error('not called');
    },
    setEnabled: async (serverId, enabled) => {
      requests.push({ serverId, enabled });
      return {
        server: serverView({
          serverId,
          name: '자료 조사',
          enabled,
          state: 'disabled',
          source,
          disabledReason: 'plugin-disabled',
        }),
      };
    },
    installTool: async () => {
      throw new Error('not called');
    },
    uninstallTool: async () => {
      throw new Error('not called');
    },
    removeServer: async (serverId) => {
      requests.push({ remove: serverId });
      return { removedServerId: serverId };
    },
  };

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<McpServerPanel client={client} />);
  });

  const row = rowWithText(renderer, '자료 조사');
  assert.match(
    renderedText(row),
    /플러그인 제공 · 글쓰기 도구 1\.2\.3 · research/,
  );
  assert.match(renderedText(row), /플러그인 사용 중지/);
  assert.match(renderedText(row), /현재 켜기\/끄기 설정을 따릅니다/);
  assert.match(renderedText(row), /플러그인을 제거하면 함께 삭제됩니다/);
  assert.equal(
    row
      .findAllByType('button')
      .some((button) => renderedText(button) === '제거'),
    false,
  );

  await act(async () => {
    buttonWithText(row, '끄기').props.onClick();
  });
  assert.deepEqual(requests, [
    { serverId: 'plugin-writing-tools-research', enabled: false },
  ]);

  await act(async () => {
    renderer.unmount();
  });
});

function serverView({
  serverId,
  name,
  enabled,
  state = enabled ? 'ready' : 'disabled',
  availableToolNames = [],
  installedToolNames = [],
  activeToolNames = installedToolNames.filter((toolName) =>
    availableToolNames.includes(toolName),
  ),
  advertisedToolCount = availableToolNames.length,
  source = { kind: 'manual' },
  disabledReason,
}: {
  serverId: string;
  name: string;
  enabled: boolean;
  state?: McpServerView['runtime']['state'];
  advertisedToolCount?: number;
  availableToolNames?: string[];
  installedToolNames?: string[];
  activeToolNames?: string[];
  source?: McpServerView['source'];
  disabledReason?: McpServerView['runtime']['disabledReason'];
}): McpServerView {
  return {
    configVersion: 3,
    serverId,
    name,
    enabled,
    installedToolNames,
    source,
    transport: { kind: 'stdio', command: 'mcp-server', args: [], envKeys: [] },
    runtime: {
      state,
      advertisedToolCount,
      availableToolNames,
      activeToolNames,
      ...(disabledReason === undefined ? {} : { disabledReason }),
    },
  };
}

function changeField(
  renderer: ReactTestRenderer,
  placeholder: string,
  value: string,
): void {
  renderer.root
    .findByProps({ placeholder })
    .props.onChange({ currentTarget: { value } });
}

function rowWithText(
  renderer: ReactTestRenderer,
  text: string,
): ReactTestInstance {
  const row = renderer.root
    .findAllByType('article')
    .find((candidate) => renderedText(candidate).includes(text));
  assert.ok(row, `expected row containing ${text}`);
  return row;
}

function toolRowWithText(
  renderer: ReactTestRenderer,
  text: string,
): ReactTestInstance {
  const row = renderer.root
    .findAllByType('li')
    .find((candidate) => renderedText(candidate).includes(text));
  assert.ok(row, `expected tool row containing ${text}`);
  return row;
}

function buttonWithText(
  root: ReactTestRenderer | ReactTestInstance,
  text: string,
): ReactTestInstance {
  const instance = 'root' in root ? root.root : root;
  const button = instance
    .findAllByType('button')
    .find((candidate) => renderedText(candidate) === text);
  assert.ok(button, `expected button ${text}`);
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
