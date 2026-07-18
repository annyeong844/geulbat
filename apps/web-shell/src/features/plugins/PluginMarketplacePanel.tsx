import type {
  InstalledPluginView,
  PluginMarketplaceAddRequest,
  PluginMarketplaceEntryView,
  PluginMarketplaceInstallRequest,
  PluginMarketplaceListResponse,
} from '@geulbat/protocol/plugins';
import { getErrorMessage } from '@geulbat/shared-utils/error';
import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';

import {
  addPluginMarketplace,
  ensureOfficialPluginMarketplace,
  installMarketplacePlugin,
  listPluginMarketplaces,
  removePlugin,
  removePluginMarketplace,
} from '../../lib/api/plugins.js';
import {
  filterVisibleMarketplaceEntries,
  groupMarketplaceEntries,
  selectFeaturedMarketplaceEntries,
} from './marketplace-entry-grouping.js';
import { MarketplaceEntryRow } from './MarketplaceEntryRow.js';
import { SectionMoreButton } from './SectionMoreButton.js';

export interface PluginMarketplaceClient {
  list(): Promise<PluginMarketplaceListResponse>;
  ensureOfficial(): ReturnType<typeof ensureOfficialPluginMarketplace>;
  add(
    request: PluginMarketplaceAddRequest,
  ): ReturnType<typeof addPluginMarketplace>;
  install(
    request: PluginMarketplaceInstallRequest,
  ): ReturnType<typeof installMarketplacePlugin>;
  uninstall?: typeof removePlugin;
  remove(marketplaceId: string): ReturnType<typeof removePluginMarketplace>;
}

interface Props {
  disabled?: boolean;
  client?: PluginMarketplaceClient;
  query?: string;
  capabilityFilter?: 'all' | 'skills';
  showManagement?: boolean;
  refreshToken?: number;
  onInstalled: (plugin: InstalledPluginView) => void;
  onUninstalled?: (installationId: string) => void;
  onManageInstalled?: (installationId: string) => void;
}

const DEFAULT_CLIENT: PluginMarketplaceClient = {
  list: listPluginMarketplaces,
  ensureOfficial: ensureOfficialPluginMarketplace,
  add: addPluginMarketplace,
  install: installMarketplacePlugin,
  uninstall: removePlugin,
  remove: removePluginMarketplace,
};

const EMPTY_CATALOG: PluginMarketplaceListResponse = {
  sources: [],
  entries: [],
  diagnostics: [],
};

const SECTION_PREVIEW_ENTRY_COUNT = 6;
const FEATURED_SECTION_KEY = 'featured';

