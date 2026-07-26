import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type {
  McpServerCreateRequest,
  McpServerRegistration,
  McpServerRuntimeStatus,
  McpServerView,
} from '@geulbat/protocol/mcp';
import { createLogger } from '@geulbat/structured-logger/logger';

import type { ToolRegistryStore } from '../tools/tool-registry-model.js';
import { writeTextFileAtomically } from '../utils/atomic-file.js';
import { getErrorMessage } from '../utils/error.js';
import {
  McpServerConfigError,
  type McpSessionCoordinateStore,
} from './global-mcp-contract.js';
import {
  resolveServerEnvironment,
  type PluginMcpServerBinding,
} from './global-mcp-registration.js';
import {
  MCP_REGISTRY_RELATIVE_PATH,
  MCP_REGISTRY_SCHEMA_VERSION,
  readPersistedRegistry,
  type PersistedMcpRegistry,
} from './global-mcp-registry-persistence.js';
import {
  assertProjectionNamesAvailable,
  createProjectedMcpTool,
  indexModelVisibleTools,
  listAllTools,
  projectMcpToolName,
  requestOptions,
  unregisterProjection,
  type LiveMcpServer,
} from './global-mcp-tool-projection.js';
import { createGlobalMcpStateOwner } from './global-mcp-state.js';
import { WorkerStdioClientTransport } from './worker-stdio-client-transport.js';
import type { HostCommandRuntime } from '../../command-host/contract.js';

const logger = createLogger('global-mcp');

// P7.6 §4 A안 + §9 M4 — MCP 서버 프로세스는 command-host 세션이 소유한다.
// 배치는 더 이상 선택이 아니므로 데몬에는 spawn도, 프로세스 트리 종료도,
// stderr 펌프도 없다. MCP 프로토콜은 그대로 데몬의 SDK client가 소유한다 —
// 나간 것은 프로세스뿐이다.
const RETIRED_MCP_PLACEMENT_ENV = 'GEULBAT_MCP_PLACEMENT';

/**
 * M3에서 `local`은 한 줄 옵트아웃이었고 M4에서 사라졌다. 그 값이 아직 환경에
 * 남아 있다면 조용히 무시하지 않는다 — 사용자는 `local`이 여전히 데몬에게
 * 프로세스를 안긴다고 믿을 수 있다. 진단만 만들고 로깅은 부팅 경로가 한다.
 *
 * 폐기 조건: P7.6이 릴리즈 노트에 반영되어 이 환경변수를 설정한 셸이 남지
 * 않으면 이 함수와 호출부를 지운다.
 */
export function retiredMcpPlacementEnvDiagnostic(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[RETIRED_MCP_PLACEMENT_ENV]?.trim();
  return value === undefined || value === ''
    ? undefined
    : `${RETIRED_MCP_PLACEMENT_ENV}=${value} is no longer honored; MCP servers always run in a command-host session`;
}

export interface GlobalMcpRuntime {
  attachSessionCoordinateStore(store: McpSessionCoordinateStore): void;
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
  close(options?: { signal?: AbortSignal }): Promise<void>;
}

