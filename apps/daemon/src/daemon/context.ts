import { randomUUID } from 'node:crypto';

import { join } from 'node:path';

import {
  createApprovalGate,
  type ApprovalGate,
} from './agent/runtime/approval-gate.js';
import {
  createAgentLoopMemoryPort,
  type AgentLoopMemoryPort,
} from './agent/memory/compaction-loop.js';
import {
  dispatchArtifactFrameToolCall,
  type ArtifactFrameToolCallResult,
} from './agent/artifact-frame-tool-dispatcher.js';
import { resolveMemoryConsolidationModelFromEnv } from './agent/memory-consolidation.js';
import { resolveHomeStateRoot } from '../home-state-root.js';
import {
  createThreadBackgroundNotificationQueue,
  type BackgroundNotificationQueue,
} from './agent/runtime/background-notification-queue.js';
import {
  createChildRunRegistry,
  type ChildRunRegistry,
} from './agent/runtime/child-run-registry.js';
import {
  createProviderAuthBootstrapStore,
  type ProviderAuthBootstrapStore,
} from './auth/bootstrap/session-store.js';
import {
  createProviderAuthCallbackServerController,
  type ProviderAuthCallbackServerController,
} from './auth/bootstrap/callback-server.js';
import {
  createProviderAuthRuntimeStore,
  type ProviderAuthRuntimeStore,
} from './auth/runtime-state.js';
import {
  hardenProviderAuthFilePermissions,
  type ProviderAuthFilePermissionHardener,
} from './auth/credentials/store.js';
import {
  createComputerFileScope,
  type ComputerFileScope,
} from './files/computer-file-scope.js';
import {
  createComputerDirectoryPicker,
  type ComputerDirectoryPicker,
} from './files/computer-directory-picker.js';
import {
  createPluginStore,
  type PluginStore,
} from './extensions/plugin-store.js';
import {
  createPluginMarketplaceStore,
  type PluginMarketplaceStore,
} from './extensions/plugin-marketplace-store.js';
import { createMcpCoordinatedPluginStore } from './plugin-mcp-coordinator.js';
import { createBundledPluginSkillRuntime } from './extensions/bundled-plugin-skill-runtime.js';
import type { PluginSkillRuntime } from './extensions/plugin-skill-runtime.js';
import { joinWorkspaceGeulbatPath } from './files/geulbat-internal-paths.js';
import { createPtcExecuteCodeCellTerminalResultStore } from './ptc-execute-code-terminal-result-store.js';
import type {
  ImageGenerationRuntime,
  VideoGenerationRuntime,
} from './media/contract.js';
import { createImageGenerationRuntime } from './media/image-generation-runtime.js';
import { createVideoGenerationRuntime } from './media/video-generation-runtime.js';
import {
  createMemoryIndexStore,
  type MemoryIndexStore,
} from './memory/build-index.js';
import {
  createFileStateCache,
  type FileStateCache,
} from './utils/file-state-cache.js';
import {
  createResponsesWebSocketSessionStore,
  type OwnedResponsesWebSocketSessionStore,
} from './llm/provider/transport/responses-websocket-cache.js';
import { createHostRoutedResponsesRequestTransport } from './llm/provider/transport/responses-durable-request.js';
import {
  resolveProviderRequestOptions,
  type ProviderRequestOptions,
} from './llm/provider/provider-options.js';
import {
  createCodexWebSearchRuntime,
  type ProviderNativeWebSearchRuntime,
} from './llm/provider/codex-web-search.js';
import {
  resolveReactBundleStructuredOutputIngressPolicyFromEnv,
  type ReactBundleStructuredOutputIngressPolicy,
} from './agent/react-bundle-structured-output-ingress-policy.js';
import {
  createPtcFixedEpochProbeRuntime,
  type CreatePtcFixedEpochProbeRuntimeOptions,
} from './ptc/runtime/probes/fixed-probe-runtime.js';
import {
  createPtcExecuteCodeHostRoutedEpochBridge,
  createPtcExecuteCodeHostRoutedEpochCallbackControllerAttacher,
  createPtcExecuteCodeRuntime,
  resolvePtcExecuteCodeCallbackTransportPolicyFromEnv,
  resolvePtcExecuteCodeCellRuntimeConfigFromEnv,
  resolvePtcExecuteCodePackageInstallConfigFromEnv,
  type CreatePtcExecuteCodeRuntimeOptions,
} from './ptc/runtime/execute-code/execute-code-runtime.js';
import {
  createHostRoutedDetachedProcessAttacher,
  createHostRoutedDetachedProcessStarter,
} from './host-routed-detached-process.js';
import {
  PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
  type PtcExecuteCodePlacementResourceBudget,
  type PtcExecuteCodePlacementResourceMeasurement,
  type PtcExecuteCodeRuntime,
  type PtcPackageInstallRuntime,
} from './ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { createPtcBrowserPageLoadEvidenceRuntime } from './ptc/runtime/browser/browser-page-load-evidence-runtime.js';
import { createPtcBrowserTextEvidenceRuntime } from './ptc/runtime/browser/browser-text-evidence-runtime.js';
import { createPtcBrowserNavigateRuntime } from './ptc/runtime/browser/browser-navigate-runtime.js';
import {
  detectComputerSessionDefaults,
  discoverComputerSessionDefaults,
} from './files/computer-session-defaults.js';
import { runComputerBrowseDiscoveryLoop } from './files/computer-browse-discovery.js';
import { createHostRoutedComputerSessionDiscoveryCommandRunner } from './computer-discovery-command-runner.js';
import { buildDockerClientProcessEnv } from './docker-client-command.js';
import { createHostRoutedDockerCommandRunner } from './docker-host-command.js';
import { resolvePtcCallbackTransportPolicy } from './ptc-callback-transport-settings.js';
import { resolvePtcArtifactExportPolicy } from './ptc/artifacts/artifact-export-policy-record.js';
import { importPtcLabArtifactWorkspaceFiles } from './ptc/lab/artifacts/lab-artifact-workspace.js';
import {
  createActiveRunStore,
  type ActiveRunStore,
} from './sessions/active-runs.js';
import {
  createLiveRunEventStore,
  type LiveRunEventStore,
} from './sessions/live-run-events.js';
import {
  createRunCheckpointStore,
  type RunCheckpointStore,
} from './sessions/run-checkpoint-store.js';
import {
  createPlanningWorkflowStore,
  type PlanningWorkflowStore,
} from './sessions/planning-workflow-store.js';
import { createGoalStore, type GoalStore } from './sessions/goal-store.js';
import {
  loadThreadIndex,
  upsertThreadSummary,
} from './sessions/threads-index.js';
import {
  createSandboxAttemptStore,
  type SandboxAttemptStore,
} from './sandbox/attempt-store.js';
import {
  createApprovalGrantStore,
  type ApprovalGrantStore,
} from './tools/approval-grants.js';
import { createToolLibraryProjectionPort } from './tools/tool-library-projection.js';
import type {
  ToolLibraryProjectionPort,
  ToolLibraryProjectionTransferPort,
} from './tools/tool-library-projection-port.js';
import type { ToolRegistryStore } from './tools/registry.js';
import { createBuiltinToolRegistryStore } from './tools/builtin/catalog.js';
import {
  createDaemonToolSdkTransport,
  type CreateDaemonToolSdkTransportOptions,
} from './tools/external-tool-sdk-transport.js';
import {
  createSubagentAdmissionController,
  createSubagentLaunchPromotionController,
  resolveSubagentConcurrencyPolicyFromEnv,
  type SubagentConcurrencyPolicy,
} from './agent/subagent-concurrency.js';
import {
  createResourceBudgetProvider,
  type ResourceBudgetProvider,
  type ResourceBudgetSnapshot,
} from './agent/resource-budget-provider.js';
import {
  maybeOffloadToolResult,
  resolveToolOutputProjectionPolicyFromEnv,
} from './agent/tool-output-offload.js';
import {
  createDaemonHostCommandRuntime,
  registerHostCommandActiveSessions,
} from '../command-host/runtime-selection.js';
import {
  buildHostCommandPaths,
  SYSTEM_SESSION_OWNER,
} from './host-command-output-store.js';
import type { HostCommandRuntime } from '../command-host/contract.js';
import { createSubagentRunLauncher } from './agent/subagent-support.js';
import {
  createAgentLoopImplementationAdmission,
  type AgentLoopImplementationAdmission,
} from './agent/loop-implementation-admission.js';
import type {
  AgentRuntimeServices,
  AgentRuntimeSubagentServices,
} from './daemon-runtime-contract.js';
import type {
  SubagentLaunchRequestStore,
  SubagentTerminalDeliveryStore,
} from './subagent-runtime-contracts.js';
import {
  createGlobalMcpRuntime,
  type GlobalMcpRuntime,
} from './mcp/global-mcp-runtime.js';
import { createRunContext } from './run-context.js';
import { runSystemCommand } from './system-command.js';
import { runDetached } from './utils/run-detached.js';

