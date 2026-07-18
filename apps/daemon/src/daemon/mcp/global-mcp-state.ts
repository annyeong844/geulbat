import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  McpServerCreateRequest,
  McpServerRegistration,
  McpServerRuntimeStatus,
  McpServerView,
} from '@geulbat/protocol/mcp';
import { createLogger } from '@geulbat/shared-utils/logger';

import { getErrorMessage } from '../utils/error.js';
import {
  McpServerConfigError,
  McpServerNotFoundError,
  McpServerOwnershipError,
} from './global-mcp-contract.js';
import {
  clonePluginBinding,
  connectingStatus,
  disabledStatus,
  errorStatus,
  normalizeCreateRequest,
  pluginMcpServerId,
  pluginRegistrationFromBinding,
  registrationFingerprint,
  registrationListFingerprint,
  toServerView,
  validateRegistration,
  type PluginMcpServerBinding,
} from './global-mcp-registration.js';
import type { PersistedMcpRegistry } from './global-mcp-registry-persistence.js';
import {
  assertRequestedToolName,
  type LiveMcpServer,
} from './global-mcp-tool-projection.js';

const logger = createLogger('global-mcp');

// Global MCP 도메인 state owner — browser-state-runtime·plugin-store-state
// 선례를 따른다. registrations·statuses·liveServers·pluginBindings·
// suspendedPluginIds와 생명주기 플래그, mutation queue를 단독 소유하며 raw
// Map은 밖으로 나가지 않는다. 이 owner가 소유하는 invariant:
//
// - persist-먼저: registry persist가 성공한 뒤에만 registrations를 바꾼다.
// - connect 시도→상태 확정: 적격 판정→connecting→establish→projection→ready,
//   실패 시 cleanup과 error status 확정까지가 하나의 전이다.
// - stale-client guard: 비동기 disconnect·tool-refresh 콜백은 mutation
//   queue로 재진입해 현재 live client와 동일할 때만 상태를 다시 쓴다.
//
// SDK client 구성·프로세스 teardown·tool projection 준비·레지스트리 파일
// I/O는 정책으로 주입받는다. 전이 순서는 owner가, 효과는 정책이 갖는다.
interface GlobalMcpPreparedProjection {
  status: McpServerRuntimeStatus;
}

interface GlobalMcpStatePolicies<Prepared extends GlobalMcpPreparedProjection> {
  loadPersistedRegistry(): Promise<{
    registry: PersistedMcpRegistry;
    migrationRequired: boolean;
  }>;
  persistRegistrations(next: McpServerRegistration[]): Promise<void>;
  /** SDK transport·client 구성과 콜백 와이어링. 실패 시 부분 자원을 스스로
   * 정리한 뒤 연결·정리 오류를 합성한 메시지로 throw한다. */
  establishLive(args: {
    registration: McpServerRegistration;
    binding: PluginMcpServerBinding | undefined;
    onUnexpectedDisconnect: (client: Client, reason: string) => void;
    onToolListChanged: (client: Client) => Promise<void>;
  }): Promise<LiveMcpServer>;
  /** stderr detach와 client→transport 순 close. transport close 실패 시
   * 합성 메시지로 throw하고, client close 단독 실패는 삼킨다(기존 동작). */
  teardownLive(serverId: string, live: LiveMcpServer): Promise<void>;
  prepareProjection(
    registration: McpServerRegistration,
    live: LiveMcpServer,
  ): Promise<Prepared>;
  applyPreparedProjection(live: LiveMcpServer, prepared: Prepared): void;
  removeProjectedTool(
    live: LiveMcpServer,
    serverId: string,
    toolName: string,
  ): void;
  unregisterProjection(live: LiveMcpServer): void;
}

interface GlobalMcpStateOwner {
  initialize(pluginServers?: readonly PluginMcpServerBinding[]): Promise<void>;
  listServers(): McpServerView[];
  addServer(request: McpServerCreateRequest): Promise<McpServerView>;
  setServerEnabled(serverId: string, enabled: boolean): Promise<McpServerView>;
  installTool(serverId: string, toolName: string): Promise<McpServerView>;
  uninstallTool(serverId: string, toolName: string): Promise<McpServerView>;
  removeServer(serverId: string): Promise<void>;
  reconcilePluginServers(
    pluginServers: readonly PluginMcpServerBinding[],
  ): Promise<void>;
  suspendPluginServers(pluginInstallationId: string): Promise<void>;
  removePluginServers(pluginInstallationId: string): Promise<void>;
  close(): Promise<void>;
}

