import {
  createApprovalGate,
  type ApprovalGate,
} from './agent/runtime/approval-gate.js';
import {
  dispatchArtifactFrameToolCall,
  type ArtifactFrameToolCallResult,
} from './agent/artifact-frame-tool-dispatcher.js';
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
  createComputerFileScope,
  type ComputerFileScope,
} from './files/computer-file-scope.js';
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
  type ResponsesWebSocketSessionStore,
} from './llm/provider/transport/responses-websocket-cache.js';
import {
  resolveProviderRequestOptions,
  type ProviderRequestOptions,
} from './llm/provider/provider-options.js';
import {
  resolveReactBundleStructuredOutputIngressPolicyFromEnv,
  type ReactBundleStructuredOutputIngressPolicy,
} from './agent/react-bundle-structured-output-ingress-policy.js';
import {
  createPtcFixedEpochProbeRuntime,
  type CreatePtcFixedEpochProbeRuntimeOptions,
} from './ptc/runtime/probes/fixed-probe-runtime.js';
import {
  createPtcExecuteCodeRuntime,
  resolvePtcExecuteCodeCallbackTransportPolicyFromEnv,
  resolvePtcExecuteCodeCellRuntimeConfigFromEnv,
  resolvePtcExecuteCodePackageInstallConfigFromEnv,
  type CreatePtcExecuteCodeRuntimeOptions,
} from './ptc/runtime/execute-code/execute-code-runtime.js';
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
import { detectComputerSessionDefaults } from './files/computer-session-defaults.js';
import {
  createActiveRunStore,
  type ActiveRunStore,
} from './sessions/active-runs.js';
import {
  createSandboxAttemptStore,
  type SandboxAttemptStore,
} from './sandbox/attempt-store.js';
import {
  createApprovalGrantStore,
  type ApprovalGrantStore,
} from './tools/approval-grants.js';
import { createToolLibraryProjectionPort } from './tools/tool-library-projection.js';
import type { ToolLibraryProjectionPort } from './tools/tool-library-projection-port.js';
import type { ToolRegistryStore } from './tools/registry.js';
import { createBuiltinToolRegistryStore } from './tools/builtin/catalog.js';
import {
  createSubagentAdmissionController,
  resolveSubagentConcurrencyPolicyFromEnv,
  type SubagentConcurrencyPolicy,
  type SubagentAdmissionController,
} from './agent/subagent-concurrency.js';
import {
  createResourceBudgetProvider,
  type ResourceBudgetProvider,
  type ResourceBudgetSnapshot,
} from './agent/resource-budget-provider.js';
import {
  createAgentWavePlanner,
  type AgentWavePlanner,
} from './agent/agent-wave-planner.js';
import {
  createAgentWorkflowRunner,
  type AgentWorkflowRunner,
} from './agent/agent-workflow-runner.js';
import { createSubagentRunLauncher } from './agent/subagent-support.js';
import type { SubagentRunLauncher } from './daemon-runtime-contract.js';
import {
  createGlobalMcpRuntime,
  type GlobalMcpRuntime,
} from './mcp/global-mcp-runtime.js';
import { createRunContext } from './run-context.js';

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
  homeStateRoot?: string | undefined;
  subagentConcurrencyPolicy?: SubagentConcurrencyPolicy | undefined;
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
}