type PtcRuntimeRootResolver = (stateRoot: string) => string;

type PtcBrowserRuntimeOptions = NonNullable<
  Parameters<typeof createPtcBrowserNavigateRuntime>[0]
>;

const resolvePtcFixedProbeRuntimeRoot = createPtcRuntimeRootResolver(
  'fixed-probe-runtime',
);
const resolvePtcExecuteCodeRuntimeRoot = createPtcRuntimeRootResolver(
  'execute-code-runtime',
);
const resolvePtcBrowserNavigateRuntimeRoot = createPtcRuntimeRootResolver(
  'browser-navigate-runtime',
);
const resolvePtcBrowserPageLoadEvidenceRuntimeRoot =
  createPtcRuntimeRootResolver('browser-page-load-evidence-runtime');
const resolvePtcBrowserTextEvidenceRuntimeRoot = createPtcRuntimeRootResolver(
  'browser-text-evidence-runtime',
);
const resolveToolLibraryProjectionPortRoot = createRuntimeRootResolver(
  'tool-library/projections',
);
const TOOL_LIBRARY_SDK_VERSION = 'geulbat-tool-library-sdk-v1';
const TOOL_LIBRARY_SOURCE_REGISTRY_VERSION = 'daemon-builtin-tool-registry-v1';
const TOOL_LIBRARY_RUNTIME_COMPATIBILITY_RANGE =
  PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION;
const TOOL_LIBRARY_MODEL_FACING_CATALOG_REF = 'geulbat-sdk://catalog';
const TOOL_LIBRARY_IMPORT_SPECIFIER = 'geulbat-sdk';
const TOOL_LIBRARY_PTC_REACHABLE_POLICY = Object.freeze({
  policyId: 'ptc_sdk_reachable_read_tools_v1',
});

