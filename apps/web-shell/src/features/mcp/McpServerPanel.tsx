import { useEffect, useState, type FormEvent } from 'react';
import type {
  McpServerCreateRequest,
  McpServerView,
} from '@geulbat/protocol/mcp';
import { getErrorMessage } from '../../lib/error-message.js';

import {
  addMcpServer,
  installMcpServerTool,
  listMcpServers,
  removeMcpServer,
  setMcpServerEnabled,
  uninstallMcpServerTool,
} from '../../lib/api/mcp.js';

export interface McpServerClient {
  listServers: typeof listMcpServers;
  addServer: typeof addMcpServer;
  setEnabled: typeof setMcpServerEnabled;
  installTool: typeof installMcpServerTool;
  uninstallTool: typeof uninstallMcpServerTool;
  removeServer: typeof removeMcpServer;
}

interface Props {
  disabled?: boolean;
  client?: McpServerClient;
}

const DEFAULT_CLIENT: McpServerClient = {
  listServers: listMcpServers,
  addServer: addMcpServer,
  setEnabled: setMcpServerEnabled,
  installTool: installMcpServerTool,
  uninstallTool: uninstallMcpServerTool,
  removeServer: removeMcpServer,
};

const CONNECTION_LABEL: Record<McpServerView['runtime']['state'], string> = {
  disabled: '꺼짐',
  connecting: '연결 중',
  ready: '연결됨',
  error: '오류',
};

