import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  isPluginInstallRequest,
  type InstalledPluginView,
  type PluginCapabilityView,
  type PluginInstallRequest,
} from '@geulbat/protocol/plugins';
import { getErrorMessage } from '../../lib/error-message.js';

import {
  installPlugin,
  listPlugins,
  marketplacePluginIconUrl,
  removePlugin,
  setPluginEnabled,
} from '../../lib/api/plugins.js';
import { PluginIcon } from './PluginIcon.js';
import {
  PluginMarketplacePanel,
  type PluginMarketplaceClient,
} from './PluginMarketplacePanel.js';

export interface PluginClient {
  listPlugins: typeof listPlugins;
  installPlugin: typeof installPlugin;
  setEnabled: typeof setPluginEnabled;
  removePlugin: typeof removePlugin;
}

export type PluginPanelRequest = 'browse' | 'manage';

interface Props {
  disabled?: boolean;
  client?: PluginClient;
  marketplaceClient?: PluginMarketplaceClient;
  query?: string;
  requestedPanel?: PluginPanelRequest;
  onRequestManage?: () => void;
}

const DEFAULT_CLIENT: PluginClient = {
  listPlugins,
  installPlugin,
  setEnabled: setPluginEnabled,
  removePlugin,
};

const CAPABILITY_LABEL: Record<PluginCapabilityView['kind'], string> = {
  skills: '스킬',
  mcpServers: 'MCP 서버',
  apps: '앱',
  hooks: '훅',
};

const SUPPORT_LABEL: Record<PluginCapabilityView['supportStatus'], string> = {
  supported: '사용 가능',
  'partially-supported': '일부 사용 가능',
  'not-yet-supported': '아직 활성화되지 않음',
  unsupported: '지원되지 않음',
};

function supportLabel(capability: PluginCapabilityView): string {
  if (
    capability.kind === 'mcpServers' &&
    (capability.supportStatus === 'supported' ||
      capability.supportStatus === 'partially-supported')
  ) {
    return 'MCP 설정에서 관리';
  }
  return SUPPORT_LABEL[capability.supportStatus];
}