interface DaemonContextOptions {
  computerSessionId?: string | undefined;
  homeStateRoot?: string | undefined;
  hostCommands?: {
    inlineMaxBytes?: number;
    tailRingBytes?: number;
  };
  bundledCreatorPluginRoot?: string | undefined;
  computerDirectoryPicker?: ComputerDirectoryPicker | undefined;
  subagentConcurrencyPolicy?: SubagentConcurrencyPolicy | undefined;
  subagentLaunchRequests?: SubagentLaunchRequestStore;
  subagentTerminalDeliveries?: SubagentTerminalDeliveryStore;
  providerRequestOptions?: ProviderRequestOptions | undefined;
  reactBundleStructuredOutputIngressPolicy?:
    | ReactBundleStructuredOutputIngressPolicy
    | undefined;
  ptcFixedProbeRuntimeOptions?:
    | CreatePtcFixedEpochProbeRuntimeOptions
    | undefined;
  ptcExecuteCodeRuntimeOptions?: CreatePtcExecuteCodeRuntimeOptions | undefined;
  ptcBrowserPageLoadEvidenceRuntimeOptions?:
    | PtcBrowserRuntimeOptions
    | undefined;
  ptcBrowserTextEvidenceRuntimeOptions?: PtcBrowserRuntimeOptions | undefined;
  ptcBrowserNavigateRuntimeOptions?: PtcBrowserRuntimeOptions | undefined;
  toolLibraryProjectionPort?: ToolLibraryProjectionPort | undefined;
  agentLoopImplementationAdmission?:
    | AgentLoopImplementationAdmission
    | undefined;
}

export interface DaemonContext {
  agent: DaemonAgentContext;
  activeRuns: ActiveRunStore;
  liveRunEvents: LiveRunEventStore;
  runCheckpoints: RunCheckpointStore;
  planningWorkflows: PlanningWorkflowStore;
  goals: GoalStore;
  approvalGrants: ApprovalGrantStore;
  approvalGate: ApprovalGate;
  artifactFrameToolDispatch: (args: {
    threadId: string;
    runId: string;
    workingDirectory: string;
    computerSessionId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    scopeHandle: string;
    frameRequestId: string;
  }) => Promise<ArtifactFrameToolCallResult>;
  backgroundNotifications: BackgroundNotificationQueue;
  childRuns: ChildRunRegistry;
  computerDirectoryPicker: ComputerDirectoryPicker;
  computerSessionId: string;
  computerFileScope?: ComputerFileScope;
  computerFileRoot?: string;
  homeStateRoot: string;
  hostCommands: HostCommandRuntime;
  /** 조립이 호스트를 구성할 때 쓴 inline 결과 예산 — 도구의 페이지 요청 상한이다. */
  hostCommandInlineMaxBytes: number;
  fileStateCache: FileStateCache;
  provider: DaemonProviderContext;
  imageGeneration: ImageGenerationRuntime;
  videoGeneration: VideoGenerationRuntime;
  memoryIndex: MemoryIndexStore;
  globalMcp: GlobalMcpRuntime;
  plugins: PluginStore;
  pluginMarketplaces: PluginMarketplaceStore;
  pluginSkills: PluginSkillRuntime;
  ptc: DaemonPtcContext;
  sandboxAttempts: SandboxAttemptStore;
  subagent: AgentRuntimeSubagentServices;
  threadIndex: AgentRuntimeServices['threadIndex'];
  toolLibraryProjection: ToolLibraryProjectionPort;
  toolLibraryProjectionTransfer: ToolLibraryProjectionTransferPort;
  toolRegistry: ToolRegistryStore;
  createExternalToolSdkTransport<Principal>(
    options: Omit<
      CreateDaemonToolSdkTransportOptions<Principal>,
      'offloadResult' | 'registry'
    >,
  ): ReturnType<typeof createDaemonToolSdkTransport>;
}

export interface DaemonAgentContext {
  loopImplementationAdmission: AgentLoopImplementationAdmission;
  loopMemory: AgentLoopMemoryPort;
  resourceBudgetProvider: ResourceBudgetProvider;
  reactBundleStructuredOutputIngressPolicy: ReactBundleStructuredOutputIngressPolicy;
}

export interface DaemonProviderContext {
  authBootstrap: ProviderAuthBootstrapStore;
  authCallbackServer: ProviderAuthCallbackServerController;
  authRuntime: ProviderAuthRuntimeStore;
  credentialFilePermissionHardener: ProviderAuthFilePermissionHardener;
  nativeWebSearch?: ProviderNativeWebSearchRuntime;
  requestOptions: ProviderRequestOptions;
  webSocketSessions: OwnedResponsesWebSocketSessionStore;
}

export interface DaemonPtcContext {
  browserPageLoadEvidence: ReturnType<
    typeof createPtcBrowserPageLoadEvidenceRuntime
  >;
  browserTextEvidence: ReturnType<typeof createPtcBrowserTextEvidenceRuntime>;
  browserNavigate: ReturnType<typeof createPtcBrowserNavigateRuntime>;
  executeCode: PtcExecuteCodeRuntime;
  packageInstall: PtcPackageInstallRuntime;
  fixedProbe: ReturnType<typeof createPtcFixedEpochProbeRuntime>;
}

function dispatchArtifactFrameToolFromDaemonContext(args: {
  daemonContext: DaemonContext;
  threadId: string;
  runId: string;
  workingDirectory: string;
  computerSessionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  scopeHandle: string;
  frameRequestId: string;
}): Promise<ArtifactFrameToolCallResult> {
  return dispatchArtifactFrameToolCall({
    runtimeServices: args.daemonContext,
    runContext: createRunContext({
      threadId: args.threadId,
      stateRoot: args.daemonContext.homeStateRoot,
      workingDirectory: args.workingDirectory,
    }),
    runId: args.runId,
    approvalContext: {
      computerSessionId: args.computerSessionId,
      permissionMode: 'basic',
    },
    toolName: args.toolName,
    toolArgs: args.toolArgs,
    scopeHandle: args.scopeHandle,
    frameRequestId: args.frameRequestId,
  });
}

