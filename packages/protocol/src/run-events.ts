import {
  isApiError,
  isErrorCode,
  type ApiError,
  type ErrorCode,
} from './errors.js';
import { isRunId, isThreadId, type RunId, type ThreadId } from './ids.js';
import { isApprovalRequired, type ApprovalRequired } from './run-approval.js';
import type { RunAck } from './run-contract.js';
import { isBoolean, isNumber, isRecord, isString } from './runtime-utils.js';
import {
  isSideEffectLevel,
  SIDE_EFFECT_LEVELS,
  type SideEffectLevel,
} from './side-effect-level.js';
import {
  isThreadArtifactVersion,
  type ThreadArtifactVersion,
} from './artifacts.js';
import {
  isThreadDetailResponse,
  type ThreadDetailResponse,
} from './threads.js';

export { SIDE_EFFECT_LEVELS, isSideEffectLevel };
export type { SideEffectLevel };

export type RunEventType =
  | 'run_ack'
  | 'commentary_delta'
  | 'tool_call'
  | 'tool_result'
  | 'subagent_spawned'
  | 'subagent_terminal'
  | 'subagent_approval_required'
  | 'approval_required'
  | 'final_answer_delta'
  | 'artifact_committed'
  | 'thread_state_persisted'
  | 'thread_state_persist_failed'
  | 'done'
  | 'error';

export type RunAckEventPayload = RunAck;

export interface TextDeltaEventPayload {
  text: string;
}

export interface ToolCallEventPayload {
  callId: string;
  step: number;
  tool: string;
  args: Record<string, unknown>;
}

export const SUBAGENT_TYPES = ['explorer', 'worker'] as const;
export type SubagentType = (typeof SUBAGENT_TYPES)[number];

export interface AgentLaunchAckToolRaw {
  ok: true;
  childRunId: string;
  childThreadId: string;
  subagentType: SubagentType;
  launchState: 'started';
}

export interface AgentLaunchRejectedToolRaw {
  ok: false;
  launchState: 'rejected';
  subagentType: SubagentType;
  errorCode:
    | 'too_many_child_runs'
    | 'unsupported_nested_spawn'
    | 'invalid_args'
    | 'execution_failed';
  error: string;
  effectiveMax?: number;
}

export type AgentLaunchToolRaw =
  | AgentLaunchAckToolRaw
  | AgentLaunchRejectedToolRaw;

export type AgentChildTerminalState = 'completed' | 'failed' | 'cancelled';

export type AgentChildTerminalReason =
  | 'child_error'
  | 'timeout'
  | 'user_interrupt'
  | 'sibling_error'
  | 'explicit_stop';

export interface AgentWaitToolRaw {
  ok: true;
  completed: Array<{
    childRunId: string;
    terminalState: AgentChildTerminalState;
    ok: boolean;
    reason?: AgentChildTerminalReason;
    result: string;
  }>;
  pending: string[];
  blocked: Array<{
    childRunId: string;
    blockedReason: 'approval_pending';
  }>;
}

export type AgentStopToolRaw =
  | {
      ok: true;
      childRunId: string;
      stopState: 'stopping';
    }
  | {
      ok: true;
      childRunId: string;
      stopState: 'already_terminal';
    };

export interface ToolResultRawMap {
  agent_spawn: AgentLaunchToolRaw;
  agent_send_input: AgentLaunchToolRaw;
  agent_wait: AgentWaitToolRaw;
  agent_stop: AgentStopToolRaw;
}

export type KnownToolResultRawTool = keyof ToolResultRawMap;

export type KnownToolResultRaw<TTool extends KnownToolResultRawTool> =
  ToolResultRawMap[TTool];

export type UnknownToolResultRaw = unknown;

export type ToolResultRaw<TTool extends string> =
  TTool extends KnownToolResultRawTool
    ? KnownToolResultRaw<TTool>
    : UnknownToolResultRaw;

type ToolResultRawGuardMap = {
  [K in KnownToolResultRawTool]: (
    value: unknown,
  ) => value is ToolResultRawMap[K];
};

interface ToolResultEventPayloadBase<TTool extends string> {
  callId: string;
  step: number;
  tool: TTool;
  workspaceFilesMayHaveChanged: boolean;
  displayText: string;
}

export type KnownToolResultSuccessEventPayload<
  TTool extends KnownToolResultRawTool = KnownToolResultRawTool,