// 상태 전이는 global-mcp-state의 owner가 소유한다. 이 팩토리는 owner가
// 주입받는 I/O 정책 — 레지스트리 파일 persist, SDK client 구성/teardown,
// tool projection 준비와 toolRegistry 반영 — 만 구성한다.
export function createGlobalMcpRuntime(args: {
  homeStateRoot: string;
  toolRegistry: ToolRegistryStore;
  /**
   * MCP 서버 프로세스를 소유하는 command-host. 선택 인자가 아니다 — 데몬이
   * 대신 프로세스를 드는 갈래는 M4에서 사라졌으므로, 이것이 없으면 MCP를
   * 시작할 방법이 없다.
   */
  hostCommands: HostCommandRuntime;
  /** 한 번에 읽어올 페이지 크기 — 세션의 inline 예산에서 온다. */
  maxPageBytes: number;
}): GlobalMcpRuntime {
  const registryPath = join(args.homeStateRoot, MCP_REGISTRY_RELATIVE_PATH);
  let sessionCoordinateStore: McpSessionCoordinateStore | undefined;
  let initializationStarted = false;
  const reattachedAdvertisedTools = new WeakMap<
    Client,
    Awaited<ReturnType<typeof listAllTools>>
  >();
  const restartReasons = new WeakMap<Client, string>();
  const retiredPlacement = retiredMcpPlacementEnvDiagnostic();
  if (retiredPlacement !== undefined) {
    logger.warn(retiredPlacement);
  }

  function requireSessionCoordinateStore(): McpSessionCoordinateStore {
    if (sessionCoordinateStore === undefined) {
      throw new Error(
        'global MCP runtime requires the daemon runtime-state store',
      );
    }
    return sessionCoordinateStore;
  }

  async function prepareProjection(
    registration: McpServerRegistration,
    live: LiveMcpServer,
  ) {
    const reattachedTools = reattachedAdvertisedTools.get(live.client);
    reattachedAdvertisedTools.delete(live.client);
    const advertisedTools =
      reattachedTools ??
      (await listAllTools(
        live.client,
        registration.transport.requestTimeoutMs,
      ));
    const modelVisibleTools = indexModelVisibleTools(
      registration.serverId,
      advertisedTools,
    );
    const projectedTools = registration.installedToolNames.flatMap(
      (toolName) => {
        const tool = modelVisibleTools.get(toolName);
        return tool === undefined
          ? []
          : [
              {
                publicName: projectMcpToolName(
                  registration.serverId,
                  tool.name,
                ),
                tool,
              },
            ];
      },
    );
    assertProjectionNamesAvailable({
      projectedTools,
      currentProjectionNames: live.projectedToolNames,
      toolRegistry: args.toolRegistry,
    });
    const restartReason = restartReasons.get(live.client);

    return {
      registeredTools: projectedTools.map((projected) => ({
        publicName: projected.publicName,
        registeredTool: createProjectedMcpTool({
          client: live.client,
          schemaValidator: live.schemaValidator,
          registration,
          publicName: projected.publicName,
          tool: projected.tool,
        }),
      })),
      status: {
        state: 'ready',
        advertisedToolCount: advertisedTools.length,
        availableToolNames: [...modelVisibleTools.keys()].sort(),
        activeToolNames: projectedTools.map(({ tool }) => tool.name).sort(),
        ...(restartReason === undefined ? {} : { restartReason }),
      } satisfies McpServerRuntimeStatus,
    };
  }

  const stateOwner = createGlobalMcpStateOwner({
    loadPersistedRegistry: () => readPersistedRegistry(registryPath),

    async persistRegistrations(next) {
      const payload: PersistedMcpRegistry = {
        schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
        servers: next,
      };
      await writeTextFileAtomically(
        registryPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        { mode: 0o600 },
      );
    },

    async establishLive({
      registration,
      binding,
      onUnexpectedDisconnect,
      onToolListChanged,
    }) {
      const coordinateStore = requireSessionCoordinateStore();
      let client: Client | undefined;
      let transport: WorkerStdioClientTransport | undefined;
      let schemaValidator: AjvJsonSchemaValidator | undefined;
      const cleanupCurrentConnection = async (): Promise<
        Array<{ label: string; error: unknown }>
      > => {
        const cleanupErrors: Array<{ label: string; error: unknown }> = [];
        try {
          await client?.close();
        } catch (clientCloseError: unknown) {
          cleanupErrors.push({
            label: 'MCP client cleanup failed',
            error: clientCloseError,
          });
        }
        try {
          await transport?.close();
        } catch (transportError: unknown) {
          cleanupErrors.push({
            label: 'MCP process cleanup failed',
            error: transportError,
          });
        }
        client = undefined;
        transport = undefined;
        schemaValidator = undefined;
        return cleanupErrors;
      };
      const connectTransport = async (
        nextTransport: WorkerStdioClientTransport,
      ): Promise<void> => {
        transport = nextTransport;
        schemaValidator = new AjvJsonSchemaValidator();
        client = new Client(
          { name: 'geulbat', version: '0.0.0' },
          { jsonSchemaValidator: schemaValidator },
        );
        const connectedClient = client;
        client.onerror = (error) => {
          onUnexpectedDisconnect(
            connectedClient,
            `MCP transport error: ${getErrorMessage(error)}`,
          );
        };
        client.onclose = () => {
          onUnexpectedDisconnect(
            connectedClient,
            'MCP server connection closed',
          );
        };
        client.setNotificationHandler(
          ToolListChangedNotificationSchema,
          async () => {
            await onToolListChanged(connectedClient);
          },
        );
        await client.connect(
          nextTransport,
          requestOptions(registration.transport.connectionTimeoutMs),
        );
      };

      try {
        const transportOptions = {
          hostCommands: args.hostCommands,
          stateRoot: args.homeStateRoot,
          maxPageBytes: args.maxPageBytes,
        };
        const persistedCoordinate = coordinateStore.readMcpSessionCoordinate(
          registration.serverId,
        );
        let restartReason: string | undefined;
        if (persistedCoordinate !== undefined) {
          try {
            const claimed = await args.hostCommands.waitForInitialResult({
              stateRoot: args.homeStateRoot,
              outputRef: persistedCoordinate.outputRef,
              yieldTimeMs: 0,
            });
            if (!claimed.ok) {
              throw new Error(claimed.message);
            }
            if (claimed.value.status !== 'running') {
              throw new Error(
                `command-host session is ${claimed.value.status}`,
              );
            }
            await connectTransport(
              WorkerStdioClientTransport.attach(transportOptions, {
                outputRef: persistedCoordinate.outputRef,
                // 이전 데몬 요청의 미회수 응답은 새 client에게 쓰레기다. 현재
                // stdout end에서 시작해 unknown id 응답을 재생하지 않는다.
                readOffset: claimed.value.stdoutBytes,
              }),
            );
            if (client === undefined) {
              throw new Error('MCP re-adoption did not produce a client');
            }
            reattachedAdvertisedTools.set(
              client,
              await listAllTools(
                client,
                registration.transport.requestTimeoutMs,
              ),
            );
          } catch (error: unknown) {
            const reAdoptionError = error;
            const cleanupErrors = await cleanupCurrentConnection();
            try {
              coordinateStore.deleteMcpSessionCoordinate(registration.serverId);
            } catch (coordinateError: unknown) {
              cleanupErrors.push({
                label: 'MCP session coordinate cleanup failed',
                error: coordinateError,
              });
            }
            if (cleanupErrors.length > 0) {
              throw new AggregateError(
                [
                  reAdoptionError,
                  ...cleanupErrors.map((failure) => failure.error),
                ],
                `MCP re-adoption failed and cleanup was incomplete: ${cleanupErrors
                  .map(
                    ({ label, error: cleanupError }) =>
                      `${label}: ${getErrorMessage(cleanupError)}`,
                  )
                  .join('; ')}`,
              );
            }
            restartReason = `MCP session re-adoption failed: ${getErrorMessage(
              reAdoptionError,
            )}`;
          }
        }

        if (client === undefined) {
          const environment = resolveServerEnvironment(registration);
          const launch =
            registration.source.kind === 'plugin'
              ? await binding?.resolveLaunch()
              : undefined;
          if (registration.source.kind === 'plugin' && launch === undefined) {
            throw new McpServerConfigError(
              'Plugin MCP launch binding is unavailable',
            );
          }
          // P7.6 — 프로세스는 command-host 세션이 소유하고, 이 전송은 바이트만
          // 나른다. stderr는 세션이 따로 보관하므로 여기서 펌프하지 않는다.
          await connectTransport(
            WorkerStdioClientTransport.launch(transportOptions, {
              executable: registration.transport.command,
              args: registration.transport.args,
              cwd: launch?.cwd ?? args.homeStateRoot,
              env: environment,
            }),
          );
          const session = transport?.session;
          if (session === undefined) {
            throw new Error('MCP server launch did not expose a session');
          }
          coordinateStore.persistMcpSessionCoordinate({
            serverId: registration.serverId,
            outputRef: session.outputRef,
          });
          if (restartReason !== undefined && client !== undefined) {
            restartReasons.set(client, restartReason);
          }
        }
        if (
          client === undefined ||
          transport === undefined ||
          schemaValidator === undefined
        ) {
          throw new Error('MCP connection did not produce a live transport');
        }
        return {
          client,
          transport,
          schemaValidator,
          projectedToolNames: new Set(),
        };
      } catch (error: unknown) {
        const connectionError = getErrorMessage(error);
        const cleanupErrors = await cleanupCurrentConnection();
        try {
          coordinateStore.deleteMcpSessionCoordinate(registration.serverId);
        } catch (coordinateError: unknown) {
          cleanupErrors.push({
            label: 'MCP session coordinate cleanup failed',
            error: coordinateError,
          });
        }
        const cleanupMessage = cleanupErrors
          .map(({ label, error }) => `${label}: ${getErrorMessage(error)}`)
          .join('; ');
        throw new Error(
          `${connectionError}${cleanupMessage ? `; ${cleanupMessage}` : ''}`,
          {
            cause:
              cleanupErrors.length === 0
                ? error
                : new AggregateError(
                    [error, ...cleanupErrors.map((failure) => failure.error)],
                    'MCP connection and cleanup failed',
                  ),
          },
        );
      }
    },

    async teardownLive(serverId, live) {
      const coordinateStore = requireSessionCoordinateStore();
      const cleanupErrors: Array<{ label: string; error: unknown }> = [];
      try {
        await live.client.close();
      } catch (error: unknown) {
        cleanupErrors.push({ label: 'client', error });
      }
      try {
        await live.transport.close();
      } catch (transportCloseError: unknown) {
        cleanupErrors.push({ label: 'transport', error: transportCloseError });
      }
      try {
        coordinateStore.deleteMcpSessionCoordinate(serverId);
      } catch (coordinateError: unknown) {
        cleanupErrors.push({
          label: 'session-coordinate',
          error: coordinateError,
        });
      }
      reattachedAdvertisedTools.delete(live.client);
      restartReasons.delete(live.client);
      if (cleanupErrors.length > 0) {
        const message = cleanupErrors
          .map(({ label, error }) => `${label}: ${getErrorMessage(error)}`)
          .join('; ');
        logger.warn('MCP client cleanup failed:', { serverId, error: message });
        throw new Error(message, {
          cause:
            cleanupErrors.length === 1
              ? cleanupErrors[0]?.error
              : new AggregateError(
                  cleanupErrors.map((failure) => failure.error),
                  'MCP cleanup failed',
                ),
        });
      }
    },

    prepareProjection,

    applyPreparedProjection(live, prepared) {
      unregisterProjection(live, args.toolRegistry);
      for (const projected of prepared.registeredTools) {
        args.toolRegistry.registerTool(projected.registeredTool);
        live.projectedToolNames.add(projected.publicName);
      }
    },

    removeProjectedTool(live, serverId, toolName) {
      const publicName = projectMcpToolName(serverId, toolName);
      args.toolRegistry.unregisterTool(publicName);
      live.projectedToolNames.delete(publicName);
    },

    unregisterProjection: (live) =>
      unregisterProjection(live, args.toolRegistry),
  });

  return {
    ...stateOwner,
    attachSessionCoordinateStore(store) {
      if (initializationStarted) {
        throw new Error(
          'global MCP runtime-state store cannot be attached after initialization starts',
        );
      }
      if (
        sessionCoordinateStore !== undefined &&
        sessionCoordinateStore !== store
      ) {
        throw new Error(
          'global MCP runtime-state store has already been attached',
        );
      }
      sessionCoordinateStore = store;
    },
    async initialize(pluginServers) {
      requireSessionCoordinateStore();
      initializationStarted = true;
      await stateOwner.initialize(pluginServers);
    },
    close: () => stateOwner.close(),
  };
}