export interface DaemonContext {
  activeRuns: ActiveRunStore;
  approvalGrants: ApprovalGrantStore;
  approvalGate: ApprovalGate;
  artifactFrameToolDispatch: (args: {
    threadId: string;
    runId: string;
    workingDirectory: string;
    approvalSessionId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    scopeHandle: string;
    frameRequestId: string;
  }) => Promise<ArtifactFrameToolCallResult>;
  backgroundNotifications: BackgroundNotificationQueue;
  childRuns: ChildRunRegistry;
  computerFileScope?: ComputerFileScope;
  computerFileRoot?: string;
  homeStateRoot: string;
  fileStateCache: FileStateCache;
  providerAuthBootstrap: ProviderAuthBootstrapStore;
  providerAuthCallbackServer: ProviderAuthCallbackServerController;
  providerAuthRuntime: ProviderAuthRuntimeStore;
  providerRequestOptions: ProviderRequestOptions;
  reactBundleStructuredOutputIngressPolicy: ReactBundleStructuredOutputIngressPolicy;
  agentWorkflowRunner: AgentWorkflowRunner;
  agentWavePlanner: AgentWavePlanner;
  imageGeneration: ImageGenerationRuntime;
  videoGeneration: VideoGenerationRuntime;
  memoryIndex: MemoryIndexStore;
  globalMcp: GlobalMcpRuntime;
  plugins: PluginStore;
  pluginMarketplaces: PluginMarketplaceStore;
  pluginSkills: PluginSkillRuntime;
  providerWebSocketSessions: ResponsesWebSocketSessionStore;
  resourceBudgetProvider: ResourceBudgetProvider;
  ptcBrowserPageLoadEvidence: ReturnType<
    typeof createPtcBrowserPageLoadEvidenceRuntime
  >;
  ptcBrowserTextEvidence: ReturnType<
    typeof createPtcBrowserTextEvidenceRuntime
  >;
  ptcBrowserNavigate: ReturnType<typeof createPtcBrowserNavigateRuntime>;
  ptcExecuteCode: PtcExecuteCodeRuntime;
  ptcPackageInstall: PtcPackageInstallRuntime;
  ptcFixedProbe: ReturnType<typeof createPtcFixedEpochProbeRuntime>;
  sandboxAttempts: SandboxAttemptStore;
  subagentAdmission: SubagentAdmissionController;
  subagentRuns: SubagentRunLauncher;
  toolLibraryProjection: ToolLibraryProjectionPort;
  toolRegistry: ToolRegistryStore;
}

