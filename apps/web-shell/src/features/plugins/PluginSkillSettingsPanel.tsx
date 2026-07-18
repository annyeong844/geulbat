import { useEffect, useState } from 'react';
import type {
  InstalledPluginView,
  PluginSkillListResponse,
  PluginSkillView,
} from '@geulbat/protocol/plugins';
import { getErrorMessage } from '@geulbat/shared-utils/error';

import { listPluginSkills } from '../../lib/api/plugins.js';
import { PluginIcon } from './PluginIcon.js';
import {
  PluginMarketplacePanel,
  type PluginMarketplaceClient,
} from './PluginMarketplacePanel.js';

export interface PluginSkillClient {
  listSkills: typeof listPluginSkills;
}

interface Props {
  disabled?: boolean;
  client?: PluginSkillClient;
  marketplaceClient?: PluginMarketplaceClient;
  query?: string;
}

const DEFAULT_CLIENT: PluginSkillClient = {
  listSkills: listPluginSkills,
};

export function PluginSkillSettingsPanel({
  disabled = false,
  client = DEFAULT_CLIENT,
  marketplaceClient,
  query = '',
}: Props) {
  const [inventory, setInventory] = useState<PluginSkillListResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let active = true;
    setInventory(null);
    setError(null);
    void client
      .listSkills()
      .then((response) => {
        if (active) {
          setInventory(response);
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            `스킬 목록을 불러오지 못했습니다. ${getErrorMessage(loadError)}`,
          );
        }
      });
    return () => {
      active = false;
    };
  }, [client, refreshToken]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSkills =
    inventory?.skills.filter((skill) =>
      normalizedQuery
        ? [
            skill.name,
            skill.description,
            skill.pluginName,
            skill.pluginDisplayName,
          ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
        : true,
    ) ?? [];

  const handleInstalled = (_plugin: InstalledPluginView) => {
    setRefreshToken((current) => current + 1);
  };

  const handleUninstalled = (_installationId: string) => {
    setRefreshToken((current) => current + 1);
  };

  return (
    <section className="extension-skill-page" aria-label="스킬 목록">
      <section
        className="extension-installed-section"
        aria-labelledby="installed-skill-title"
      >
        <header className="extension-section-heading">
          <div>
            <h2 id="installed-skill-title">설치됨</h2>
            <p>
              설치된 플러그인의 스킬만 필요할 때 읽고, 포함된 스크립트는
              자동으로 실행하지 않습니다.
            </p>
          </div>
          <span className="extension-count">
            {inventory?.skills.length ?? 0}
          </span>
        </header>

        {disabled ? (
          <div className="settings-alert" role="status">
            데몬에 다시 연결하면 설치된 스킬 상태를 새로 확인할 수 있습니다.
          </div>
        ) : null}

        {error ? (
          <div className="settings-alert" role="alert">
            {error}
          </div>
        ) : null}

        {inventory?.diagnostics.map((diagnostic) => (
          <div
            key={diagnostic.pluginInstallationId}
            className="settings-alert"
            role="alert"
          >
            {diagnostic.pluginName} 플러그인: {diagnostic.message}
          </div>
        ))}

        <div className="settings-item-list extension-installed-grid">
          {!inventory && !error ? (
            <p className="settings-empty" role="status">
              스킬 목록을 불러오는 중…
            </p>
          ) : inventory && inventory.skills.length === 0 ? (
            <p className="settings-empty">설치된 스킬이 없습니다</p>
          ) : inventory && visibleSkills.length === 0 ? (
            <p className="settings-empty">검색과 일치하는 스킬이 없습니다</p>
          ) : inventory ? (
            visibleSkills.map((skill) => (
              <PluginSkillRow key={skill.skillRef} skill={skill} />
            ))
          ) : null}
        </div>
      </section>

      <PluginMarketplacePanel
        disabled={disabled}
        query={query}
        capabilityFilter="skills"
        showManagement={false}
        refreshToken={refreshToken}
        onInstalled={handleInstalled}
        onUninstalled={handleUninstalled}
        {...(marketplaceClient ? { client: marketplaceClient } : {})}
      />
    </section>
  );
}

function PluginSkillRow({ skill }: { skill: PluginSkillView }) {
  const pluginLabel = skill.pluginDisplayName || skill.pluginName;
  const state = skillState(skill);

  return (
    <article
      className="extension-list-row extension-skill-row"
      aria-label={`${skill.name} 스킬`}
    >
      <PluginIcon label={skill.name} size="small" />
      <div className="extension-list-copy">
        <div className="extension-list-title">
          <strong title={skill.name}>{skill.name}</strong>
          <span
            className={`settings-item-state ${state.available ? 'enabled' : 'disabled'}`}
          >
            {state.label}
          </span>
        </div>
        <p>{skill.description}</p>
        <span className="extension-list-meta">
          {pluginLabel} · {skill.pluginVersion}
        </span>
      </div>
      <div className="extension-skill-policy">
        <span>
          {skill.allowImplicitInvocation
            ? '대화 문맥에서 선택 가능'
            : '직접 요청할 때만'}
        </span>
      </div>
    </article>
  );
}

function skillState(skill: PluginSkillView): {
  available: boolean;
  label: string;
} {
  if (!skill.enabled) {
    return { available: false, label: '플러그인 사용 중지' };
  }
  if (skill.runtimeStatus === 'unavailable-tool-dependencies') {
    return { available: false, label: '필요한 도구 없음' };
  }
  return { available: true, label: '사용 가능' };
}
