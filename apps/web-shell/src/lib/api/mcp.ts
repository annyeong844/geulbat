import {
  isMcpServerDeleteResponse,
  isMcpServerListResponse,
  isMcpServerMutationResponse,
  type McpServerCreateRequest,
  type McpServerDeleteResponse,
  type McpServerListResponse,
  type McpServerMutationResponse,
} from '@geulbat/protocol/mcp';

import { apiFetch } from './client.js';

export function listMcpServers(): Promise<McpServerListResponse> {
  return apiFetch('/api/mcp/servers', undefined, isMcpServerListResponse);
}

export function addMcpServer(
  request: McpServerCreateRequest,
): Promise<McpServerMutationResponse> {
  return apiFetch(
    '/api/mcp/servers',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    isMcpServerMutationResponse,
  );
}

export function setMcpServerEnabled(
  serverId: string,
  enabled: boolean,
): Promise<McpServerMutationResponse> {
  return apiFetch(
    `/api/mcp/servers/${encodeURIComponent(serverId)}/enabled`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    },
    isMcpServerMutationResponse,
  );
}

export function installMcpServerTool(
  serverId: string,
  toolName: string,
): Promise<McpServerMutationResponse> {
  return apiFetch(
    `/api/mcp/servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}`,
    { method: 'PUT' },
    isMcpServerMutationResponse,
  );
}

export function uninstallMcpServerTool(
  serverId: string,
  toolName: string,
): Promise<McpServerMutationResponse> {
  return apiFetch(
    `/api/mcp/servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}`,
    { method: 'DELETE' },
    isMcpServerMutationResponse,
  );
}

export function removeMcpServer(
  serverId: string,
): Promise<McpServerDeleteResponse> {
  return apiFetch(
    `/api/mcp/servers/${encodeURIComponent(serverId)}`,
    { method: 'DELETE' },
    isMcpServerDeleteResponse,
  );
}