> = {
  [K in TTool]: ToolResultEventPayloadBase<K> & {
    ok: true;
    raw: KnownToolResultRaw<K>;
    errorCode?: undefined;
    error?: undefined;
  };
}[TTool];

export type UnknownToolResultSuccessEventPayload<
  TTool extends string = string,
> = ToolResultEventPayloadBase<TTool> & {
  ok: true;
  raw: UnknownToolResultRaw;
  errorCode?: undefined;
  error?: undefined;
};

type ToolResultSuccessEventPayloadFor<TTool extends string> =
  TTool extends KnownToolResultRawTool
    ? KnownToolResultSuccessEventPayload<TTool>
    : UnknownToolResultSuccessEventPayload<TTool>;

export type ToolResultSuccessEventPayload<TTool extends string = string> =
  string extends TTool
    ? KnownToolResultSuccessEventPayload | UnknownToolResultSuccessEventPayload
    : ToolResultSuccessEventPayloadFor<TTool>;

export interface ToolResultFailureEventPayload<
  TTool extends string = string,
> extends ToolResultEventPayloadBase<TTool> {
  ok: false;
  raw: unknown;
  errorCode: ErrorCode;
  error: string;
}

export type ToolResultEventPayload<TTool extends string = string> =
  | ToolResultSuccessEventPayload<TTool>
  | ToolResultFailureEventPayload<TTool>;

export interface DoneEventPayload {
  answer: string;
  ok: boolean;
}

export type ThreadStatePersistedEventPayload = ThreadDetailResponse;

export interface ThreadStatePersistenceFailureDiagnostic {
  phase: string;
  message: string;
}

export interface ThreadStatePersistFailedEventPayload {
  message: string;
  diagnostics?: ThreadStatePersistenceFailureDiagnostic[];
}

export type ErrorEventPayload = ApiError;

export interface SubagentSpawnedEventPayload {
  parentRunId: RunId;
  childRunId: RunId;
  childThreadId: ThreadId;
  subagentType: SubagentType;
}

export interface SubagentTerminalEventPayload {
  deliveryId: string;
  parentRunId: RunId;
  childRunId: RunId;
  subagentType: SubagentType;
  terminalState: AgentChildTerminalState;
  ok: boolean;
  reason?: AgentChildTerminalReason;
  result: string;
}

export interface SubagentApprovalRequiredEventPayload {
  parentRunId: RunId;
  childRunId: RunId;
  subagentType: SubagentType;
  approval: ApprovalRequired;
}

export type ArtifactCommittedEventPayload = ThreadArtifactVersion;

export interface SharedRunEventPayloadMap {
  run_ack: RunAckEventPayload;
  commentary_delta: TextDeltaEventPayload;
  tool_call: ToolCallEventPayload;
  tool_result: ToolResultEventPayload;
  subagent_spawned: SubagentSpawnedEventPayload;
  subagent_terminal: SubagentTerminalEventPayload;
  subagent_approval_required: SubagentApprovalRequiredEventPayload;
  approval_required: ApprovalRequired;
  final_answer_delta: TextDeltaEventPayload;
  artifact_committed: ArtifactCommittedEventPayload;
  thread_state_persisted: ThreadStatePersistedEventPayload;
  thread_state_persist_failed: ThreadStatePersistFailedEventPayload;
  done: DoneEventPayload;
  error: ErrorEventPayload;
}
export type RunEventPayloadMap = SharedRunEventPayloadMap;

export interface RunEventEnvelope<T extends RunEventType = RunEventType> {
  runId: RunId;
  threadId: ThreadId;
  seq: number;
  type: T;
  ts: string;
  payload: RunEventPayloadMap[T];
}

export type RunEvent = {
  [K in RunEventType]: RunEventEnvelope<K>;
}[RunEventType];

export function isTextDeltaEventPayload(
  value: unknown,
): value is TextDeltaEventPayload {
  return isRecord(value) && isString(value.text);
}

export function isRunAckEventPayload(
  value: unknown,
): value is RunAckEventPayload {
  return (
    isRecord(value) &&
    isString(value.runId) &&
    isRunId(value.runId) &&
    isString(value.threadId) &&
    isThreadId(value.threadId)
  );
}