export function PluginSettingsPanel({
  disabled = false,
  client = DEFAULT_CLIENT,
  marketplaceClient,
  query = '',
  requestedPanel = 'browse',
  onRequestManage,
}: Props) {
  const [plugins, setPlugins] = useState<InstalledPluginView[]>([]);
  const [loadStatus, setLoadStatus] = useState<'loading' | 'loaded' | 'failed'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);
  const [sourcePath, setSourcePath] = useState('');
  const [installing, setInstalling] = useState(false);
  const [busyInstallationId, setBusyInstallationId] = useState<string | null>(
    null,
  );
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [marketplaceRefreshToken, setMarketplaceRefreshToken] = useState(0);
  const [activeDisclosure, setActiveDisclosure] = useState<'manage' | null>(
    requestedPanel === 'manage' ? 'manage' : null,
  );
  const installedManagementRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    let active = true;
    setLoadStatus('loading');
    setError(null);
    void client
      .listPlugins()
      .then((response) => {
        if (active) {
          setPlugins(response.plugins);
          setLoadStatus('loaded');
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            `플러그인 목록을 불러오지 못했습니다. ${getErrorMessage(loadError)}`,
          );
          setLoadStatus('failed');
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    setActiveDisclosure(requestedPanel === 'manage' ? 'manage' : null);
  }, [requestedPanel]);

  useEffect(() => {
    const disclosure =
      activeDisclosure === 'manage' ? installedManagementRef.current : null;
    if (!disclosure) {
      return;
    }
    disclosure.scrollIntoView({ block: 'nearest' });
    disclosure.querySelector('summary')?.focus();
  }, [activeDisclosure]);

  const replacePlugin = (plugin: InstalledPluginView) => {
    setPlugins((current) => {
      const existingIndex = current.findIndex(
        (candidate) => candidate.installationId === plugin.installationId,
      );
      if (existingIndex === -1) {
        return [...current, plugin];
      }
      return current.map((candidate) =>
        candidate.installationId === plugin.installationId ? plugin : candidate,
      );
    });
  };

  const handleInstall = async (request: PluginInstallRequest) => {
    setError(null);
    setInstalling(true);
    try {
      const response = await client.installPlugin(request);
      replacePlugin(response.plugin);
      setMarketplaceRefreshToken((current) => current + 1);
      setSourcePath('');
    } catch (installError: unknown) {
      setError(
        `플러그인을 설치하지 못했습니다. ${getErrorMessage(installError)}`,
      );
    } finally {
      setInstalling(false);
    }
  };

  const handleEnabledChange = async (plugin: InstalledPluginView) => {
    setError(null);
    setBusyInstallationId(plugin.installationId);
    try {
      const response = await client.setEnabled(
        plugin.installationId,
        !plugin.enabled,
      );
      replacePlugin(response.plugin);
    } catch (updateError: unknown) {
      setError(
        `플러그인 상태를 바꾸지 못했습니다. ${getErrorMessage(updateError)}`,
      );
    } finally {
      setBusyInstallationId(null);
    }
  };

  const handleRemove = async (installationId: string) => {
    setError(null);
    setBusyInstallationId(installationId);
    try {
      await client.removePlugin(installationId);
      setPlugins((current) =>
        current.filter((plugin) => plugin.installationId !== installationId),
      );
      setMarketplaceRefreshToken((current) => current + 1);
      setConfirmRemoveId(null);
    } catch (removeError: unknown) {
      setError(
        `플러그인을 제거하지 못했습니다. ${getErrorMessage(removeError)}`,
      );
    } finally {
      setBusyInstallationId(null);
    }
  };

  const submitInstall = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const path = sourcePath.trim();
    if (!path || installing || loadStatus !== 'loaded' || disabled) {
      return;
    }
    const request = { root: 'computer', path } satisfies PluginInstallRequest;
    if (!isPluginInstallRequest(request)) {
      setError(
        '컴퓨터 파일 루트 기준 상대경로를 입력하세요. 절대 경로와 상위 폴더 이동은 사용할 수 없습니다.',
      );
      return;
    }
    await handleInstall(request);
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visiblePlugins = plugins.filter((plugin) =>
    normalizedQuery
      ? [plugin.displayName, plugin.name, plugin.description].some((value) =>
          value.toLocaleLowerCase().includes(normalizedQuery),
        )
      : true,
  );

  const handleMarketplaceInstalled = (plugin: InstalledPluginView) => {
    replacePlugin(plugin);
    setMarketplaceRefreshToken((current) => current + 1);
  };

  const handleMarketplaceUninstalled = (installationId: string) => {
    setPlugins((current) =>
      current.filter((plugin) => plugin.installationId !== installationId),
    );
    setMarketplaceRefreshToken((current) => current + 1);
  };

  const openInstalledManagement = () => {
    setActiveDisclosure('manage');
    onRequestManage?.();
  };

  return (
    <section className="extension-plugin-page" aria-label="플러그인 목록">
      <section
        className="extension-installed-section"
        aria-labelledby="installed-plugin-title"
      >
        <header className="extension-section-heading">
          <div>
            <h2 id="installed-plugin-title">설치됨</h2>
          </div>
          <button
            type="button"
            className="extension-installed-settings-action"
            aria-label={`설치된 플러그인 관리 열기 · ${plugins.length}개`}
            disabled={plugins.length === 0}
            onClick={openInstalledManagement}
          >
            ⚙
          </button>
        </header>

        {error ? (
          <div className="settings-alert" role="alert">
            {error}
          </div>
        ) : null}

        {loadStatus === 'loading' ? (
          <p className="settings-empty" role="status">
            플러그인 목록을 불러오는 중…
          </p>
        ) : loadStatus === 'loaded' && plugins.length === 0 ? (
          <p className="settings-empty">설치된 플러그인이 없습니다</p>
        ) : loadStatus === 'loaded' && visiblePlugins.length === 0 ? (
          <p className="settings-empty">검색과 일치하는 플러그인이 없습니다</p>
        ) : loadStatus === 'loaded' ? (
          <ExtensionInstalledStrip plugins={visiblePlugins} />
        ) : null}

        {loadStatus === 'loaded' && visiblePlugins.length > 0 ? (
          <details
            ref={installedManagementRef}
            className="settings-disclosure extension-installed-management"
            open={activeDisclosure === 'manage'}
            onToggle={(event) => {
              if (!event.currentTarget.open) {
                setActiveDisclosure((current) =>
                  current === 'manage' ? null : current,
                );
              }
            }}
          >
            <summary>설치된 플러그인 관리</summary>
            <div className="settings-item-list extension-installed-grid">
              {visiblePlugins.map((plugin) => (
                <PluginRow
                  key={plugin.installationId}
                  plugin={plugin}
                  disabled={
                    disabled || installing || busyInstallationId !== null
                  }
                  confirmingRemove={confirmRemoveId === plugin.installationId}
                  onToggle={() => void handleEnabledChange(plugin)}
                  onRequestRemove={() =>
                    setConfirmRemoveId(plugin.installationId)
                  }
                  onCancelRemove={() => setConfirmRemoveId(null)}
                  onConfirmRemove={() =>
                    void handleRemove(plugin.installationId)
                  }
                />
              ))}
            </div>
          </details>
        ) : null}

        {requestedPanel === 'manage' ? (
          <details className="settings-disclosure extension-direct-install">
            <summary>컴퓨터 폴더에서 설치</summary>
            <form
              className="settings-install-form"
              onSubmit={(event) => void submitInstall(event)}
            >
              <label htmlFor="plugin-source-path">
                컴퓨터 파일 루트 기준 플러그인 폴더 경로
              </label>
              <div>
                <input
                  id="plugin-source-path"
                  value={sourcePath}
                  required
                  disabled={disabled || installing || loadStatus !== 'loaded'}
                  placeholder="예: plugins/my-plugin"
                  onChange={(event) => setSourcePath(event.currentTarget.value)}
                />
                <button
                  type="submit"
                  className="settings-primary-action"
                  aria-label="플러그인 설치"
                  disabled={
                    disabled ||
                    installing ||
                    loadStatus !== 'loaded' ||
                    !sourcePath.trim()
                  }
                >
                  {installing ? '설치 중…' : '설치'}
                </button>
              </div>
              <p>
                절대 경로를 저장하거나 전송하지 않습니다. 왼쪽 컴퓨터 파일
                영역의 루트를 기준으로 상대경로를 입력하세요.
              </p>
            </form>
          </details>
        ) : null}
      </section>

      {requestedPanel === 'browse' ? (
        <PluginMarketplacePanel
          disabled={disabled}
          query={query}
          showManagement={false}
          refreshToken={marketplaceRefreshToken}
          onInstalled={handleMarketplaceInstalled}
          onUninstalled={handleMarketplaceUninstalled}
          onManageInstalled={openInstalledManagement}
          {...(marketplaceClient ? { client: marketplaceClient } : {})}
        />
      ) : null}
    </section>
  );
}