export function createGlobalMcpStateOwner<
  Prepared extends GlobalMcpPreparedProjection,
>(policies: GlobalMcpStatePolicies<Prepared>): GlobalMcpStateOwner {
  const registrations = new Map<string, McpServerRegistration>();
  const statuses = new Map<string, McpServerRuntimeStatus>();
  const liveServers = new Map<string, LiveMcpServer>();
  const pluginBindings = new Map<string, PluginMcpServerBinding>();
  const suspendedPluginIds = new Set<string>();
  let initialized = false;
  let closed = false;
  let mutationTail: Promise<void> = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function assertUsable(): void {
    if (!initialized) {
      throw new Error('global MCP runtime is not initialized');
    }
    if (closed) {
      throw new Error('global MCP runtime is closed');
    }
  }

  function isPluginRegistrationEligible(
    registration: McpServerRegistration,
  ): boolean {
    if (registration.source.kind === 'manual') {
      return true;
    }
    const binding = pluginBindings.get(registration.serverId);
    return (
      binding !== undefined &&
      binding.pluginEnabled &&
      !suspendedPluginIds.has(registration.source.installationId)
    );
  }

  function statusForRegistration(
    registration: McpServerRegistration,
  ): McpServerRuntimeStatus {
    if (!registration.enabled) {
      return disabledStatus('server-disabled');
    }
    if (!isPluginRegistrationEligible(registration)) {
      return disabledStatus('plugin-disabled');
    }
    return connectingStatus();
  }

  function normalizePluginBindings(
    bindings: readonly PluginMcpServerBinding[],
  ): Map<string, PluginMcpServerBinding> {
    const normalized = new Map<string, PluginMcpServerBinding>();
    for (const binding of bindings) {
      const serverId = pluginMcpServerId(binding.source);
      if (normalized.has(serverId)) {
        throw new McpServerConfigError(
          `Plugin MCP snapshot contains duplicate server identity: ${binding.source.serverName}`,
        );
      }
      const registration = pluginRegistrationFromBinding(binding, false);
      validateRegistration(registration);
      normalized.set(serverId, clonePluginBinding(binding));
    }
    return normalized;
  }

  function listServerViews(): McpServerView[] {
    return [...registrations.values()]
      .map((registration) => toServerView(registration, statuses))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  function scheduleUnexpectedDisconnect(
    serverId: string,
    client: Client,
    reason: string,
  ): void {
    void serialize(async () => {
      const live = liveServers.get(serverId);
      if (closed || live?.client !== client) {
        return;
      }
      try {
        await disconnect(serverId);
        statuses.set(serverId, errorStatus(reason));
      } catch (error: unknown) {
        const cleanupError = getErrorMessage(error);
        statuses.set(
          serverId,
          errorStatus(`${reason}; MCP process cleanup failed: ${cleanupError}`),
        );
        logger.warn('MCP client cleanup after disconnect failed:', {
          serverId,
          error: cleanupError,
        });
      }
    });
  }

  function handleToolListChanged(
    serverId: string,
    client: Client,
  ): Promise<void> {
    return serialize(async () => {
      try {
        await refreshProjection(serverId);
      } catch (error: unknown) {
        const live = liveServers.get(serverId);
        if (live?.client === client) {
          policies.unregisterProjection(live);
          statuses.set(
            serverId,
            errorStatus(`MCP tool refresh failed: ${getErrorMessage(error)}`),
          );
        }
      }
    });
  }

  function applyProjection(
    serverId: string,
    live: LiveMcpServer,
    prepared: Prepared,
  ): void {
    policies.applyPreparedProjection(live, prepared);
    statuses.set(serverId, prepared.status);
  }

  async function refreshProjection(serverId: string): Promise<void> {
    const registration = registrations.get(serverId);
    const live = liveServers.get(serverId);
    if (
      !registration ||
      !live ||
      !registration.enabled ||
      !isPluginRegistrationEligible(registration)
    ) {
      return;
    }
    applyProjection(
      serverId,
      live,
      await policies.prepareProjection(registration, live),
    );
  }

  async function connect(registration: McpServerRegistration): Promise<void> {
    const serverId = registration.serverId;
    if (!registration.enabled || !isPluginRegistrationEligible(registration)) {
      statuses.set(serverId, statusForRegistration(registration));
      return;
    }
    statuses.set(serverId, connectingStatus());
    let live: LiveMcpServer;
    try {
      await disconnect(serverId);
      live = await policies.establishLive({
        registration,
        binding: pluginBindings.get(serverId),
        onUnexpectedDisconnect: (client, reason) => {
          scheduleUnexpectedDisconnect(serverId, client, reason);
        },
        onToolListChanged: (client) => handleToolListChanged(serverId, client),
      });
    } catch (error: unknown) {
      statuses.set(
        serverId,
        errorStatus(`MCP connection failed: ${getErrorMessage(error)}`),
      );
      return;
    }
    liveServers.set(serverId, live);
    try {
      await refreshProjection(serverId);
    } catch (error: unknown) {
      let cleanupError: string | undefined;
      try {
        await disconnect(serverId);
      } catch (disconnectError: unknown) {
        cleanupError = getErrorMessage(disconnectError);
      }
      statuses.set(
        serverId,
        errorStatus(
          `MCP connection failed: ${getErrorMessage(error)}${
            cleanupError === undefined
              ? ''
              : `; MCP process cleanup failed: ${cleanupError}`
          }`,
        ),
      );
    }
  }

  async function disconnect(serverId: string): Promise<void> {
    const live = liveServers.get(serverId);
    if (!live) {
      return;
    }
    policies.unregisterProjection(live);
    try {
      await policies.teardownLive(serverId, live);
    } catch (error: unknown) {
      statuses.set(
        serverId,
        errorStatus(`MCP process cleanup failed: ${getErrorMessage(error)}`),
      );
      throw error;
    }
    if (liveServers.get(serverId) === live) {
      liveServers.delete(serverId);
    }
  }

  async function replacePluginBindings(
    bindings: readonly PluginMcpServerBinding[],
  ): Promise<void> {
    const nextBindings = normalizePluginBindings(bindings);
    const currentRegistrations = [...registrations.values()];
    const nextRegistrations = currentRegistrations.filter(
      (registration) => registration.source.kind === 'manual',
    );
    for (const [serverId, binding] of nextBindings) {
      const current = registrations.get(serverId);
      if (current?.source.kind === 'manual') {
        throw new McpServerConfigError(
          `Plugin MCP server identity conflicts with a manual registration: ${serverId}`,
        );
      }
      nextRegistrations.push(
        pluginRegistrationFromBinding(
          binding,
          current?.enabled ?? false,
          current?.installedToolNames ?? [],
        ),
      );
    }

    const nextById = new Map(
      nextRegistrations.map((registration) => [
        registration.serverId,
        registration,
      ]),
    );
    const disconnected: McpServerRegistration[] = [];
    for (const [serverId] of liveServers) {
      const current = registrations.get(serverId);
      const next = nextById.get(serverId);
      const nextBinding = nextBindings.get(serverId);
      const remainsEligible =
        next?.source.kind === 'manual' ||
        (nextBinding?.pluginEnabled === true &&
          !suspendedPluginIds.has(nextBinding.source.installationId));
      if (
        current &&
        (!next ||
          !remainsEligible ||
          registrationFingerprint(current) !== registrationFingerprint(next))
      ) {
        await disconnect(serverId);
        disconnected.push(current);
      }
    }

    try {
      if (
        registrationListFingerprint(currentRegistrations) !==
        registrationListFingerprint(nextRegistrations)
      ) {
        await policies.persistRegistrations(nextRegistrations);
      }
    } catch (error: unknown) {
      await Promise.all(
        disconnected.map((registration) => connect(registration)),
      ).catch(() => undefined);
      throw error;
    }

    registrations.clear();
    for (const registration of nextRegistrations) {
      registrations.set(registration.serverId, registration);
    }
    pluginBindings.clear();
    for (const [serverId, binding] of nextBindings) {
      pluginBindings.set(serverId, binding);
    }
    suspendedPluginIds.clear();
    for (const serverId of [...statuses.keys()]) {
      if (!registrations.has(serverId)) {
        statuses.delete(serverId);
      }
    }
    for (const registration of registrations.values()) {
      if (!liveServers.has(registration.serverId)) {
        statuses.set(
          registration.serverId,
          statusForRegistration(registration),
        );
      }
    }
    await Promise.all(
      [...registrations.values()]
        .filter(
          (registration) =>
            registration.enabled &&
            isPluginRegistrationEligible(registration) &&
            !liveServers.has(registration.serverId),
        )
        .map((registration) => connect(registration)),
    );
  }

  return {
    async initialize(initialPluginServers = []) {
      await serialize(async () => {
        if (initialized) {
          return;
        }
        if (closed) {
          throw new Error('global MCP runtime is closed');
        }
        const persisted = await policies.loadPersistedRegistry();
        for (const registration of persisted.registry.servers) {
          registrations.set(registration.serverId, registration);
        }
        const initialBindings = normalizePluginBindings(initialPluginServers);
        pluginBindings.clear();
        for (const [serverId, binding] of initialBindings) {
          pluginBindings.set(serverId, binding);
        }
        const reconciled = [...registrations.values()].filter(
          (registration) => registration.source.kind === 'manual',
        );
        for (const [serverId, binding] of initialBindings) {
          const previous = registrations.get(serverId);
          if (previous?.source.kind === 'manual') {
            throw new McpServerConfigError(
              `Plugin MCP server identity conflicts with a manual registration: ${serverId}`,
            );
          }
          reconciled.push(
            pluginRegistrationFromBinding(
              binding,
              previous?.source.kind === 'plugin' ? previous.enabled : false,
              previous?.source.kind === 'plugin'
                ? previous.installedToolNames
                : [],
            ),
          );
        }
        registrations.clear();
        for (const registration of reconciled) {
          registrations.set(registration.serverId, registration);
          statuses.set(
            registration.serverId,
            statusForRegistration(registration),
          );
        }
        if (
          persisted.migrationRequired ||
          registrationListFingerprint(persisted.registry.servers) !==
            registrationListFingerprint(reconciled)
        ) {
          await policies.persistRegistrations(reconciled);
        }
        initialized = true;
        await Promise.all(
          [...registrations.values()]
            .filter(
              (registration) =>
                registration.enabled &&
                isPluginRegistrationEligible(registration),
            )
            .map((registration) => connect(registration)),
        );
      });
    },

    listServers() {
      assertUsable();
      return listServerViews();
    },

    async addServer(request) {
      return serialize(async () => {
        assertUsable();
        const registration = normalizeCreateRequest(request);
        await policies.persistRegistrations([
          ...registrations.values(),
          registration,
        ]);
        registrations.set(registration.serverId, registration);
        statuses.set(
          registration.serverId,
          statusForRegistration(registration),
        );
        if (
          registration.enabled &&
          isPluginRegistrationEligible(registration)
        ) {
          await connect(registration);
        }
        return toServerView(registration, statuses);
      });
    },

    async setServerEnabled(serverId, enabled) {
      return serialize(async () => {
        assertUsable();
        const current = registrations.get(serverId);
        if (!current) {
          throw new McpServerNotFoundError(serverId);
        }
        if (current.enabled === enabled) {
          return toServerView(current, statuses);
        }
        const updated: McpServerRegistration = { ...current, enabled };
        const next = [...registrations.values()].map((registration) =>
          registration.serverId === serverId ? updated : registration,
        );
        await policies.persistRegistrations(next);
        registrations.set(serverId, updated);
        if (enabled && isPluginRegistrationEligible(updated)) {
          await connect(updated);
        } else {
          statuses.set(serverId, statusForRegistration(updated));
          await disconnect(serverId);
        }
        return toServerView(updated, statuses);
      });
    },

    async installTool(serverId, toolName) {
      return serialize(async () => {
        assertUsable();
        const current = registrations.get(serverId);
        if (!current) {
          throw new McpServerNotFoundError(serverId);
        }
        assertRequestedToolName(toolName);
        if (current.installedToolNames.includes(toolName)) {
          return toServerView(current, statuses);
        }
        const live = liveServers.get(serverId);
        if (
          !live ||
          !current.enabled ||
          !isPluginRegistrationEligible(current)
        ) {
          throw new McpServerConfigError(
            `MCP tool cannot be installed while its server is unavailable: ${toolName}`,
          );
        }
        const updated: McpServerRegistration = {
          ...current,
          installedToolNames: [...current.installedToolNames, toolName].sort(),
        };
        const prepared = await policies.prepareProjection(updated, live);
        if (!prepared.status.availableToolNames.includes(toolName)) {
          throw new McpServerConfigError(
            `MCP server does not advertise a model-visible tool named: ${toolName}`,
          );
        }
        const next = [...registrations.values()].map((registration) =>
          registration.serverId === serverId ? updated : registration,
        );
        await policies.persistRegistrations(next);
        registrations.set(serverId, updated);
        applyProjection(serverId, live, prepared);
        return toServerView(updated, statuses);
      });
    },

    async uninstallTool(serverId, toolName) {
      return serialize(async () => {
        assertUsable();
        const current = registrations.get(serverId);
        if (!current) {
          throw new McpServerNotFoundError(serverId);
        }
        assertRequestedToolName(toolName);
        if (!current.installedToolNames.includes(toolName)) {
          return toServerView(current, statuses);
        }
        const updated: McpServerRegistration = {
          ...current,
          installedToolNames: current.installedToolNames.filter(
            (installedName) => installedName !== toolName,
          ),
        };
        const next = [...registrations.values()].map((registration) =>
          registration.serverId === serverId ? updated : registration,
        );
        await policies.persistRegistrations(next);
        registrations.set(serverId, updated);
        const live = liveServers.get(serverId);
        if (live) {
          policies.removeProjectedTool(live, serverId, toolName);
        }
        const status = statuses.get(serverId);
        if (status?.state === 'ready') {
          statuses.set(serverId, {
            ...status,
            activeToolNames: status.activeToolNames.filter(
              (activeName) => activeName !== toolName,
            ),
          });
        }
        return toServerView(updated, statuses);
      });
    },

    async removeServer(serverId) {
      await serialize(async () => {
        assertUsable();
        const registration = registrations.get(serverId);
        if (!registration) {
          throw new McpServerNotFoundError(serverId);
        }
        if (registration.source.kind === 'plugin') {
          throw new McpServerOwnershipError(serverId);
        }
        const next = [...registrations.values()].filter(
          (registration) => registration.serverId !== serverId,
        );
        await disconnect(serverId);
        await policies.persistRegistrations(next);
        registrations.delete(serverId);
        statuses.delete(serverId);
      });
    },

    async reconcilePluginServers(bindings) {
      await serialize(async () => {
        assertUsable();
        await replacePluginBindings(bindings);
      });
    },

    async suspendPluginServers(pluginInstallationId) {
      await serialize(async () => {
        assertUsable();
        suspendedPluginIds.add(pluginInstallationId);
        const affected = [...registrations.values()].filter(
          (registration) =>
            registration.source.kind === 'plugin' &&
            registration.source.installationId === pluginInstallationId,
        );
        for (const registration of affected) {
          statuses.set(
            registration.serverId,
            disabledStatus('plugin-disabled'),
          );
        }
        await Promise.all(
          affected.map((registration) => disconnect(registration.serverId)),
        );
      });
    },

    async removePluginServers(pluginInstallationId) {
      await serialize(async () => {
        assertUsable();
        const removedIds = [...registrations.values()]
          .filter(
            (registration) =>
              registration.source.kind === 'plugin' &&
              registration.source.installationId === pluginInstallationId,
          )
          .map((registration) => registration.serverId);
        if (removedIds.length === 0) {
          return;
        }
        const removed = new Set(removedIds);
        const next = [...registrations.values()].filter(
          (registration) => !removed.has(registration.serverId),
        );
        await Promise.all(removedIds.map((serverId) => disconnect(serverId)));
        await policies.persistRegistrations(next);
        for (const serverId of removedIds) {
          registrations.delete(serverId);
          statuses.delete(serverId);
          pluginBindings.delete(serverId);
        }
        suspendedPluginIds.delete(pluginInstallationId);
      });
    },

    async close() {
      await serialize(async () => {
        if (closed) {
          return;
        }
        const serverIds = [...liveServers.keys()];
        const results = await Promise.allSettled(
          serverIds.map((serverId) => disconnect(serverId)),
        );
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [getErrorMessage(result.reason)] : [],
        );
        if (failures.length > 0) {
          throw new Error(`MCP shutdown failed: ${failures.join('; ')}`);
        }
        closed = true;
      });
    },
  };
}