export function McpServerPanel({
  disabled = false,
  client = DEFAULT_CLIENT,
}: Props) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void client
      .listServers()
      .then((response) => {
        if (active) {
          setServers(response.servers);
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            `MCP 목록을 불러오지 못했습니다. ${getErrorMessage(loadError)}`,
          );
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  const replaceServer = (server: McpServerView) => {
    setServers((current) => {
      const index = current.findIndex(
        (candidate) => candidate.serverId === server.serverId,
      );
      if (index === -1) {
        return [...current, server];
      }
      return current.map((candidate) =>
        candidate.serverId === server.serverId ? server : candidate,
      );
    });
  };

  const handleCreate = async (request: McpServerCreateRequest) => {
    setError(null);
    try {
      const response = await client.addServer(request);
      replaceServer(response.server);
      setShowCreate(false);
    } catch (createError: unknown) {
      setError(
        `MCP 서버를 추가하지 못했습니다. ${getErrorMessage(createError)}`,
      );
    }
  };

  const handleEnabledChange = async (server: McpServerView) => {
    setError(null);
    setBusyServerId(server.serverId);
    try {
      const response = await client.setEnabled(
        server.serverId,
        !server.enabled,
      );
      replaceServer(response.server);
    } catch (updateError: unknown) {
      setError(`MCP 상태를 바꾸지 못했습니다. ${getErrorMessage(updateError)}`);
    } finally {
      setBusyServerId(null);
    }
  };

  const handleToolInstallationChange = async (
    server: McpServerView,
    toolName: string,
    installed: boolean,
  ) => {
    setError(null);
    setBusyServerId(server.serverId);
    try {
      const response = installed
        ? await client.installTool(server.serverId, toolName)
        : await client.uninstallTool(server.serverId, toolName);
      replaceServer(response.server);
    } catch (updateError: unknown) {
      setError(
        `MCP 도구 스키마를 ${installed ? '설치' : '제거'}하지 못했습니다. ${getErrorMessage(updateError)}`,
      );
    } finally {
      setBusyServerId(null);
    }
  };

  const handleRemove = async (serverId: string) => {
    setError(null);
    setBusyServerId(serverId);
    try {
      await client.removeServer(serverId);
      setServers((current) =>
        current.filter((server) => server.serverId !== serverId),
      );
      setConfirmRemoveId(null);
    } catch (removeError: unknown) {
      setError(
        `MCP 서버를 제거하지 못했습니다. ${getErrorMessage(removeError)}`,
      );
    } finally {
      setBusyServerId(null);
    }
  };

  return (
    <section className="mcp-panel" aria-labelledby="mcp-settings-title">
      <header className="settings-page-heading">
        <div>
          <span className="settings-eyebrow">확장 도구</span>
          <h2 id="mcp-settings-title">MCP 서버</h2>
          <p>글밭 홈에서 사용할 도구 서버와 연결 상태를 관리합니다.</p>
        </div>
        <button
          type="button"
          className="settings-primary-action"
          aria-label={showCreate ? 'MCP 추가 취소' : 'MCP 서버 추가'}
          title={showCreate ? '추가 취소' : 'MCP 서버 추가'}
          disabled={disabled}
          onClick={() => {
            setError(null);
            setShowCreate((visible) => !visible);
          }}
        >
          {showCreate ? '추가 취소' : '+ 서버 추가'}
        </button>
      </header>

      {showCreate ? (
        <McpServerCreateForm
          disabled={disabled}
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      ) : null}

      {error ? (
        <div className="settings-alert" role="alert">
          {error}
        </div>
      ) : null}

      <div className="mcp-server-list">
        {loading ? (
          <p className="mcp-empty">MCP 목록을 불러오는 중…</p>
        ) : servers.length === 0 ? (
          <p className="mcp-empty">연결된 MCP 서버가 없습니다</p>
        ) : (
          servers.map((server) => (
            <McpServerRow
              key={server.serverId}
              server={server}
              disabled={disabled || busyServerId !== null}
              confirmingRemove={confirmRemoveId === server.serverId}
              onToggle={() => void handleEnabledChange(server)}
              onInstallTool={(toolName) =>
                void handleToolInstallationChange(server, toolName, true)
              }
              onUninstallTool={(toolName) =>
                void handleToolInstallationChange(server, toolName, false)
              }
              onRequestRemove={() => setConfirmRemoveId(server.serverId)}
              onCancelRemove={() => setConfirmRemoveId(null)}
              onConfirmRemove={() => void handleRemove(server.serverId)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function McpServerCreateForm({
  disabled,
  onSubmit,
  onCancel,
}: {
  disabled: boolean;
  onSubmit: (request: McpServerCreateRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [envKeys, setEnvKeys] = useState('');
  const [connectionTimeoutMs, setConnectionTimeoutMs] = useState('');
  const [requestTimeoutMs, setRequestTimeoutMs] = useState('');
  const [shutdownGraceMs, setShutdownGraceMs] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    const parsedConnectionTimeoutMs = parseOptionalTimeout(connectionTimeoutMs);
    const parsedRequestTimeoutMs = parseOptionalTimeout(requestTimeoutMs);
    const parsedShutdownGraceMs = parseOptionalTimeout(shutdownGraceMs);
    if (
      !trimmedName ||
      !trimmedCommand ||
      submitting ||
      parsedConnectionTimeoutMs === null ||
      parsedRequestTimeoutMs === null ||
      parsedShutdownGraceMs === null
    ) {
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        name: trimmedName,
        enabled,
        transport: {
          kind: 'stdio',
          command: trimmedCommand,
          args: splitLines(args),
          envKeys: splitLines(envKeys).map((key) => key.trim()),
          ...(parsedConnectionTimeoutMs === undefined
            ? {}
            : { connectionTimeoutMs: parsedConnectionTimeoutMs }),
          ...(parsedRequestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: parsedRequestTimeoutMs }),
          ...(parsedShutdownGraceMs === undefined
            ? {}
            : { shutdownGraceMs: parsedShutdownGraceMs }),
        },
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="mcp-create-form" onSubmit={(event) => void submit(event)}>
      <label>
        <span>이름</span>
        <input
          value={name}
          required
          disabled={disabled || submitting}
          placeholder="예: 파일 도구"
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>실행 명령</span>
        <input
          value={command}
          required
          disabled={disabled || submitting}
          placeholder="예: npx"
          onChange={(event) => setCommand(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>인수 · 한 줄에 하나</span>
        <textarea
          value={args}
          disabled={disabled || submitting}
          rows={3}
          placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
          onChange={(event) => setArgs(event.currentTarget.value)}
        />
      </label>
      <label>
        <span>환경변수 이름 · 값은 저장하지 않음</span>
        <textarea
          value={envKeys}
          disabled={disabled || submitting}
          rows={2}
          placeholder="API_KEY"
          onChange={(event) => setEnvKeys(event.currentTarget.value)}
        />
      </label>
      <details className="mcp-advanced">
        <summary>연결 및 종료 시간 설정</summary>
        <label>
          <span>연결 제한시간 · 밀리초</span>
          <input
            type="number"
            min="1"
            step="1"
            value={connectionTimeoutMs}
            disabled={disabled || submitting}
            placeholder="SDK 기본값"
            onChange={(event) =>
              setConnectionTimeoutMs(event.currentTarget.value)
            }
          />
        </label>
        <label>
          <span>도구 요청 제한시간 · 밀리초</span>
          <input
            type="number"
            min="1"
            step="1"
            value={requestTimeoutMs}
            disabled={disabled || submitting}
            placeholder="SDK 요청 기본값"
            onChange={(event) => setRequestTimeoutMs(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>종료 단계 대기시간 · 밀리초</span>
          <input
            type="number"
            min="1"
            step="1"
            value={shutdownGraceMs}
            disabled={disabled || submitting}
            placeholder="기본 2000ms"
            onChange={(event) => setShutdownGraceMs(event.currentTarget.value)}
          />
        </label>
      </details>
      <label className="mcp-enabled-field">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled || submitting}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
        />
        <span>추가한 뒤 바로 연결</span>
      </label>
      <div className="mcp-form-actions">
        <button
          type="submit"
          disabled={disabled || submitting || !name.trim() || !command.trim()}
        >
          {submitting ? '추가 중…' : '추가'}
        </button>
        <button type="button" disabled={submitting} onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}

function McpServerRow({
  server,
  disabled,
  confirmingRemove,
  onToggle,
  onInstallTool,
  onUninstallTool,
  onRequestRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  server: McpServerView;
  disabled: boolean;
  confirmingRemove: boolean;
  onToggle: () => void;
  onInstallTool: (toolName: string) => void;
  onUninstallTool: (toolName: string) => void;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}) {
  const [showTools, setShowTools] = useState(false);
  const [toolQuery, setToolQuery] = useState('');
  const pluginSource =
    server.source.kind === 'plugin' ? server.source : undefined;
  const pluginDisabled = server.runtime.disabledReason === 'plugin-disabled';
  const availableToolNames = new Set(server.runtime.availableToolNames);
  const installedToolNames = new Set(server.installedToolNames);
  const activeToolNames = new Set(server.runtime.activeToolNames);
  const normalizedToolQuery = toolQuery.trim().toLocaleLowerCase();
  const visibleToolNames = [
    ...new Set([
      ...server.runtime.availableToolNames,
      ...server.installedToolNames,
    ]),
  ]
    .sort((left, right) => left.localeCompare(right))
    .filter(
      (toolName) =>
        normalizedToolQuery.length === 0 ||
        toolName.toLocaleLowerCase().includes(normalizedToolQuery),
    );
  const hiddenToolCount =
    server.runtime.advertisedToolCount -
    server.runtime.availableToolNames.length;
  const inactiveInstalledToolCount =
    server.installedToolNames.length - server.runtime.activeToolNames.length;

  return (
    <article className="mcp-server-row">
      <div className="mcp-server-heading">
        <strong title={server.name}>{server.name}</strong>
        <span className={`mcp-state ${server.runtime.state}`}>
          {pluginDisabled
            ? '플러그인 사용 중지'
            : CONNECTION_LABEL[server.runtime.state]}
        </span>
      </div>
      {pluginSource ? (
        <div className="mcp-server-meta">
          플러그인 제공 · {pluginSource.displayName || pluginSource.name}{' '}
          {pluginSource.version} · {pluginSource.serverName}
        </div>
      ) : null}
      <div className="mcp-server-meta">
        {server.runtime.state === 'ready'
          ? `서버 제공 ${server.runtime.advertisedToolCount}개 · 설치 가능 ${server.runtime.availableToolNames.length}개 · 설치됨 ${server.installedToolNames.length}개`
          : `설치됨 ${server.installedToolNames.length}개 · 현재 활성 ${server.runtime.activeToolNames.length}개`}
        {server.runtime.state === 'ready' && hiddenToolCount > 0
          ? ` · 모델 비노출 ${hiddenToolCount}개`
          : ''}
        {inactiveInstalledToolCount > 0
          ? ` · 현재 비활성 ${inactiveInstalledToolCount}개`
          : ''}
      </div>
      {pluginDisabled ? (
        <div className="mcp-server-meta">
          플러그인을 다시 사용하면 이 서버의 현재 켜기/끄기 설정을 따릅니다.
        </div>
      ) : null}
      {server.runtime.error ? (
        <div className="mcp-server-error" role="alert">
          {server.runtime.error}
        </div>
      ) : null}
      {availableToolNames.size > 0 || installedToolNames.size > 0 ? (
        <div className="mcp-tool-manager">
          <button
            type="button"
            className="mcp-tool-toggle"
            aria-expanded={showTools}
            onClick={() => setShowTools((visible) => !visible)}
          >
            {showTools ? '도구 관리 닫기' : '도구 관리'}
          </button>
          {showTools ? (
            <div className="mcp-tool-browser">
              <p>
                표준 MCP 서버는 목록 갱신 때 전체 도구 정의를 잠깐 보낼 수
                있습니다. 글밭은 이름 목록과 설치한 실행 스키마만 유지합니다.
              </p>
              <input
                type="search"
                aria-label={`${server.name} MCP 도구 검색`}
                placeholder="도구 이름 검색"
                value={toolQuery}
                onChange={(event) => setToolQuery(event.currentTarget.value)}
              />
              <ul className="mcp-tool-list">
                {visibleToolNames.map((toolName) => {
                  const available = availableToolNames.has(toolName);
                  const installed = installedToolNames.has(toolName);
                  const active = activeToolNames.has(toolName);
                  let statusLabel = '설치 가능';
                  if (active) {
                    statusLabel = '설치됨 · 활성';
                  } else if (installed && available) {
                    statusLabel = '설치됨 · 현재 비활성';
                  } else if (installed) {
                    statusLabel = '설치됨 · 서버에서 찾을 수 없음';
                  }
                  return (
                    <li key={toolName}>
                      <span>
                        <strong title={toolName}>{toolName}</strong>
                        <small>{statusLabel}</small>
                      </span>
                      <button
                        type="button"
                        disabled={disabled || (!available && !installed)}
                        onClick={() =>
                          installed
                            ? onUninstallTool(toolName)
                            : onInstallTool(toolName)
                        }
                      >
                        {installed ? '스키마 제거' : '스키마 설치'}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {visibleToolNames.length === 0 ? (
                <p className="mcp-tool-empty">검색 결과가 없습니다</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {pluginSource ? (
        <>
          <div className="mcp-server-meta">
            이 서버는 플러그인을 제거하면 함께 삭제됩니다.
          </div>
          <div className="mcp-row-actions">
            <button type="button" disabled={disabled} onClick={onToggle}>
              {server.enabled ? '끄기' : '켜기'}
            </button>
          </div>
        </>
      ) : confirmingRemove ? (
        <div className="mcp-row-actions" role="alertdialog">
          <span>제거할까요?</span>
          <button type="button" disabled={disabled} onClick={onConfirmRemove}>
            제거
          </button>
          <button type="button" disabled={disabled} onClick={onCancelRemove}>
            취소
          </button>
        </div>
      ) : (
        <div className="mcp-row-actions">
          <button type="button" disabled={disabled} onClick={onToggle}>
            {server.enabled ? '끄기' : '켜기'}
          </button>
          <button type="button" disabled={disabled} onClick={onRequestRemove}>
            제거
          </button>
        </div>
      )}
    </article>
  );
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseOptionalTimeout(value: string): number | undefined | null {
  if (value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
