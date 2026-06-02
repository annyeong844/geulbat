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
} from './llm/provider/transport/responses-websocket-session.js';
import {
  resolveProviderRequestOptions,
  type ProviderRequestOptions,
} from './llm/provider/provider-options.js';
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
import { createSubagentRunLauncher } from './agent/subagent-support.js';
import type { SubagentRunLauncher } from './daemon-runtime-contract.js';

interface DaemonContextOptions {
  subagentConcurrencyPolicy?: SubagentConcurrencyPolicy | undefined;
  providerRequestOptions?: ProviderRequestOptions | undefined;
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
  projectRegistry: ProjectRegistryStore;
  projectStore: ProjectStore;
  memoryIndex: MemoryIndexStore;
  providerWebSocketSessions: ResponsesWebSocketSessionStore;
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
    projectRegistry,
    projectStore: createProjectStore({ projectRegistry }),
    memoryIndex: createMemoryIndexStore(),
    providerWebSocketSessions: createResponsesWebSocketSessionStore(),
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

export function validateDaemonRuntimeKnobsFromEnv(): void {
  resolveSubagentConcurrencyPolicyFromEnv();
  resolveProviderRequestOptions();
}

function hasExplicitSubagentConcurrencyPolicy(
  options: DaemonContextOptions,
): boolean {
  return Object.prototype.hasOwnProperty.call(
    options,
    'subagentConcurrencyPolicy',
  );
}