export function createDaemonContext(
  options: DaemonContextOptions = {},
): DaemonContext {
  const agentLoopImplementationAdmission =
    options.agentLoopImplementationAdmission ??
    createAgentLoopImplementationAdmission();
  const subagentConcurrencyPolicy = hasExplicitSubagentConcurrencyPolicy(
    options,
  )
    ? options.subagentConcurrencyPolicy
    : resolveSubagentConcurrencyPolicyFromEnv();
  const subagentAdmission = createSubagentAdmissionController(
    subagentConcurrencyPolicy === undefined
      ? {}
      : { policy: subagentConcurrencyPolicy },
  );
  const subagentLaunchRequests = options.subagentLaunchRequests;
  const subagentTerminalDeliveries = options.subagentTerminalDeliveries;
  const subagentLaunchPromotions =
    subagentLaunchRequests === undefined
      ? undefined
      : createSubagentLaunchPromotionController({
          admission: subagentAdmission,
          launchRequests: subagentLaunchRequests,
        });
  const backgroundNotifications = createThreadBackgroundNotificationQueue();
  if (subagentTerminalDeliveries !== undefined) {
    backgroundNotifications.attachDurableStore(subagentTerminalDeliveries);
  }
  const approvalGrants = createApprovalGrantStore();
  const resolvedComputerScope = resolveComputerFileScope();
  const computerFileScope = resolvedComputerScope?.scope;
  const homeStateRoot = options.homeStateRoot ?? resolveHomeStateRoot();
  const sandboxAttempts = createSandboxAttemptStore();
  const hostCommandInlineMaxBytes =
    options.hostCommands?.inlineMaxBytes ??
    resolveToolOutputProjectionPolicyFromEnv().inlineMaxBytes;
  const hostCommands = createDaemonHostCommandRuntime({
    config: {
      inlineMaxBytes: hostCommandInlineMaxBytes,
      ...(options.hostCommands?.tailRingBytes === undefined
        ? {}
        : { tailRingBytes: options.hostCommands.tailRingBytes }),
    },
  });
  // P7.5 §5.6 — 산출물 GC가 보존 집합을 물어볼 지점을 등록한다.
  registerHostCommandActiveSessions(hostCommands);
  const providerAuthFilePermissionHardener: ProviderAuthFilePermissionHardener =
    (targetPath) =>
      hardenProviderAuthFilePermissions(targetPath, {
        runWindowsAclCommand: async (executable, commandArgs) => {
          const result = await runSystemCommand({
            hostCommands,
            stateRoot: homeStateRoot,
            executable,
            args: commandArgs,
            env: process.env,
            maxOutputBytes: hostCommandInlineMaxBytes,
          });
          if (result.status !== 'exit' || result.exitCode !== 0) {
            throw new Error(
              `windows ACL command failed (${result.status}, exit ${String(
                result.exitCode,
              )})`,
            );
          }
        },
      });
  const computerDirectoryPicker =
    options.computerDirectoryPicker ??
    createComputerDirectoryPicker({
      runCommand: async (executable, commandArgs, commandOptions) => {
        const result = await runSystemCommand({
          hostCommands,
          stateRoot: homeStateRoot,
          executable,
          args: commandArgs,
          env: process.env,
          maxOutputBytes: hostCommandInlineMaxBytes,
          ...(commandOptions?.signal === undefined
            ? {}
            : { signal: commandOptions.signal }),
        });
        if (result.status !== 'exit' || result.exitCode !== 0) {
          throw new Error(
            `computer directory picker command failed (${result.status})`,
          );
        }
        return { stdout: result.stdout };
      },
    });
  if (
    computerFileScope !== undefined &&
    resolvedComputerScope?.commandBackedDiscoveryPending === true
  ) {
    // 명령 기반 브라우즈 발견(PowerShell/osascript)은 부팅을 막지 않는
    // 백그라운드 루프가 수행한다 — 성공 시 스코프가 제자리 갱신되고,
    // 실패는 동결되지 않고 재시도된다.
    //
    // P7.6 item 4 — 그 명령은 데몬의 자식이 아니라 command-host 워커의 system
    // 세션에서 돈다. 세션이 사는 곳은 워크스페이스가 아니라 Home state root다 —
    // 발견은 데몬 자신의 일이기 때문이다(MCP·marketplace git과 같은 기준).
    const runDiscoveryCommandAsync =
      createHostRoutedComputerSessionDiscoveryCommandRunner({
        hostCommands,
        stateRoot: homeStateRoot,
        inlineMaxBytes: hostCommandInlineMaxBytes,
      });
    runDetached('files/computer-browse-discovery', () =>
      runComputerBrowseDiscoveryLoop({
        scope: computerFileScope,
        discover: async () => {
          const outcome = await discoverComputerSessionDefaults({
            runDiscoveryCommandAsync,
          });
          const rebuilt = createComputerFileScope({
            root: outcome.defaults.root,
            home: outcome.defaults.home,
            browseLocations: outcome.defaults.browseLocations,
          });
          return {
            browseShortcuts: rebuilt?.browseShortcuts ?? [],
            complete: outcome.complete,
          };
        },
      }),
    );
  }
  const computerFileRoot = computerFileScope?.root;
  const providerAuthBootstrap = createProviderAuthBootstrapStore();
  const providerAuthRuntime = createProviderAuthRuntimeStore({
    hardenPermissions: providerAuthFilePermissionHardener,
  });
  const providerAuthCallbackServer = createProviderAuthCallbackServerController(
    {
      bootstrapStore: providerAuthBootstrap,
      runtimeStore: providerAuthRuntime,
    },
  );
  const providerRequestOptions =
    options.providerRequestOptions ?? resolveProviderRequestOptions();
  const startHostRoutedProviderRequest = createHostRoutedDetachedProcessStarter(
    {
      hostCommands,
      stateRoot: homeStateRoot,
      pageLimitBytes: hostCommandInlineMaxBytes,
      cwd: homeStateRoot,
      env: process.env,
      runId: 'provider-responses',
    },
  );
  const attachHostRoutedProviderRequest =
    createHostRoutedDetachedProcessAttacher({
      hostCommands,
      stateRoot: homeStateRoot,
      pageLimitBytes: hostCommandInlineMaxBytes,
    });
  const durableProviderRequests = createHostRoutedResponsesRequestTransport({
    stateRoot: homeStateRoot,
    startProcess: startHostRoutedProviderRequest,
    attachProcess: attachHostRoutedProviderRequest,
    resolveTerminalArtifactPath: (outputRef) =>
      join(
        buildHostCommandPaths({
          stateRoot: homeStateRoot,
          threadId: SYSTEM_SESSION_OWNER,
          outputRef,
        }).directory,
        'responses-terminal.json',
      ),
  });
  registerHostCommandActiveSessions(durableProviderRequests);
  const providerWebSocketSessions = createResponsesWebSocketSessionStore({
    durableRequestTransport: durableProviderRequests,
  });
  const providerNativeWebSearch = createCodexWebSearchRuntime({
    authRuntime: providerAuthRuntime,
    webSocketSessions: providerWebSocketSessions,
  });
  const provider: DaemonProviderContext = {
    authBootstrap: providerAuthBootstrap,
    authCallbackServer: providerAuthCallbackServer,
    authRuntime: providerAuthRuntime,
    credentialFilePermissionHardener: providerAuthFilePermissionHardener,
    nativeWebSearch: providerNativeWebSearch,
    requestOptions: providerRequestOptions,
    webSocketSessions: providerWebSocketSessions,
  };
  const reactBundleStructuredOutputIngressPolicy =
    options.reactBundleStructuredOutputIngressPolicy ??
    resolveReactBundleStructuredOutputIngressPolicyFromEnv();
  const ptcExecuteCodeRuntimeOptions =
    options.ptcExecuteCodeRuntimeOptions ?? {};
  const resourceBudgetProvider = createResourceBudgetProvider();
  const ptcFixedProbeRuntimeOptions = options.ptcFixedProbeRuntimeOptions ?? {};
  const ptcExecuteCodeCellRuntimeConfig =
    hasExplicitPtcExecuteCodeCellRuntimeConfig(options)
      ? ptcExecuteCodeRuntimeOptions.ptcCell
      : resolvePtcExecuteCodeCellRuntimeConfigFromEnv();
  const ptcPackageInstallConfig = Object.hasOwn(
    ptcExecuteCodeRuntimeOptions,
    'packageInstall',
  )
    ? ptcExecuteCodeRuntimeOptions.packageInstall
    : resolvePtcExecuteCodePackageInstallConfigFromEnv();
  // PTC transition spec v7 §3 (2026-07-27) — 콜백 전송 정책은 환경변수가 이기고,
  // 없으면 운영자가 Settings에서 확정한 Home 레코드를 쓴다. 둘 다 없으면 정책 없이
  // 두어 bridge가 만들어지지 않는다(F003 fail-closed 유지). 호출자가 정책을 명시한
  // 경우(테스트·별도 운영 배선)는 그 값을 건드리지 않는다.
  const ptcCallbackTransportPolicy = Object.hasOwn(
    ptcExecuteCodeRuntimeOptions,
    'callbackTransportPolicy',
  )
    ? undefined
    : resolvePtcCallbackTransportPolicy({ homeStateRoot }).policy;
  // P7.6 item 4 — PTC의 배치 docker 명령(세션 생성·exec·정리·패키지 설치·브라우저
  // 제어·프로브)은 데몬의 자식이 아니라 command-host 워커의 system 세션에서 돈다.
  // 세션이 사는 곳은 Home state root다 — 컨테이너와 산출물은 PTC 자신의 저장소가
  // 소유하고, 여기서 옮기는 것은 docker CLI 자식의 소유권뿐이다.
  //
  // 회수 상한을 주지 않는다: PTC는 docker 출력을 결과로 쓰므로(exec stdout,
  // 컨테이너 id, 설치 로그) 잘린 성공을 받으면 안 된다. retained cell도
  // command-host의 lossless system session이 소유한다. callback token/socket
  // marker는 worker의 출력 ingestion에서 먼저 지워진 뒤에만 링·페이지·artifact로
  // 들어온다. PTC retained-cell 자체에는 데몬 직접 spawn fallback이 없다.
  // 전역 command-host의 명시적 inline 호환 모드는 그 배치 전체의 별도 운영 계약이다.
  const ptcDockerCommandRunner = createHostRoutedDockerCommandRunner({
    hostCommands,
    stateRoot: homeStateRoot,
    pageLimitBytes: hostCommandInlineMaxBytes,
  });
  const startHostRoutedPtcCellProcess = createHostRoutedDetachedProcessStarter({
    hostCommands,
    stateRoot: homeStateRoot,
    pageLimitBytes: hostCommandInlineMaxBytes,
    cwd: homeStateRoot,
    env: buildDockerClientProcessEnv(),
    runId: 'ptc',
  });
  const attachHostRoutedPtcCellProcess =
    createHostRoutedDetachedProcessAttacher({
      hostCommands,
      stateRoot: homeStateRoot,
      pageLimitBytes: hostCommandInlineMaxBytes,
    });
  // PTC owns the callback transport contract; command-host owns only the
  // callback-host child lifetime. Bootstrap secrets travel over non-persisted
  // stdin, while callback payloads use a private direct control socket.
  const startHostRoutedPtcCallbackProcess =
    createHostRoutedDetachedProcessStarter({
      hostCommands,
      stateRoot: homeStateRoot,
      pageLimitBytes: hostCommandInlineMaxBytes,
      cwd: homeStateRoot,
      env: process.env,
      runId: 'ptc-callback',
    });
  const attachHostRoutedPtcCallbackProcess =
    createHostRoutedDetachedProcessAttacher({
      hostCommands,
      stateRoot: homeStateRoot,
      pageLimitBytes: hostCommandInlineMaxBytes,
    });
  const attachHostRoutedPtcEpochCallbackController =
    createPtcExecuteCodeHostRoutedEpochCallbackControllerAttacher({
      attachProcess: attachHostRoutedPtcCallbackProcess,
    });
  const createHostRoutedPtcEpochBridge =
    createPtcExecuteCodeHostRoutedEpochBridge({
      startProcess: startHostRoutedPtcCallbackProcess,
    });
  const ptcExecuteCode = createPtcExecuteCodeRuntime({
    ...ptcExecuteCodeRuntimeOptions,
    ...(ptcCallbackTransportPolicy === undefined
      ? {}
      : { callbackTransportPolicy: ptcCallbackTransportPolicy }),
    artifactExport: ptcExecuteCodeRuntimeOptions.artifactExport ?? {
      resolvePolicy: () =>
        resolvePtcArtifactExportPolicy({ homeStateRoot }).policy,
      importFiles: (args) =>
        importPtcLabArtifactWorkspaceFiles({
          ...args,
          attemptStore: sandboxAttempts,
        }),
    },
    commandRunner:
      ptcExecuteCodeRuntimeOptions.commandRunner ?? ptcDockerCommandRunner,
    createEpochBridge:
      ptcExecuteCodeRuntimeOptions.createEpochBridge ??
      createHostRoutedPtcEpochBridge,
    startCellProcess:
      ptcExecuteCodeRuntimeOptions.startCellProcess ??
      ((invocation) =>
        startHostRoutedPtcCellProcess({
          callId: invocation.cellId,
          executable: invocation.executable,
          args: invocation.args,
          ...(invocation.timeoutMs === undefined
            ? {}
            : { timeoutMs: invocation.timeoutMs }),
          ...(invocation.redactionMarkers === undefined
            ? {}
            : { redactionMarkers: invocation.redactionMarkers }),
          ...(invocation.redactionReplacement === undefined
            ? {}
            : { redactionReplacement: invocation.redactionReplacement }),
          ...(invocation.outputBufferPolicy === undefined
            ? {}
            : { outputBufferPolicy: invocation.outputBufferPolicy }),
        })),
    attachCellProcess:
      ptcExecuteCodeRuntimeOptions.attachCellProcess ??
      attachHostRoutedPtcCellProcess,
    attachEpochCallbackController:
      ptcExecuteCodeRuntimeOptions.attachEpochCallbackController ??
      attachHostRoutedPtcEpochCallbackController,
    cellTerminalResultStore:
      ptcExecuteCodeRuntimeOptions.cellTerminalResultStore ??
      createPtcExecuteCodeCellTerminalResultStore(),
    placementResourceBudgetProvider:
      ptcExecuteCodeRuntimeOptions.placementResourceBudgetProvider ??
      (() =>
        projectPtcExecuteCodePlacementResourceBudget(
          resourceBudgetProvider.captureSnapshot(),
        )),
    ...(ptcExecuteCodeCellRuntimeConfig === undefined
      ? {}
      : { ptcCell: ptcExecuteCodeCellRuntimeConfig }),
    ...(ptcPackageInstallConfig === undefined
      ? {}
      : { packageInstall: ptcPackageInstallConfig }),
    runtimeRootForState:
      ptcExecuteCodeRuntimeOptions.runtimeRootForState ??
      resolvePtcExecuteCodeRuntimeRoot,
  });
  const ptcBrowserPageLoadEvidence = createPtcBrowserPageLoadEvidenceRuntime({
    ...(options.ptcBrowserPageLoadEvidenceRuntimeOptions ?? {}),
    commandRunner:
      options.ptcBrowserPageLoadEvidenceRuntimeOptions?.commandRunner ??
      ptcDockerCommandRunner,
    runtimeRootForState:
      options.ptcBrowserPageLoadEvidenceRuntimeOptions?.runtimeRootForState ??
      resolvePtcBrowserPageLoadEvidenceRuntimeRoot,
  });
  const ptcBrowserTextEvidence = createPtcBrowserTextEvidenceRuntime({
    ...(options.ptcBrowserTextEvidenceRuntimeOptions ?? {}),
    commandRunner:
      options.ptcBrowserTextEvidenceRuntimeOptions?.commandRunner ??
      ptcDockerCommandRunner,
    runtimeRootForState:
      options.ptcBrowserTextEvidenceRuntimeOptions?.runtimeRootForState ??
      resolvePtcBrowserTextEvidenceRuntimeRoot,
  });
  const ptcBrowserNavigate = createPtcBrowserNavigateRuntime({
    ...(options.ptcBrowserNavigateRuntimeOptions ?? {}),
    commandRunner:
      options.ptcBrowserNavigateRuntimeOptions?.commandRunner ??
      ptcDockerCommandRunner,
    runtimeRootForState:
      options.ptcBrowserNavigateRuntimeOptions?.runtimeRootForState ??
      resolvePtcBrowserNavigateRuntimeRoot,
  });
  const ptcFixedProbe = createPtcFixedEpochProbeRuntime({
    ...ptcFixedProbeRuntimeOptions,
    commandRunner:
      ptcFixedProbeRuntimeOptions.commandRunner ?? ptcDockerCommandRunner,
    runtimeRootForState:
      ptcFixedProbeRuntimeOptions.runtimeRootForState ??
      resolvePtcFixedProbeRuntimeRoot,
  });
  const ptc: DaemonPtcContext = {
    browserPageLoadEvidence: ptcBrowserPageLoadEvidence,
    browserTextEvidence: ptcBrowserTextEvidence,
    browserNavigate: ptcBrowserNavigate,
    executeCode: ptcExecuteCode,
    // Same runtime instance on purpose: installs land in the exec session so
    // exec require() reaches them (child spec §5).
    packageInstall: ptcExecuteCode,
    fixedProbe: ptcFixedProbe,
  };
  const toolRegistry = createBuiltinToolRegistryStore({
    includeInstallPackagesTool: ptcPackageInstallConfig?.enabled === true,
  });
  // P7.6 §9 M4 — MCP 서버 프로세스는 command-host 시스템 세션이 소유한다.
  // 데몬의 자식으로 두는 갈래는 없다. 시스템 세션이 사는 곳은 워크스페이스가
  // 아니라 Home state root다 — MCP는 데몬의 것이기 때문이다.
  const globalMcp = createGlobalMcpRuntime({
    homeStateRoot,
    toolRegistry,
    hostCommands,
    maxPageBytes: hostCommandInlineMaxBytes,
  });
  const pluginMarketplaces = createPluginMarketplaceStore({
    homeStateRoot,
    // P7.6 item 3 — marketplace git은 데몬의 자식이 아니라 command-host
    // 시스템 세션에서 돈다. 데몬은 종료코드와 stdout만 값으로 받는다.
    runCommand: async (commandArgs) => {
      const result = await runSystemCommand({
        hostCommands,
        stateRoot: homeStateRoot,
        executable: commandArgs.executable,
        args: commandArgs.args,
        env: commandArgs.env,
        maxOutputBytes: hostCommandInlineMaxBytes,
      });
      return { exitCode: result.exitCode, stdout: result.stdout };
    },
  });
  const pluginStore = createPluginStore({ homeStateRoot });
  const plugins = createMcpCoordinatedPluginStore({ pluginStore, globalMcp });
  const pluginSkills = createBundledPluginSkillRuntime({
    installed: plugins,
    ...(options.bundledCreatorPluginRoot === undefined
      ? {}
      : { packageRoot: options.bundledCreatorPluginRoot }),
  });
  const toolLibraryProjectionTransfer = createToolLibraryProjectionPort({
    registry: toolRegistry,
    runtimeRootForState: resolveToolLibraryProjectionPortRoot,
    sdkVersion: TOOL_LIBRARY_SDK_VERSION,
    sourceRegistryVersion: TOOL_LIBRARY_SOURCE_REGISTRY_VERSION,
    runtimeCompatibilityRange: TOOL_LIBRARY_RUNTIME_COMPATIBILITY_RANGE,
    modelFacingCatalogRef: TOOL_LIBRARY_MODEL_FACING_CATALOG_REF,
    importSpecifier: TOOL_LIBRARY_IMPORT_SPECIFIER,
    projectionPolicy: TOOL_LIBRARY_PTC_REACHABLE_POLICY,
  });
  const toolLibraryProjection =
    options.toolLibraryProjectionPort ?? toolLibraryProjectionTransfer;
  const runCheckpoints = createRunCheckpointStore({
    stateRoot: homeStateRoot,
  });
  const planningWorkflows = createPlanningWorkflowStore({
    stateRoot: homeStateRoot,
  });
  const goals = createGoalStore({
    stateRoot: homeStateRoot,
  });
  const agent: DaemonAgentContext = {
    loopImplementationAdmission: agentLoopImplementationAdmission,
    loopMemory: createAgentLoopMemoryPort(),
    resourceBudgetProvider,
    reactBundleStructuredOutputIngressPolicy,
  };
  const subagent: AgentRuntimeSubagentServices = {
    admission: subagentAdmission,
    ...(subagentLaunchPromotions === undefined
      ? {}
      : { launchPromotions: subagentLaunchPromotions }),
    ...(subagentLaunchRequests === undefined
      ? {}
      : { launchRequests: subagentLaunchRequests }),
    ...(subagentTerminalDeliveries === undefined
      ? {}
      : {
          terminalDeliveries: subagentTerminalDeliveries,
        }),
    runs: createSubagentRunLauncher({
      loopImplementationAdmission: agent.loopImplementationAdmission,
    }),
  };
  const daemonContext: DaemonContext = {
    agent,
    activeRuns: createActiveRunStore(),
    liveRunEvents: createLiveRunEventStore(),
    runCheckpoints,
    planningWorkflows,
    goals,
    approvalGrants,
    approvalGate: createApprovalGate({ approvalGrants, runCheckpoints }),
    artifactFrameToolDispatch: (args) =>
      dispatchArtifactFrameToolFromDaemonContext({
        daemonContext,
        ...args,
      }),
    backgroundNotifications,
    childRuns: createChildRunRegistry(),
    computerDirectoryPicker,
    computerSessionId: options.computerSessionId ?? randomUUID(),
    ...(computerFileScope === undefined ? {} : { computerFileScope }),
    ...(computerFileRoot === undefined ? {} : { computerFileRoot }),
    homeStateRoot,
    hostCommands,
    hostCommandInlineMaxBytes,
    fileStateCache: createFileStateCache(),
    provider,
    imageGeneration: createImageGenerationRuntime({
      providerAuthRuntime: provider.authRuntime,
      providerWebSocketSessions: provider.webSocketSessions,
    }),
    videoGeneration: createVideoGenerationRuntime({
      providerAuthRuntime: provider.authRuntime,
    }),
    globalMcp,
    plugins,
    pluginMarketplaces,
    pluginSkills,
    memoryIndex: createMemoryIndexStore(),
    ptc,
    sandboxAttempts,
    subagent,
    threadIndex: { loadThreadIndex, upsertThreadSummary },
    toolLibraryProjection,
    toolLibraryProjectionTransfer,
    toolRegistry,
    createExternalToolSdkTransport: (transportOptions) =>
      createDaemonToolSdkTransport({
        ...transportOptions,
        offloadResult: async ({ context, input, internalTool, output }) => {
          if (
            context.threadId === undefined ||
            context.runId === undefined ||
            context.stateRoot === undefined
          ) {
            return { ok: true, output };
          }
          const resultProjection =
            toolRegistry.getToolMeta(internalTool)?.resultProjection;
          return maybeOffloadToolResult({
            functionCall: {
              callId: context.callId,
              name: internalTool,
              arguments: JSON.stringify(input),
            },
            runContext: {
              threadId: context.threadId,
              stateRoot: context.stateRoot,
            },
            runId: context.runId,
            ...(resultProjection === undefined ? {} : { resultProjection }),
            toolOutputRecoveryAvailable: true,
            toolResult: { ok: true, output },
          });
        },
        registry: toolRegistry,
      }),
  };
  return daemonContext;
}

