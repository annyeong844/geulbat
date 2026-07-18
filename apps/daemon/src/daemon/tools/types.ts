import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { ThreadId } from '@geulbat/protocol/ids';
import type { SideEffectLevel } from '@geulbat/protocol/run-events';
import type { ToolLibraryProjectionIdentity } from '@geulbat/tool-library/projection-codec';
import type { ErrorCode } from '../error-codes.js';
import type { AgentEvent, ToolRunState } from '../runtime-contracts.js';
import type {
  AgentMemoryIndex,
  AgentRuntimeServices,
  ProviderRunSelection,
  RunSubagentModelRouting,
} from '../daemon-runtime-contract.js';
import type { FileStateCache } from '../utils/file-state-cache.js';
import type {
  ParallelToolBatchKind,
  ToolCatalogSearchMetadata,
  ToolExposure,
  ToolParameters,
} from './tool-registry-model.js';

export type { PermissionMode } from '@geulbat/protocol/run-approval';
export type {
  ProviderRunSelection,
  ResolvedChildModelPin,
  RunSubagentModelRouting,
  SubagentRunLauncher,
} from '../daemon-runtime-contract.js';
export {
  isToolAnyOfParameters,
  isToolObjectParameters,
} from './tool-registry-model.js';
export type {
  ParallelToolBatchKind,
  HostToolEffect,
  ToolCatalogSearchFamily,
  ToolCatalogSearchMetadata,
  ToolAnyOfParameters,
  ToolObjectParameters,
  ToolDefinition,
  ToolExposure,
  ToolMeta,
  ToolParameters,
} from './tool-registry-model.js';

interface ToolSelection {
  startLine: number;
  endLine: number;
  text: string;
}

interface ToolExecutionCoreContext {
  callId: string;
  // Per-tool execution signal. The executor may merge the incoming run-level
  // abort signal with a timeout watchdog before passing it to the tool.
  signal?: AbortSignal;
  // Original run-level abort signal, preserved without per-tool timeout merge.
  // Tools that need to distinguish timeout from whole-run cancellation should
  // read this instead of assuming `signal` is the raw caller signal.
  runSignal?: AbortSignal;
  computerFileRoot?: string;
  currentFile?: string;
  selection?: ToolSelection;
}

interface ToolExecutionRunContext {
  approvalGranted?: boolean;
  approvalSessionId?: string;
  allowedRegistryNames?: readonly string[];
  permissionMode?: PermissionMode;
  threadId?: ThreadId;
  runId?: string;
  runOwnerKind?: 'root_main' | 'child';
  stateRoot?: string;
  workingDirectory?: string;
  runState?: ToolRunState;
  resourceSnapshotRef?: ToolExecutionResourceSnapshotRef;
  toolLibraryProjectionIdentity?: ToolLibraryProjectionIdentity;
  // Exact provider identity of the run executing this tool. Child routing
  // inherits it only when neither the user nor the model selects another model.
  providerRunSelection?: ProviderRunSelection;
  subagentModelRouting?: RunSubagentModelRouting;
  emitAgentEvent?: (event: AgentEvent) => void;
}

export interface ToolExecutionResourceSnapshotRef {
  snapshotId: string;
}

interface ToolExecutionServices {
  fileStateCache?: FileStateCache;
  memoryIndex?: AgentMemoryIndex;
  agentSpawnRuntime?: AgentRuntimeServices;
  callbackToolDispatcher?: CallbackToolDispatcher;
}

export type StandaloneToolExecutionContext = ToolExecutionCoreContext &
  ToolExecutionRunContext &
  ToolExecutionServices & {
    kind?: 'standalone';
  };

// Agent loop callers already know these invariants when dispatching a tool.
// Keep standalone/local callers on the looser context, but spell the
// agent-backed execution contract directly so call sites can narrow to one
// runtime shape instead of rebuilding a partially-optional bag.
export type AgentToolExecutionContext = Omit<
  ToolExecutionCoreContext,
  'signal' | 'runSignal' | 'currentFile' | 'selection'
