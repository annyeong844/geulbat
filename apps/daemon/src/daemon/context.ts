import {
  createApprovalGate,
  type ApprovalGate,
} from './agent/runtime/approval-gate.js';
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
  createProjectRegistryStore,
  type ProjectRegistryStore,
} from './files/project-registry-state.js';
import {
  createProjectStore,
  type ProjectStore,
} from './files/project-store.js';
import { joinWorkspaceGeulbatPath } from './files/geulbat-internal-paths.js';
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
  type CreatePtcExecuteCodeRuntimeOptions,
} from './ptc/runtime/execute-code/execute-code-runtime.js';
import { createPtcBrowserPageLoadEvidenceRuntime } from './ptc/runtime/browser/browser-page-load-evidence-runtime.js';
import { createPtcBrowserTextEvidenceRuntime } from './ptc/runtime/browser/browser-text-evidence-runtime.js';
import { createPtcBrowserNavigateRuntime } from './ptc/runtime/browser/browser-navigate-runtime.js';
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
import { type ToolRegistryStore } from './tools/registry.js';
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

type PtcRuntimeRootResolver = (workspaceRoot: string) => string;

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

interface DaemonContextOptions {
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
}

export interface DaemonContext {
  activeRuns: ActiveRunStore;
  approvalGrants: ApprovalGrantStore;
  approvalGate: ApprovalGate;
  backgroundNotifications: BackgroundNotificationQueue;
  childRuns: ChildRunRegistry;
  fileStateCache: FileStateCache;
  providerAuthBootstrap: ProviderAuthBootstrapStore;
  providerAuthCallbackServer: ProviderAuthCallbackServerController;
  providerAuthRuntime: ProviderAuthRuntimeStore;
  providerRequestOptions: ProviderRequestOptions;
  reactBundleStructuredOutputIngressPolicy: ReactBundleStructuredOutputIngressPolicy;
  projectRegistry: ProjectRegistryStore;
  projectStore: ProjectStore;
  agentWorkflowRunner: AgentWorkflowRunner;
  agentWavePlanner: AgentWavePlanner;
  memoryIndex: MemoryIndexStore;
  providerWebSocketSessions: ResponsesWebSocketSessionStore;
  resourceBudgetProvider: ResourceBudgetProvider;
  ptcBrowserPageLoadEvidence: ReturnType<
    typeof createPtcBrowserPageLoadEvidenceRuntime
  >;
  ptcBrowserTextEvidence: ReturnType<
    typeof createPtcBrowserTextEvidenceRuntime
  >;
  ptcBrowserNavigate: ReturnType<typeof createPtcBrowserNavigateRuntime>;
  ptcExecuteCode: ReturnType<typeof createPtcExecuteCodeRuntime>;
  ptcFixedProbe: ReturnType<typeof createPtcFixedEpochProbeRuntime>;
  sandboxAttempts: SandboxAttemptStore;
  subagentAdmission: SubagentAdmissionController;
  subagentRuns: SubagentRunLauncher;
  toolRegistry: ToolRegistryStore;
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
  const projectRegistry = createProjectRegistryStore();
  const providerAuthBootstrap = createProviderAuthBootstrapStore();
  const providerAuthRuntime = createProviderAuthRuntimeStore();
  const providerRequestOptions =
    options.providerRequestOptions ?? resolveProviderRequestOptions();
  const reactBundleStructuredOutputIngressPolicy =
    options.reactBundleStructuredOutputIngressPolicy ??
    resolveReactBundleStructuredOutputIngressPolicyFromEnv();
  const ptcExecuteCodeRuntimeOptions =
    options.ptcExecuteCodeRuntimeOptions ?? {};
  const ptcFixedProbeRuntimeOptions = options.ptcFixedProbeRuntimeOptions ?? {};
  const ptcExecuteCodeCellRuntimeConfig =
    hasExplicitPtcExecuteCodeCellRuntimeConfig(options)
      ? ptcExecuteCodeRuntimeOptions.ptcCell
      : resolvePtcExecuteCodeCellRuntimeConfigFromEnv();
  const agentWavePlanner = createAgentWavePlanner();
  const resourceBudgetProvider = createResourceBudgetProvider();
  return {
    activeRuns: createActiveRunStore(),
    approvalGrants,
    approvalGate: createApprovalGate({ approvalGrants }),
    backgroundNotifications: createThreadBackgroundNotificationQueue(),
    childRuns: createChildRunRegistry(),
    fileStateCache: createFileStateCache(),
    providerAuthBootstrap,
    providerAuthCallbackServer: createProviderAuthCallbackServerController({
      bootstrapStore: providerAuthBootstrap,
      runtimeStore: providerAuthRuntime,
    }),
    providerAuthRuntime,
    providerRequestOptions,
    reactBundleStructuredOutputIngressPolicy,
    projectRegistry,
    projectStore: createProjectStore({ projectRegistry }),
    agentWorkflowRunner: createAgentWorkflowRunner({
      agentWavePlanner,
      resourceBudgetProvider,
    }),
    agentWavePlanner,
    memoryIndex: createMemoryIndexStore(),
    providerWebSocketSessions: createResponsesWebSocketSessionStore(),
    resourceBudgetProvider,
    ptcBrowserPageLoadEvidence: createPtcBrowserPageLoadEvidenceRuntime({
      ...(options.ptcBrowserPageLoadEvidenceRuntimeOptions ?? {}),
      runtimeRootForWorkspace:
        options.ptcBrowserPageLoadEvidenceRuntimeOptions
          ?.runtimeRootForWorkspace ??
        resolvePtcBrowserPageLoadEvidenceRuntimeRoot,
    }),
    ptcBrowserTextEvidence: createPtcBrowserTextEvidenceRuntime({
      ...(options.ptcBrowserTextEvidenceRuntimeOptions ?? {}),
      runtimeRootForWorkspace:
        options.ptcBrowserTextEvidenceRuntimeOptions?.runtimeRootForWorkspace ??
        resolvePtcBrowserTextEvidenceRuntimeRoot,
    }),
    ptcBrowserNavigate: createPtcBrowserNavigateRuntime({
      ...(options.ptcBrowserNavigateRuntimeOptions ?? {}),
      runtimeRootForWorkspace:
        options.ptcBrowserNavigateRuntimeOptions?.runtimeRootForWorkspace ??
        resolvePtcBrowserNavigateRuntimeRoot,
    }),
    ptcExecuteCode: createPtcExecuteCodeRuntime({
      ...ptcExecuteCodeRuntimeOptions,
      ...(ptcExecuteCodeCellRuntimeConfig === undefined
        ? {}
        : { ptcCell: ptcExecuteCodeCellRuntimeConfig }),
      runtimeRootForWorkspace:
        ptcExecuteCodeRuntimeOptions.runtimeRootForWorkspace ??
        resolvePtcExecuteCodeRuntimeRoot,
    }),
    ptcFixedProbe: createPtcFixedEpochProbeRuntime({
      ...ptcFixedProbeRuntimeOptions,
      runtimeRootForWorkspace:
        ptcFixedProbeRuntimeOptions.runtimeRootForWorkspace ??
        resolvePtcFixedProbeRuntimeRoot,
    }),
    sandboxAttempts: createSandboxAttemptStore(),
    subagentAdmission: createSubagentAdmissionController(
      subagentConcurrencyPolicy === undefined
        ? {}
        : { policy: subagentConcurrencyPolicy },
    ),
    subagentRuns: createSubagentRunLauncher(),
    toolRegistry: createBuiltinToolRegistryStore(),
  };
}

function createPtcRuntimeRootResolver(
  runtimeDirectoryName: string,
): PtcRuntimeRootResolver {
  return (workspaceRoot) =>
    joinWorkspaceGeulbatPath(workspaceRoot, 'ptc', runtimeDirectoryName);
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
  return Object.prototype.hasOwnProperty.call(
    options,
    'subagentConcurrencyPolicy',
  );
}

function hasExplicitPtcExecuteCodeCellRuntimeConfig(
  options: DaemonContextOptions,
): boolean {
  return (
    options.ptcExecuteCodeRuntimeOptions !== undefined &&
    Object.prototype.hasOwnProperty.call(
      options.ptcExecuteCodeRuntimeOptions,
      'ptcCell',
    )
  );
}
