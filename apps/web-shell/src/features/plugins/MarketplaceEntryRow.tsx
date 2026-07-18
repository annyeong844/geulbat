import type { PluginMarketplaceEntryView } from '@geulbat/protocol/plugins';
import { useState } from 'react';

import { marketplacePluginIconUrl } from '../../lib/api/plugins.js';
import { PluginIcon } from './PluginIcon.js';

export function MarketplaceEntryRow({
  entry,
  disabled,
  onInstall,
  onManage,
  onUninstall,
}: {
  entry: PluginMarketplaceEntryView;
  disabled: boolean;
  onInstall: () => void;
  onManage?: () => void;
  onUninstall?: () => void;
}) {
  const installed = entry.installedInstallationId !== null;
  const installable = entry.status === 'installable' && !installed;
  const unavailableLabel =
    entry.status === 'not-available'
      ? '배포 정책상 설치 불가'
      : entry.status === 'unsupported-source'
        ? `${entry.sourceKind} 소스 지원 예정`
        : '패키지 확인 필요';
  return (
    <article
      className="extension-list-row"
      aria-label={`${entry.displayName} 마켓 플러그인`}
    >
      <PluginIcon
        label={entry.displayName}
        src={
          entry.iconAvailable
            ? marketplacePluginIconUrl(entry.marketplaceId, entry.entryId)
            : null
        }
        defer
      />
      <div className="extension-list-copy">
        <div className="extension-list-title">
          <strong>{entry.displayName}</strong>
        </div>
        {entry.description ? <p>{entry.description}</p> : null}
        <span className="extension-list-meta">
          {entry.capabilities.length > 0
            ? entry.capabilities
                .map(
                  (capability) =>
                    `${capabilityLabel(capability.kind)} ${capability.itemCount}개 · ${capabilitySupportLabel(capability.supportStatus)}`,
                )
                .join(' · ')
            : entry.marketplaceDisplayName}
        </span>
      </div>
      {installable ? (
        <button
          type="button"
          className="extension-install-action"
          disabled={disabled}
          onClick={onInstall}
        >
          설치
        </button>
      ) : installed ? (
        <MarketplaceEntryMenu
          label={entry.displayName}
          disabled={disabled}
          {...(onManage ? { onManage } : {})}
          {...(onUninstall ? { onUninstall } : {})}
        />
      ) : (
        <span
          className="extension-entry-unavailable"
          aria-label={unavailableLabel}
          title={unavailableLabel}
        >
          —
        </span>
      )}
    </article>
  );
}

function MarketplaceEntryMenu({
  label,
  disabled,
  onManage,
  onUninstall,
}: {
  label: string;
  disabled: boolean;
  onManage?: () => void;
  onUninstall?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const close = () => {
    setOpen(false);
    setConfirmingRemove(false);
  };

  return (
    <div className="extension-entry-menu">
      <button
        type="button"
        className="extension-entry-menu-trigger"
        aria-label={`${label} 플러그인 메뉴`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setOpen((current) => !current);
          setConfirmingRemove(false);
        }}
      >
        …
      </button>
      {open ? (
        <div className="extension-entry-menu-popover" role="menu">
          {confirmingRemove ? (
            <>
              <span>이 플러그인을 제거할까요?</span>
              <button
                type="button"
                className="danger"
                role="menuitem"
                aria-label={`${label} 플러그인 제거 확인`}
                onClick={() => {
                  close();
                  onUninstall?.();
                }}
              >
                제거
              </button>
              <button
                type="button"
                role="menuitem"
                aria-label={`${label} 플러그인 제거 취소`}
                onClick={() => setConfirmingRemove(false)}
              >
                취소
              </button>
            </>
          ) : (
            <>
              {onManage ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onManage();
                  }}
                >
                  관리
                </button>
              ) : null}
              {onUninstall ? (
                <button
                  type="button"
                  className="danger"
                  role="menuitem"
                  aria-label={`${label} 플러그인 제거`}
                  onClick={() => setConfirmingRemove(true)}
                >
                  제거
                </button>
              ) : null}
              {!onManage && !onUninstall ? (
                <span>설치된 플러그인입니다</span>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function capabilityLabel(
  kind: PluginMarketplaceEntryView['capabilities'][number]['kind'],
): string {
  switch (kind) {
    case 'skills':
      return '스킬';
    case 'mcpServers':
      return 'MCP';
    case 'apps':
      return 'App';
    case 'hooks':
      return '훅';
  }
}

function capabilitySupportLabel(
  status: PluginMarketplaceEntryView['capabilities'][number]['supportStatus'],
): string {
  switch (status) {
    case 'supported':
      return '사용 가능';
    case 'partially-supported':
      return '일부 사용 가능';
    case 'not-yet-supported':
      return '연결 준비 중';
    case 'unsupported':
      return '연결 필요';
  }
}
