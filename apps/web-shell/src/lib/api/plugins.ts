import {
  isPluginDeleteResponse,
  isPluginListResponse,
  isPluginMarketplaceDeleteResponse,
  isPluginMarketplaceListResponse,
  isPluginMarketplaceMutationResponse,
  isPluginMutationResponse,
  isPluginSkillListResponse,
  type PluginDeleteResponse,
  type PluginInstallRequest,
  type PluginListResponse,
  type PluginMarketplaceAddRequest,
  type PluginMarketplaceDeleteResponse,
  type PluginMarketplaceInstallRequest,
  type PluginMarketplaceListResponse,
  type PluginMarketplaceMutationResponse,
  type PluginMutationResponse,
  type PluginSkillListResponse,
} from '@geulbat/protocol/plugins';

import { apiFetch } from './client.js';

export function listPlugins(): Promise<PluginListResponse> {
  return apiFetch('/api/plugins', undefined, isPluginListResponse);
}

export function listPluginSkills(): Promise<PluginSkillListResponse> {
  return apiFetch('/api/plugins/skills', undefined, isPluginSkillListResponse);
}

export function listPluginMarketplaces(): Promise<PluginMarketplaceListResponse> {
  return apiFetch(
    '/api/plugins/marketplaces',
    undefined,
    isPluginMarketplaceListResponse,
  );
}

export function marketplacePluginIconUrl(
  marketplaceId: string,
  entryId: string,
): string {
  return `/api/plugins/marketplaces/${encodeURIComponent(marketplaceId)}/entries/${encodeURIComponent(entryId)}/icon`;
}

export function addPluginMarketplace(
  request: PluginMarketplaceAddRequest,
): Promise<PluginMarketplaceMutationResponse> {
  return apiFetch(
    '/api/plugins/marketplaces',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    isPluginMarketplaceMutationResponse,
  );
}

export function ensureOfficialPluginMarketplace(): Promise<PluginMarketplaceMutationResponse> {
  return apiFetch(
    '/api/plugins/marketplaces/official',
    { method: 'POST' },
    isPluginMarketplaceMutationResponse,
  );
}

export function installMarketplacePlugin(
  request: PluginMarketplaceInstallRequest,
): Promise<PluginMutationResponse> {
  return apiFetch(
    '/api/plugins/marketplaces/install',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    isPluginMutationResponse,
  );
}

export function removePluginMarketplace(
  marketplaceId: string,
): Promise<PluginMarketplaceDeleteResponse> {
  return apiFetch(
    `/api/plugins/marketplaces/${encodeURIComponent(marketplaceId)}`,
    { method: 'DELETE' },
    isPluginMarketplaceDeleteResponse,
  );
}

export function installPlugin(
  request: PluginInstallRequest,
): Promise<PluginMutationResponse> {
  return apiFetch(
    '/api/plugins',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    isPluginMutationResponse,
  );
}

export function setPluginEnabled(
  installationId: string,
  enabled: boolean,
): Promise<PluginMutationResponse> {
  return apiFetch(
    `/api/plugins/${encodeURIComponent(installationId)}/enabled`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    },
    isPluginMutationResponse,
  );
}

export function removePlugin(
  installationId: string,
): Promise<PluginDeleteResponse> {
  return apiFetch(
    `/api/plugins/${encodeURIComponent(installationId)}`,
    { method: 'DELETE' },
    isPluginDeleteResponse,
  );
}