export function PluginMarketplacePanel({
  disabled = false,
  client = DEFAULT_CLIENT,
  query = '',
  capabilityFilter = 'all',
  showManagement = true,
  refreshToken = 0,
  onInstalled,
  onUninstalled,
  onManageInstalled,
}: Props) {
  const [catalog, setCatalog] =
    useState<PluginMarketplaceListResponse>(EMPTY_CATALOG);
  const [loadStatus, setLoadStatus] = useState<'loading' | 'loaded' | 'failed'>(
    'loading',
  );
  const [officialStatus, setOfficialStatus] = useState<
    'idle' | 'connecting' | 'connected' | 'failed'
  >('idle');
  const [sourceFilter, setSourceFilter] = useState<'official' | 'custom'>(
    'official',
  );
  const [error, setError] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceRef, setSourceRef] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<readonly string[]>(
    [],
  );
  const [filterOpen, setFilterOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadStatus('loading');
    setError(null);
    void client
      .list()
      .then(async (listed) => {
        if (!active) {
          return;
        }
        setCatalog(listed);
        setLoadStatus('loaded');
        if (listed.sources.some((source) => source.sourceRole === 'official')) {
          setOfficialStatus('connected');
          return;
        }
        if (disabled) {
          setOfficialStatus('idle');
          return;
        }
        setOfficialStatus('connecting');
        try {
          await client.ensureOfficial();
          const connected = await client.list();
          if (active) {
            setCatalog(connected);
            setOfficialStatus('connected');
          }
        } catch (connectError: unknown) {
          if (active) {
            setOfficialStatus('failed');
            setError(
              `Codex 공식 marketplace에 연결하지 못했습니다. ${getErrorMessage(connectError)}`,
            );
          }
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            `플러그인 marketplace를 불러오지 못했습니다. ${getErrorMessage(loadError)}`,
          );
          setLoadStatus('failed');
        }
      });
    return () => {
      active = false;
    };
  }, [client, disabled, refreshToken]);

  const refresh = async () => {
    setCatalog(await client.list());
    setLoadStatus('loaded');
  };

  const addSource = async (request: PluginMarketplaceAddRequest) => {
    setError(null);
    setBusyKey('add-source');
    try {
      await client.add(request);
      await refresh();
      setSourceFilter('custom');
      setSourceUrl('');
      setSourceRef('');
    } catch (addError: unknown) {
      setError(
        `개인 marketplace를 추가하지 못했습니다. ${getErrorMessage(addError)}`,
      );
    } finally {
      setBusyKey(null);
    }
  };

  const submitSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = sourceUrl.trim();
    const ref = sourceRef.trim();
    if (!url || disabled || busyKey !== null || loadStatus !== 'loaded') {
      return;
    }
    await addSource({
      sourceKind: 'git',
      url,
      ...(ref ? { ref } : {}),
    });
  };

  const handleInstall = async (entry: PluginMarketplaceEntryView) => {
    if (entry.contentDigest === null) {
      return;
    }
    setError(null);
    setBusyKey(`install:${entry.marketplaceId}:${entry.entryId}`);
    try {
      const response = await client.install({
        marketplaceId: entry.marketplaceId,
        entryId: entry.entryId,
        expectedContentDigest: entry.contentDigest,
      });
      onInstalled(response.plugin);
      setCatalog((current) => ({
        ...current,
        entries: current.entries.map((candidate) =>
          candidate.marketplaceId === entry.marketplaceId &&
          candidate.entryId === entry.entryId
            ? {
                ...candidate,
                installedInstallationId: response.plugin.installationId,
              }
            : candidate,
        ),
      }));
    } catch (installError: unknown) {
      setError(
        `플러그인을 설치하지 못했습니다. ${getErrorMessage(installError)}`,
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleUninstall = async (entry: PluginMarketplaceEntryView) => {
    const installationId = entry.installedInstallationId;
    if (installationId === null || client.uninstall === undefined) {
      return;
    }
    setError(null);
    setBusyKey(`uninstall:${installationId}`);
    try {
      await client.uninstall(installationId);
      onUninstalled?.(installationId);
      setCatalog((current) => ({
        ...current,
        entries: current.entries.map((candidate) =>
          candidate.marketplaceId === entry.marketplaceId &&
          candidate.entryId === entry.entryId
            ? { ...candidate, installedInstallationId: null }
            : candidate,
        ),
      }));
    } catch (uninstallError: unknown) {
      setError(
        `플러그인을 제거하지 못했습니다. ${getErrorMessage(uninstallError)}`,
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleRemoveSource = async (marketplaceId: string) => {
    setError(null);
    setBusyKey(`remove:${marketplaceId}`);
    try {
      await client.remove(marketplaceId);
      setCatalog((current) => ({
        sources: current.sources.filter(
          (source) => source.marketplaceId !== marketplaceId,
        ),
        entries: current.entries.filter(
          (entry) => entry.marketplaceId !== marketplaceId,
        ),
        diagnostics: current.diagnostics.filter(
          (diagnostic) => diagnostic.marketplaceId !== marketplaceId,
        ),
      }));
      setConfirmRemoveId(null);
    } catch (removeError: unknown) {
      setError(
        `marketplace를 제거하지 못했습니다. ${getErrorMessage(removeError)}`,
      );
    } finally {
      setBusyKey(null);
    }
  };

  const sourceRoles = useMemo(
    () =>
      new Map(
        catalog.sources.map((source) => [
          source.marketplaceId,
          source.sourceRole,
        ]),
      ),
    [catalog.sources],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = filterVisibleMarketplaceEntries({
    entries: catalog.entries,
    sourceRoles,
    sourceFilter,
    capabilityFilter,
    normalizedQuery,
  });
  const customSourceCount = catalog.sources.filter(
    (source) => source.sourceRole === 'custom',
  ).length;
  const busy = busyKey !== null;
  const groupedEntries = groupMarketplaceEntries(visibleEntries);
  const featuredEntries = selectFeaturedMarketplaceEntries(visibleEntries);
  const catalogTitle =
    capabilityFilter === 'skills'
      ? '스킬이 포함된 공식 플러그인'
      : 'Codex 공식 플러그인';

  const selectSource = (source: 'official' | 'custom') => {
    setSourceFilter(source);
    setSelectedCategory(null);
    setExpandedSections([]);
    setFilterOpen(false);
  };

  const selectCategory = (category: string | null) => {
    setSelectedCategory(category);
    setFilterOpen(false);
  };

  const toggleSection = (section: string) => {
    setExpandedSections((current) =>
      current.includes(section)
        ? current.filter((candidate) => candidate !== section)
        : [...current, section],
    );
  };

  const entryActions = (entry: PluginMarketplaceEntryView) => {
    const installationId = entry.installedInstallationId;
    return {
      ...(onManageInstalled && installationId !== null
        ? {
            onManage: () => onManageInstalled(installationId),
          }
        : {}),
      ...(client.uninstall
        ? { onUninstall: () => void handleUninstall(entry) }
        : {}),
    };
  };

  return (
    <section
      className="extension-catalog"
      aria-labelledby="plugin-marketplace-title"
    >
      {showManagement ? (
        <div className="extension-section-heading">
          <div>
            <h3 id="plugin-marketplace-title">{catalogTitle}</h3>
            <p>
              Codex 공식 marketplace의 실제 패키지를 글밭이 직접 검증하고
              설치합니다.
            </p>
          </div>
          <span
            className={`extension-source-status ${officialStatus}`}
            role="status"
          >
            {officialStatus === 'connecting'
              ? '공식 catalog 연결 중…'
              : officialStatus === 'connected'
                ? 'Codex official 연결됨'
                : officialStatus === 'failed'
                  ? '연결 확인 필요'
                  : '데몬 연결 필요'}
          </span>
        </div>
      ) : (
        <h3 id="plugin-marketplace-title" className="sr-only">
          {catalogTitle}
        </h3>
      )}

      <div className="extension-catalog-controls">
        <div
          className="extension-source-tabs"
          role="tablist"
          aria-label="Marketplace 소스"
        >
          <button
            type="button"
            role="tab"
            aria-selected={sourceFilter === 'official'}
            onClick={() => selectSource('official')}
          >
            공개
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sourceFilter === 'custom'}
            disabled={customSourceCount === 0}
            onClick={() => selectSource('custom')}
          >
            개인용{customSourceCount > 0 ? ` · ${customSourceCount}` : ''}
          </button>
        </div>
        <div className="extension-catalog-filter">
          <button
            type="button"
            className="extension-catalog-filter-trigger"
            aria-label="플러그인 보기 필터"
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            disabled={visibleEntries.length === 0}
            onClick={() => setFilterOpen((current) => !current)}
          >
            ≡
          </button>
          {filterOpen ? (
            <div className="extension-catalog-filter-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => selectCategory(null)}
              >
                Featured
              </button>
              {groupedEntries.map(([category]) => (
                <button
                  type="button"
                  role="menuitem"
                  key={category}
                  onClick={() => selectCategory(category)}
                >
                  {category}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {showManagement ? (
        <details className="settings-disclosure extension-management">
          <summary>Marketplace 소스 관리</summary>
          <form
            className="settings-install-form"
            onSubmit={(event) => void submitSource(event)}
          >
            <label htmlFor="plugin-marketplace-url">
              개인 HTTPS Git marketplace
            </label>
            <div>
              <input
                id="plugin-marketplace-url"
                type="url"
                value={sourceUrl}
                required
                disabled={disabled || busy || loadStatus !== 'loaded'}
                placeholder="https://github.com/owner/plugins.git"
                onChange={(event) => setSourceUrl(event.currentTarget.value)}
              />
              <input
                aria-label="Git ref"
                value={sourceRef}
                disabled={disabled || busy || loadStatus !== 'loaded'}
                placeholder="ref (선택)"
                onChange={(event) => setSourceRef(event.currentTarget.value)}
              />
              <button
                type="submit"
                className="settings-primary-action"
                disabled={
                  disabled ||
                  busy ||
                  loadStatus !== 'loaded' ||
                  !sourceUrl.trim()
                }
              >
                소스 추가
              </button>
            </div>
          </form>

          <div className="settings-item-list">
            {catalog.sources.map((source) => (
              <article
                key={source.marketplaceId}
                className="settings-item-row settings-marketplace-source-row"
              >
                <div className="settings-item-heading">
                  <strong>{source.displayName}</strong>
                  <span className="settings-item-state enabled">
                    {source.sourceRole === 'official' ? '기본 소스' : 'Git'}
                  </span>
                </div>
                <p className="settings-item-meta">
                  {source.name} · {source.resolvedRevision.slice(4, 16)}
                </p>
                <p className="settings-item-description">{source.sourceUrl}</p>
                {source.sourceRole === 'custom' ? (
                  <div className="settings-row-actions">
                    <button
                      type="button"
                      aria-expanded={confirmRemoveId === source.marketplaceId}
                      disabled={disabled || busy}
                      onClick={() =>
                        setConfirmRemoveId((current) =>
                          current === source.marketplaceId
                            ? null
                            : source.marketplaceId,
                        )
                      }
                    >
                      {confirmRemoveId === source.marketplaceId
                        ? '제거 확인 닫기'
                        : '소스 제거'}
                    </button>
                  </div>
                ) : null}
                {confirmRemoveId === source.marketplaceId ? (
                  <div className="settings-row-actions" role="group">
                    <span>설치한 사본은 유지하고 개인 소스만 제거할까요?</span>
                    <button
                      type="button"
                      disabled={disabled || busy}
                      onClick={() =>
                        void handleRemoveSource(source.marketplaceId)
                      }
                    >
                      제거
                    </button>
                    <button
                      type="button"
                      disabled={disabled || busy}
                      onClick={() => setConfirmRemoveId(null)}
                    >
                      취소
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </details>
      ) : null}

      {error ? (
        <div className="settings-alert" role="alert">
          {error}
        </div>
      ) : null}

      {loadStatus === 'loading' || officialStatus === 'connecting' ? (
        <p className="settings-empty" role="status">
          Codex 공식 marketplace를 준비하는 중…
        </p>
      ) : loadStatus === 'failed' ? null : visibleEntries.length === 0 ? (
        <p className="settings-empty">
          {normalizedQuery
            ? '검색 조건에 맞는 플러그인이 없습니다'
            : sourceFilter === 'custom'
              ? '추가한 개인 marketplace가 없습니다'
              : '공식 catalog에서 표시할 플러그인이 없습니다'}
        </p>
      ) : normalizedQuery ? (
        <section className="extension-category extension-search-results">
          <h4>검색 결과</h4>
          <div className="extension-marketplace-list">
            {visibleEntries.map((entry) => (
              <MarketplaceEntryRow
                key={`${entry.marketplaceId}/${entry.entryId}`}
                entry={entry}
                disabled={disabled || busy}
                onInstall={() => void handleInstall(entry)}
                {...entryActions(entry)}
              />
            ))}
          </div>
        </section>
      ) : (
        <div className="extension-category-list">
          {selectedCategory === null && featuredEntries.length > 0 ? (
            <section
              className="extension-category extension-featured"
              aria-label="Featured 플러그인"
            >
              <h4>Featured</h4>
              <div className="extension-marketplace-list">
                {(expandedSections.includes(FEATURED_SECTION_KEY)
                  ? featuredEntries
                  : featuredEntries.slice(0, SECTION_PREVIEW_ENTRY_COUNT)
                ).map((entry) => (
                  <MarketplaceEntryRow
                    key={`${entry.marketplaceId}/${entry.entryId}`}
                    entry={entry}
                    disabled={disabled || busy}
                    onInstall={() => void handleInstall(entry)}
                    {...entryActions(entry)}
                  />
                ))}
              </div>
              <SectionMoreButton
                sectionLabel="Featured"
                hiddenEntries={featuredEntries.slice(
                  SECTION_PREVIEW_ENTRY_COUNT,
                )}
                expanded={expandedSections.includes(FEATURED_SECTION_KEY)}
                onToggle={() => toggleSection(FEATURED_SECTION_KEY)}
              />
            </section>
          ) : null}

          {groupedEntries
            .filter(
              ([category]) =>
                selectedCategory === null || selectedCategory === category,
            )
            .map(([category, entries]) => {
              const expanded = expandedSections.includes(category);
              const displayedEntries = expanded
                ? entries
                : entries.slice(0, SECTION_PREVIEW_ENTRY_COUNT);
              return (
                <section
                  className="extension-category"
                  aria-label={`${category} 플러그인`}
                  key={category}
                >
                  <h4>{category}</h4>
                  <div className="extension-marketplace-list">
                    {displayedEntries.map((entry) => (
                      <MarketplaceEntryRow
                        key={`${entry.marketplaceId}/${entry.entryId}`}
                        entry={entry}
                        disabled={disabled || busy}
                        onInstall={() => void handleInstall(entry)}
                        {...entryActions(entry)}
                      />
                    ))}
                  </div>
                  <SectionMoreButton
                    sectionLabel={category}
                    hiddenEntries={entries.slice(SECTION_PREVIEW_ENTRY_COUNT)}
                    expanded={expanded}
                    onToggle={() => toggleSection(category)}
                  />
                </section>
              );
            })}
        </div>
      )}

      {catalog.diagnostics.length > 0 ? (
        <details className="settings-disclosure">
          <summary>불러오지 못한 항목 {catalog.diagnostics.length}개</summary>
          <ul className="settings-diagnostic-list">
            {catalog.diagnostics.map((diagnostic, index) => (
              <li
                key={`${diagnostic.marketplaceId}/${diagnostic.entryName ?? 'source'}/${index}`}
              >
                <strong>{diagnostic.entryName ?? 'Marketplace 소스'}</strong>
                <span>{diagnostic.message}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