function ExtensionInstalledStrip({
  plugins,
}: {
  plugins: InstalledPluginView[];
}) {
  return (
    <div className="extension-installed-strip" aria-label="설치된 플러그인">
      {plugins.map((plugin) => {
        const label = plugin.displayName || plugin.name;
        const marketplaceSource = plugin.marketplaceSource;
        return (
          <span
            key={plugin.installationId}
            className="extension-installed-item"
            aria-label={`${label} · ${plugin.enabled ? '사용 중' : '사용 중지'}`}
            data-tooltip={label}
            tabIndex={0}
          >
            <PluginIcon
              label={label}
              src={
                marketplaceSource
                  ? marketplacePluginIconUrl(
                      marketplaceSource.marketplaceId,
                      marketplaceSource.entryId,
                    )
                  : null
              }
            />
          </span>
        );
      })}
    </div>
  );
}

function PluginRow({
  plugin,
  disabled,
  confirmingRemove,
  onToggle,
  onRequestRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  plugin: InstalledPluginView;
  disabled: boolean;
  confirmingRemove: boolean;
  onToggle: () => void;
  onRequestRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}) {
  const label = plugin.displayName || plugin.name;
  const hasSupportedSkills = plugin.capabilities.some(
    (capability) =>
      capability.kind === 'skills' && capability.supportStatus === 'supported',
  );
  const hasManagedMcpServers = plugin.capabilities.some(
    (capability) =>
      capability.kind === 'mcpServers' &&
      (capability.supportStatus === 'supported' ||
        capability.supportStatus === 'partially-supported'),
  );
  const mcpServerCount =
    plugin.capabilities.find((capability) => capability.kind === 'mcpServers')
      ?.itemCount ?? 0;
  const hasActiveCapability = hasSupportedSkills || hasManagedMcpServers;
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingRemove = useRef(confirmingRemove);
  const removeConfirmationId = `plugin-remove-${plugin.installationId}`;

  useEffect(() => {
    if (wasConfirmingRemove.current && !confirmingRemove) {
      removeTriggerRef.current?.focus();
    }
    wasConfirmingRemove.current = confirmingRemove;
  }, [confirmingRemove]);

  return (
    <article className="settings-item-row" aria-label={`${label} 플러그인`}>
      <div className="settings-item-heading">
        <strong title={label}>{label}</strong>
        <span
          className={`settings-item-state ${plugin.enabled && hasActiveCapability ? 'enabled' : 'disabled'}`}
        >
          {plugin.enabled
            ? hasActiveCapability
              ? '패키지 사용 설정됨'
              : '활성 기능 없음'
            : '사용 중지'}
        </span>
      </div>
      <p className="settings-item-meta">
        {plugin.name} · {plugin.version}
      </p>
      {plugin.description ? (
        <p className="settings-item-description">{plugin.description}</p>
      ) : null}
      <p className="settings-item-note">
        지원되는 스킬은 글밭이 검색하고 안내문·자료를 읽을 수 있습니다. 지원되는
        MCP 서버는 MCP 설정에서 개별로 관리합니다. 플러그인을 사용 중지해도
        서버별 켜기/끄기 설정은 유지됩니다. 앱·훅은 아직 실행하지 않습니다.
      </p>
      {plugin.capabilities.length === 0 ? (
        <p className="settings-item-meta">선언된 구성 요소 없음</p>
      ) : (
        <ul
          className="settings-capability-list"
          aria-label={`${label} 구성 요소`}
        >
          {plugin.capabilities.map((capability) => (
            <li key={capability.kind}>
              <span>
                {CAPABILITY_LABEL[capability.kind]} {capability.itemCount}개
              </span>
              <strong>{supportLabel(capability)}</strong>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-row-actions">
        <button
          type="button"
          aria-label={`${label} 플러그인 ${plugin.enabled ? '사용 중지' : '사용'}`}
          disabled={disabled || confirmingRemove}
          onClick={onToggle}
        >
          {plugin.enabled ? '사용 중지' : '사용'}
        </button>
        <button
          ref={removeTriggerRef}
          type="button"
          aria-label={`${label} 플러그인 ${confirmingRemove ? '제거 확인 닫기' : '제거'}`}
          aria-expanded={confirmingRemove}
          aria-controls={removeConfirmationId}
          disabled={disabled}
          onClick={confirmingRemove ? onCancelRemove : onRequestRemove}
        >
          {confirmingRemove ? '제거 확인 닫기' : '제거'}
        </button>
      </div>
      {confirmingRemove ? (
        <div
          id={removeConfirmationId}
          className="settings-row-actions"
          role="group"
          aria-label={`${label} 플러그인 제거 확인`}
        >
          <span>
            {mcpServerCount > 0
              ? `관리 저장소와 MCP 서버 ${mcpServerCount}개를 함께 제거할까요?`
              : '관리 저장소에서도 제거할까요?'}
          </span>
          <button
            type="button"
            aria-label={`${label} 플러그인 관리 저장소에서 제거`}
            disabled={disabled}
            onClick={onConfirmRemove}
          >
            제거
          </button>
          <button
            type="button"
            aria-label={`${label} 플러그인 제거 취소`}
            disabled={disabled}
            onClick={onCancelRemove}
          >
            취소
          </button>
        </div>
      ) : null}
    </article>
  );
}