export function isToolCallEventPayload(
  value: unknown,
): value is ToolCallEventPayload {
  return (
    isRecord(value) &&
    isString(value.callId) &&
    isNumber(value.step) &&
    isString(value.tool) &&
    isRecord(value.args)
  );
}

export function isSubagentType(value: unknown): value is SubagentType {
  return SUBAGENT_TYPES.some((subagentType) => subagentType === value);
}

function isAgentLaunchRejectionErrorCode(
  value: unknown,
): value is AgentLaunchRejectedToolRaw['errorCode'] {
  return (
    value === 'too_many_child_runs' ||
    value === 'unsupported_nested_spawn' ||
    value === 'invalid_args' ||
    value === 'execution_failed'
  );
}

function isPositiveInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 1;
}

export function isAgentLaunchToolRaw(
  value: unknown,
): value is AgentLaunchToolRaw {
  if (!isRecord(value) || !isBoolean(value.ok)) {
    return false;
  }

  if (value.ok) {
    return (
      value.launchState === 'started' &&
      isString(value.childRunId) &&
      isString(value.childThreadId) &&
      isSubagentType(value.subagentType)
    );
  }

  return (
    value.launchState === 'rejected' &&
    isSubagentType(value.subagentType) &&
    isAgentLaunchRejectionErrorCode(value.errorCode) &&
    isString(value.error) &&
    (value.effectiveMax === undefined ||
      isPositiveInteger(value.effectiveMax)) &&
    (value.errorCode !== 'too_many_child_runs' ||
      isPositiveInteger(value.effectiveMax))
  );
}

export function isAgentChildTerminalState(
  value: unknown,
): value is AgentChildTerminalState {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

function isAgentChildTerminalReason(
  value: unknown,
): value is AgentChildTerminalReason {
  return (
    value === 'child_error' ||
    value === 'timeout' ||
    value === 'user_interrupt' ||
    value === 'sibling_error' ||
    value === 'explicit_stop'
  );
}

function isAgentWaitCompletedRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.childRunId) &&
    isAgentChildTerminalState(value.terminalState) &&
    isBoolean(value.ok) &&
    (value.reason === undefined || isAgentChildTerminalReason(value.reason)) &&
    isString(value.result)
  );
}

function isAgentWaitBlockedRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.childRunId) &&
    value.blockedReason === 'approval_pending'
  );
}

export function isAgentWaitToolRaw(value: unknown): value is AgentWaitToolRaw {
  return (
    isRecord(value) &&
    value.ok === true &&
    Array.isArray(value.completed) &&
    value.completed.every(isAgentWaitCompletedRecord) &&
    Array.isArray(value.pending) &&
    value.pending.every(isString) &&
    Array.isArray(value.blocked) &&
    value.blocked.every(isAgentWaitBlockedRecord)
  );
}

export function isAgentStopToolRaw(value: unknown): value is AgentStopToolRaw {
  return (
    isRecord(value) &&
    value.ok === true &&
    isString(value.childRunId) &&
    (value.stopState === 'stopping' || value.stopState === 'already_terminal')
  );
}

const TOOL_RESULT_RAW_GUARDS: ToolResultRawGuardMap = {
  agent_spawn: isAgentLaunchToolRaw,
  agent_send_input: isAgentLaunchToolRaw,
  agent_wait: isAgentWaitToolRaw,
  agent_stop: isAgentStopToolRaw,
};

function isToolResultRawOwner(tool: string): tool is KnownToolResultRawTool {
  return (
    tool === 'agent_spawn' ||
    tool === 'agent_send_input' ||
    tool === 'agent_wait' ||
    tool === 'agent_stop'
  );
}

export function isToolResultRaw<TTool extends KnownToolResultRawTool>(
  tool: TTool,
  value: unknown,
): value is ToolResultRawMap[TTool] {
  return TOOL_RESULT_RAW_GUARDS[tool](value);
}

export function isToolResultEventPayload(
  value: unknown,
): value is ToolResultEventPayload {
  if (
    !isRecord(value) ||
    !isString(value.callId) ||
    !isNumber(value.step) ||
    !isString(value.tool) ||
    !isBoolean(value.ok) ||
    !isBoolean(value.workspaceFilesMayHaveChanged) ||
    !isString(value.displayText) ||
    !('raw' in value)
  ) {
    return false;
  }

  if (value.ok) {
    return (
      value.errorCode === undefined &&
      value.error === undefined &&
      (!isToolResultRawOwner(value.tool) ||
        isToolResultRaw(value.tool, value.raw))
    );
  }

  return isErrorCode(value.errorCode) && isString(value.error);
}

