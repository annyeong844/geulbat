import type {
  InstalledPluginView,
  PluginMarketplaceAddRequest,
  PluginMarketplaceEntryView,
  PluginMarketplaceInstallRequest,
  PluginMarketplaceListResponse,
} from '@geulbat/protocol/plugins';
import { useEffect, useState } from 'react';

import { getErrorMessage } from '../../lib/error-message.js';
import {
  addPluginMarketplace,
  ensureOfficialPluginMarketplace,
  installMarketplacePlugin,
  listPluginMarketplaces,
  removePlugin,
  removePluginMarketplace,
} from '../../lib/api/plugins.js';

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

interface PluginMarketplaceController {
  catalog: PluginMarketplaceListResponse;
  loadStatus: 'loading' | 'loaded' | 'failed';
  officialStatus: 'idle' | 'connecting' | 'connected' | 'failed';
  error: string | null;
  busy: boolean;
  canUninstall: boolean;
  addSource(request: PluginMarketplaceAddRequest): Promise<boolean>;
  install(entry: PluginMarketplaceEntryView): Promise<void>;
  uninstall(entry: PluginMarketplaceEntryView): Promise<void>;
  removeSource(marketplaceId: string): Promise<boolean>;
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

export function usePluginMarketplaceController(args: {
  client: PluginMarketplaceClient | undefined;
  disabled: boolean;
  refreshToken: number;
  onInstalled: (plugin: InstalledPluginView) => void;
  onUninstalled: ((installationId: string) => void) | undefined;
}): PluginMarketplaceController {
  const client = args.client ?? DEFAULT_CLIENT;
  const [catalog, setCatalog] =
    useState<PluginMarketplaceListResponse>(EMPTY_CATALOG);
  const [loadStatus, setLoadStatus] =
    useState<PluginMarketplaceController['loadStatus']>('loading');
  const [officialStatus, setOfficialStatus] =
    useState<PluginMarketplaceController['officialStatus']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

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
        if (args.disabled) {
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
  }, [args.disabled, args.refreshToken, client]);

  const refresh = async (): Promise<void> => {
    setCatalog(await client.list());
    setLoadStatus('loaded');
  };

  const addSource = async (
    request: PluginMarketplaceAddRequest,
  ): Promise<boolean> => {
    setError(null);
    setBusyKey('add-source');
    try {
      await client.add(request);
      await refresh();
      return true;
    } catch (addError: unknown) {
      setError(
        `개인 marketplace를 추가하지 못했습니다. ${getErrorMessage(addError)}`,
      );
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const install = async (entry: PluginMarketplaceEntryView): Promise<void> => {
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
      args.onInstalled(response.plugin);
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

  const uninstall = async (
    entry: PluginMarketplaceEntryView,
  ): Promise<void> => {
    const installationId = entry.installedInstallationId;
    if (installationId === null || client.uninstall === undefined) {
      return;
    }
    setError(null);
    setBusyKey(`uninstall:${installationId}`);
    try {
      await client.uninstall(installationId);
      args.onUninstalled?.(installationId);
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

  const removeSource = async (marketplaceId: string): Promise<boolean> => {
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
      return true;
    } catch (removeError: unknown) {
      setError(
        `marketplace를 제거하지 못했습니다. ${getErrorMessage(removeError)}`,
      );
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  return {
    catalog,
    loadStatus,
    officialStatus,
    error,
    busy: busyKey !== null,
    canUninstall: client.uninstall !== undefined,
    addSource,
    install,
    uninstall,
    removeSource,
  };
}