export function projectPtcExecuteCodePlacementResourceBudget(
  snapshot: ResourceBudgetSnapshot,
): PtcExecuteCodePlacementResourceBudget {
  const constrainedMemory =
    snapshot.memory.precedence === 'host_os_context_only'
      ? snapshot.memory.hostTotalBytes
      : snapshot.memory.daemonConstrainedMemoryBytes;
  return {
    resourceSnapshotRef: {
      snapshotId: snapshot.snapshotId,
      source: 'agent_resource_budget_provider',
    },
    availableParallelism: projectPtcResourceMeasurement(
      snapshot.cpu.availableParallelism,
    ),
    constrainedMemoryBytes: projectPtcResourceMeasurement(constrainedMemory),
    availableMemoryBytes: projectPtcResourceMeasurement(
      snapshot.memory.daemonAvailableMemoryBytes,
    ),
  };
}

function projectPtcResourceMeasurement(
  measurement: ResourceBudgetSnapshot['cpu']['availableParallelism'],
): PtcExecuteCodePlacementResourceMeasurement {
  return measurement.ok
    ? { ok: true, value: measurement.value }
    : {
        ok: false,
        reasonCode: measurement.reasonCode,
        message: measurement.message,
      };
}

function createPtcRuntimeRootResolver(
  runtimeDirectoryName: string,
): PtcRuntimeRootResolver {
  return createRuntimeRootResolver(`ptc/${runtimeDirectoryName}`);
}