export function isDoneEventPayload(value: unknown): value is DoneEventPayload {
  return isRecord(value) && isString(value.answer) && isBoolean(value.ok);
}

export function isThreadStatePersistedEventPayload(
  value: unknown,
): value is ThreadStatePersistedEventPayload {
  return isThreadDetailResponse(value);
}

export function isThreadStatePersistFailedEventPayload(
  value: unknown,
): value is ThreadStatePersistFailedEventPayload {
  return (
    isRecord(value) &&
    isString(value.message) &&
    (value.diagnostics === undefined ||
      (Array.isArray(value.diagnostics) &&
        value.diagnostics.every(isThreadStatePersistenceFailureDiagnostic)))
  );
}

function isThreadStatePersistenceFailureDiagnostic(
  value: unknown,
): value is ThreadStatePersistenceFailureDiagnostic {
  return isRecord(value) && isString(value.phase) && isString(value.message);
}

export function isErrorEventPayload(
  value: unknown,
): value is ErrorEventPayload {
  return isApiError(value);
}

export function isSubagentSpawnedEventPayload(
  value: unknown,
): value is SubagentSpawnedEventPayload {
  return (
    isRecord(value) &&
    isString(value.parentRunId) &&
    isRunId(value.parentRunId) &&
    isString(value.childRunId) &&
    isRunId(value.childRunId) &&
    isString(value.childThreadId) &&
    isThreadId(value.childThreadId) &&
    isSubagentType(value.subagentType)
  );
}

export function isSubagentTerminalEventPayload(
  value: unknown,
): value is SubagentTerminalEventPayload {
  return (
    isRecord(value) &&
    isString(value.deliveryId) &&
    isString(value.parentRunId) &&
    isRunId(value.parentRunId) &&
    isString(value.childRunId) &&
    isRunId(value.childRunId) &&
    isSubagentType(value.subagentType) &&
    isAgentChildTerminalState(value.terminalState) &&
    isBoolean(value.ok) &&
    isString(value.result) &&
    (value.reason === undefined || isAgentChildTerminalReason(value.reason))
  );
}

export function isSubagentApprovalRequiredEventPayload(
  value: unknown,
): value is SubagentApprovalRequiredEventPayload {
  return (
    isRecord(value) &&
    isString(value.parentRunId) &&
    isRunId(value.parentRunId) &&
    isString(value.childRunId) &&
    isRunId(value.childRunId) &&
    isSubagentType(value.subagentType) &&
    isApprovalRequired(value.approval)
  );
}

export function isArtifactCommittedEventPayload(
  value: unknown,
): value is ArtifactCommittedEventPayload {
  return isThreadArtifactVersion(value);
}

export function isRunEvent(value: unknown): value is RunEvent {
  if (
    !isRecord(value) ||
    !isString(value.runId) ||
    !isRunId(value.runId) ||
    !isString(value.threadId) ||
    !isThreadId(value.threadId) ||
    !isNumber(value.seq) ||
    !isString(value.ts)
  ) {
    return false;
  }

  switch (value.type) {
    case 'run_ack':
      return isRunAckEventPayload(value.payload);
    case 'commentary_delta':
    case 'final_answer_delta':
      return isTextDeltaEventPayload(value.payload);
    case 'artifact_committed':
      return isArtifactCommittedEventPayload(value.payload);
    case 'thread_state_persisted':
      return isThreadStatePersistedEventPayload(value.payload);
    case 'thread_state_persist_failed':
      return isThreadStatePersistFailedEventPayload(value.payload);
    case 'tool_call':
      return isToolCallEventPayload(value.payload);
    case 'tool_result':
      return isToolResultEventPayload(value.payload);
    case 'subagent_spawned':
      return isSubagentSpawnedEventPayload(value.payload);
    case 'subagent_terminal':
      return isSubagentTerminalEventPayload(value.payload);
    case 'subagent_approval_required':
      return isSubagentApprovalRequiredEventPayload(value.payload);
    case 'approval_required':
      return isApprovalRequired(value.payload);
    case 'done':
      return isDoneEventPayload(value.payload);
    case 'error':
      return isErrorEventPayload(value.payload);
    default:
      return false;
  }
}
