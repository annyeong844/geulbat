import type { PermissionMode, ThreadId } from './contract.js';
import type { AgentEvent } from './events.js';
import type { RunState } from './runtime/run-state.js';
import type { CallModelInput, LLMChunk } from '../llm/index.js';
import type { RunWorkspaceContext } from '../run-workspace-context.js';
import type { AgentRuntimeServices } from '../daemon-runtime-contract.js';

export interface LineSelection {
  startLine: number;
  endLine: number;
  text: string;
}

export interface ApprovalContext {
  sessionId: string;
  permissionMode: PermissionMode;
  ownerRunId?: string;
  ownerThreadId?: ThreadId;
}

export type CallModelFn = (input: CallModelInput) => AsyncGenerator<LLMChunk>;

export interface AgentInput {
  runId: string;
  runContext: RunWorkspaceContext;
  prompt: string;
  currentFile?: string;
  selection?: LineSelection;
  signal?: AbortSignal;
  runState?: RunState;
  allowedToolNames?: string[];
  // Runtime services flow through one narrow path so agent/tool layers do not
  // depend on the full daemon context shape.
  runtimeServices: AgentRuntimeServices;
  approvalContext: ApprovalContext;
  callModelImpl?: CallModelFn;
  onEvent: (event: AgentEvent) => void;
}