> &
  Omit<ToolExecutionServices, 'memoryIndex' | 'agentSpawnRuntime'> & {
    kind: 'agent';
    signal: AbortSignal | undefined;
    runSignal: AbortSignal | undefined;
    currentFile: string | undefined;
    selection: ToolSelection | undefined;
    approvalGranted: boolean;
    approvalSessionId: string;
    allowedRegistryNames?: readonly string[];
    permissionMode: PermissionMode;
    threadId: ThreadId;
    runId: string;
    runOwnerKind: 'root_main' | 'child';
    stateRoot: string;
    workingDirectory: string;
    runState: ToolRunState | undefined;
    resourceSnapshotRef?: ToolExecutionResourceSnapshotRef;
    toolLibraryProjectionIdentity?: ToolLibraryProjectionIdentity;
    providerRunSelection?: ProviderRunSelection;
    subagentModelRouting?: RunSubagentModelRouting;
    emitAgentEvent: (event: AgentEvent) => void;
    memoryIndex: AgentMemoryIndex | undefined;
    agentSpawnRuntime: AgentRuntimeServices | undefined;
  };

export type ToolExecutionContext =
  | StandaloneToolExecutionContext
  | AgentToolExecutionContext;

export type AgentToolExecutionContextBase = Omit<
  AgentToolExecutionContext,
  'callId' | 'approvalGranted'
>;

export function buildAgentToolExecutionContext(args: {
  base: AgentToolExecutionContextBase;
  callId: string;
  approvalGranted: boolean;
  resourceSnapshotRef?: ToolExecutionResourceSnapshotRef;
}): AgentToolExecutionContext {
  const { base, callId, approvalGranted } = args;
  return {
    ...base,
    kind: 'agent',
    callId,
    approvalGranted,
    ...(args.resourceSnapshotRef === undefined
      ? {}
      : { resourceSnapshotRef: args.resourceSnapshotRef }),
  };
}

export function isAgentToolExecutionContext(
  value: ToolExecutionContext,
): value is AgentToolExecutionContext {
  return value.kind === 'agent';
}

export type ExecuteResult =
  | { ok: true; output: string; errorCode?: undefined; error?: undefined }
  | { ok: false; output: string; errorCode: ErrorCode; error: string };

export interface CallbackToolDispatcher {
  dispatch(args: {
    toolName: string;
    args: Record<string, unknown>;
    runtimeToolCallId: string;
    cellId?: string;
    signal: AbortSignal;
  }): Promise<ExecuteResult>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: ToolParameters;
  strict: boolean;
  sideEffectLevel: SideEffectLevel;
  mayMutateComputerFiles: boolean;
  parallelBatchKind?: ParallelToolBatchKind;
  timeoutMs?: number;
  requiresApproval: boolean;
  // The registry supplies a conservative direct-only value when a local or
  // test tool has not opted into the SDK/callback routing contract.
  exposure?: ToolExposure;
  // 도구 인자 스트리밍 opt-in — provider args 델타가 tool_call_delta로
  // 클라이언트까지 흐른다 (visualize 실시간 렌더)
  streamsArgsDelta?: boolean;
  catalogSearchMetadata?: ToolCatalogSearchMetadata;
}

export interface ToolParseFailure {
  ok: false;
  // user-displayable and sanitized; parser internals must not leak here.
  message: string;
}

interface ToolParseSuccess<TArgs extends object> {
  ok: true;
  value: TArgs;
}

export type ToolParseResult<TArgs extends object> =
  | ToolParseFailure
  | ToolParseSuccess<TArgs>;

export interface Tool<TArgs extends object> extends ToolDescriptor {
  parseArgs(raw: unknown): ToolParseResult<TArgs>;
  executeParsed(args: TArgs, ctx: ToolExecutionContext): Promise<ExecuteResult>;
}

// Registry / executor intentionally erase the exact parsed-args type.
export interface AnyTool extends ToolDescriptor {
  parseArgs(raw: unknown): ToolParseResult<object>;
  executeParsed(
    args: object,
    ctx: ToolExecutionContext,
  ): Promise<ExecuteResult>;
}

// Direct raw execution is retained only as a thin compatibility adapter for
// tests and local callers that still invoke builtin tools directly.
export interface RawExecutableTool<TArgs extends object> extends Tool<TArgs> {
  execute(raw: unknown, ctx: ToolExecutionContext): Promise<ExecuteResult>;
}