function createRuntimeRootResolver(
  runtimePath: string,
): PtcRuntimeRootResolver {
  return (stateRoot) =>
    joinWorkspaceGeulbatPath(stateRoot, ...runtimePath.split('/'));
}

export function validateDaemonRuntimeKnobsFromEnv(): void {
  resolveSubagentConcurrencyPolicyFromEnv();
  resolveProviderRequestOptions();
  resolveMemoryConsolidationModelFromEnv();
  resolveReactBundleStructuredOutputIngressPolicyFromEnv();
  resolvePtcExecuteCodeCellRuntimeConfigFromEnv();
  resolvePtcExecuteCodeCallbackTransportPolicyFromEnv();
}

function hasExplicitSubagentConcurrencyPolicy(
  options: DaemonContextOptions,
): boolean {
  return Object.hasOwn(options, 'subagentConcurrencyPolicy');
}

function hasExplicitPtcExecuteCodeCellRuntimeConfig(
  options: DaemonContextOptions,
): boolean {
  return (
    options.ptcExecuteCodeRuntimeOptions !== undefined &&
    Object.hasOwn(options.ptcExecuteCodeRuntimeOptions, 'ptcCell')
  );
}

// 컴퓨터 세션 boundary — env가 있으면 env, 없으면 OS별 자동 감지.
// GEULBAT_COMPUTER_SESSION_DISABLED=1 이면 등록하지 않는다.
// 부팅 감지는 외부 명령을 실행하지 않는다(파일시스템 프로브만) — 명령 기반
// 발견은 위의 백그라운드 루프가 비동기로 수행한다. 과거에는 여기서
// PowerShell을 동기로 부르다 타임아웃이 나면 빠른 위치가 데몬 수명 동안
// 비어 버리는 회귀가 반복됐다 (2026-07-23).
function resolveComputerFileScope():
  | { scope: ComputerFileScope; commandBackedDiscoveryPending: boolean }
  | undefined {
  if (process.env['GEULBAT_COMPUTER_SESSION_DISABLED'] === '1') {
    return undefined;
  }
  const envRoot = process.env['GEULBAT_COMPUTER_SESSION_ROOT'];
  const envHome = process.env['GEULBAT_COMPUTER_SESSION_HOME'];
  if (envRoot !== undefined && envRoot.trim() !== '') {
    const scope = createComputerFileScope({ root: envRoot, home: envHome });
    return scope === undefined
      ? undefined
      : { scope, commandBackedDiscoveryPending: false };
  }
  // 부팅은 명령을 실행하지 않는다 — 동기 발견은 이제 구조적으로 명령 없는 경로다
  // (P7.6 item 4). 명령 기반 발견은 아래 백그라운드 루프가 워커 세션에서 수행한다.
  const detected = detectComputerSessionDefaults();
  const scope = createComputerFileScope({
    root: detected.root,
    home: detected.home,
    browseLocations: detected.browseLocations,
  });
  return scope === undefined
    ? undefined
    : { scope, commandBackedDiscoveryPending: true };
}