function dispatchArtifactFrameToolFromDaemonContext(args: {
  daemonContext: DaemonContext;
  threadId: string;
  runId: string;
  workingDirectory: string;
  approvalSessionId: string;
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
      sessionId: args.approvalSessionId,
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
  const subagentConcurrencyPolicy = hasExplicitSubagentConcurrencyPolicy(
    options,
  )
    ? options.subagentConcurrencyPolicy
    : resolveSubagentConcurrencyPolicyFromEnv();
  const approvalGrants = createApprovalGrantStore();
  const computerFileScope = resolveComputerFileScope();
  const homeStateRoot = options.homeStateRoot ?? resolveHomeStateRoot();
  const computerFileRoot = computerFileScope?.root;
  const providerAuthBootstrap = createProviderAuthBootstrapStore();
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  const providerRequestOptions =
    options.providerRequestOptions ?? resolveProviderRequestOptions();
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
  const ptcExecuteCode = createPtcExecuteCodeRuntime({
    ...ptcExecuteCodeRuntimeOptions,
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
  const agentWavePlanner = createAgentWavePlanner();
  const providerWebSocketSessions = createResponsesWebSocketSessionStore();
  const toolRegistry = createBuiltinToolRegistryStore({
    includeInstallPackagesTool: ptcPackageInstallConfig?.enabled === true,
  });
  const globalMcp = createGlobalMcpRuntime({
    homeStateRoot,
    toolRegistry,
  });
  const pluginMarketplaces = createPluginMarketplaceStore({ homeStateRoot });
  const pluginStore = createPluginStore({ homeStateRoot });
  const plugins = createMcpCoordinatedPluginStore({ pluginStore, globalMcp });
  const pluginSkills = createBundledPluginSkillRuntime({
    installed: plugins,
  });
  const toolLibraryProjection =
    options.toolLibraryProjectionPort ??
    createToolLibraryProjectionPort({
      registry: toolRegistry,
      runtimeRootForState: resolveToolLibraryProjectionPortRoot,
      sdkVersion: TOOL_LIBRARY_SDK_VERSION,
      sourceRegistryVersion: TOOL_LIBRARY_SOURCE_REGISTRY_VERSION,
      runtimeCompatibilityRange: TOOL_LIBRARY_RUNTIME_COMPATIBILITY_RANGE,
      modelFacingCatalogRef: TOOL_LIBRARY_MODEL_FACING_CATALOG_REF,
      importSpecifier: TOOL_LIBRARY_IMPORT_SPECIFIER,
      projectionPolicy: TOOL_LIBRARY_PTC_REACHABLE_POLICY,
    });
  const daemonContext: DaemonContext = {
    activeRuns: createActiveRunStore(),
    approvalGrants,
    approvalGate: createApprovalGate({ approvalGrants }),
    artifactFrameToolDispatch: (args) =>
      dispatchArtifactFrameToolFromDaemonContext({
        daemonContext,
        ...args,
      }),
    backgroundNotifications: createThreadBackgroundNotificationQueue(),
    childRuns: createChildRunRegistry(),
    ...(computerFileScope === undefined ? {} : { computerFileScope }),
    ...(computerFileRoot === undefined ? {} : { computerFileRoot }),
    homeStateRoot,
    fileStateCache: createFileStateCache(),
    providerAuthBootstrap,
    providerAuthCallbackServer: createProviderAuthCallbackServerController({
      bootstrapStore: providerAuthBootstrap,
      runtimeStore: providerAuthRuntime,
    }),
    providerAuthRuntime,
    providerRequestOptions,
    reactBundleStructuredOutputIngressPolicy,
    agentWorkflowRunner: createAgentWorkflowRunner({
      agentWavePlanner,
      resourceBudgetProvider,
    }),
    agentWavePlanner,
    imageGeneration: createImageGenerationRuntime({
      providerAuthRuntime,
      providerWebSocketSessions,
    }),
    videoGeneration: createVideoGenerationRuntime({
      providerAuthRuntime,
    }),
    globalMcp,
    plugins,
    pluginMarketplaces,
    pluginSkills,
    memoryIndex: createMemoryIndexStore(),
    providerWebSocketSessions,
    resourceBudgetProvider,
    ptcBrowserPageLoadEvidence: createPtcBrowserPageLoadEvidenceRuntime({
      ...(options.ptcBrowserPageLoadEvidenceRuntimeOptions ?? {}),
      runtimeRootForState:
        options.ptcBrowserPageLoadEvidenceRuntimeOptions?.runtimeRootForState ??
        resolvePtcBrowserPageLoadEvidenceRuntimeRoot,
    }),
    ptcBrowserTextEvidence: createPtcBrowserTextEvidenceRuntime({
      ...(options.ptcBrowserTextEvidenceRuntimeOptions ?? {}),
      runtimeRootForState:
        options.ptcBrowserTextEvidenceRuntimeOptions?.runtimeRootForState ??
        resolvePtcBrowserTextEvidenceRuntimeRoot,
    }),
    ptcBrowserNavigate: createPtcBrowserNavigateRuntime({
      ...(options.ptcBrowserNavigateRuntimeOptions ?? {}),
      runtimeRootForState:
        options.ptcBrowserNavigateRuntimeOptions?.runtimeRootForState ??
        resolvePtcBrowserNavigateRuntimeRoot,
    }),
    ptcExecuteCode,
    // Same runtime instance on purpose: installs land in the exec session so
    // exec require() reaches them (child spec §5).
    ptcPackageInstall: ptcExecuteCode,
    ptcFixedProbe: createPtcFixedEpochProbeRuntime({
      ...ptcFixedProbeRuntimeOptions,
      runtimeRootForState:
        ptcFixedProbeRuntimeOptions.runtimeRootForState ??
        resolvePtcFixedProbeRuntimeRoot,
    }),
    sandboxAttempts: createSandboxAttemptStore(),
    subagentAdmission: createSubagentAdmissionController(
      subagentConcurrencyPolicy === undefined
        ? {}
        : { policy: subagentConcurrencyPolicy },
    ),
    subagentRuns: createSubagentRunLauncher(),
    toolLibraryProjection,
    toolRegistry,
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
function resolveComputerFileScope(): ComputerFileScope | undefined {
  if (process.env['GEULBAT_COMPUTER_SESSION_DISABLED'] === '1') {
    return undefined;
  }
  const envRoot = process.env['GEULBAT_COMPUTER_SESSION_ROOT'];
  const envHome = process.env['GEULBAT_COMPUTER_SESSION_HOME'];
  if (envRoot !== undefined && envRoot.trim() !== '') {
    return createComputerFileScope({ root: envRoot, home: envHome });
  }
  const detected = detectComputerSessionDefaults();
  return createComputerFileScope({ root: detected.root, home: detected.home });
}
