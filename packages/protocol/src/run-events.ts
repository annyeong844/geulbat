import {
  isApiError,
  isErrorCode,
  type ApiError,
  type ErrorCode,
} from './errors.js';
import { isRunId, isThreadId, type RunId, type ThreadId } from './ids.js';
import { isApprovalRequired, type ApprovalRequired } from './run-approval.js';
import {
  isRunReasoningEffort,
  isSubagentModelSelectionSource,
  type RunAck,
  type RunReasoningEffort,
  type SubagentModelSelectionSource,
} from './run-contract.js';
import { isBoolean, isNumber, isRecord, isString } from './runtime-utils.js';
import {
  isToolCallSourcePayload,
  type ToolCallSourcePayload,
} from './tool-call-source.js';
import type { SideEffectLevel } from './side-effect-level.js';
import {
  isThreadArtifactVersion,
  type ThreadArtifactVersion,
} from './artifacts.js';
import {
  isThreadDetailResponse,
  type ThreadDetailResponse,
} from './threads.js';

export type { SideEffectLevel };
export { isToolCallSourcePayload };

type RunEventType =
  | 'run_ack'
  | 'commentary_delta'
  | 'tool_call'
  | 'tool_call_delta'
  | 'tool_result'
  | 'subagent_spawned'
  | 'subagent_terminal'
  | 'subagent_approval_required'
  | 'interject_applied'
  | 'approval_required'
  | 'usage_updated'
  | 'context_usage_updated'
  | 'final_answer_delta'
  | 'artifact_committed'
  | 'thread_state_persisted'
  | 'thread_state_persist_failed'
  | 'done'
  | 'error';

type RunAckEventPayload = RunAck;

interface TextDeltaEventPayload {
  text: string;
}

interface ToolCallEventPayload {
  callId: string;
  step: number;
  tool: string;
  args: Record<string, unknown>;
  source?: ToolCallSourcePayload;
}

// 스트리밍 도구 인자 델타 — streamsArgsDelta를 켠 도구(visualize 등)만
// 방출된다. argsDelta는 arguments JSON 텍스트의 이어붙일 조각이다.
interface ToolCallDeltaEventPayload {
  callId: string;
  step: number;
  tool: string;
  argsDelta: string;
}

export const SUBAGENT_TYPES = ['explorer', 'worker'] as const;
export type SubagentType = (typeof SUBAGENT_TYPES)[number];

export interface AgentLaunchAckToolRaw {
  ok: true;
  childRunId: string;
  childThreadId: string;
  subagentType: SubagentType;
  launchState: 'started';
  modelId?: string;
  reasoningEffort?: RunReasoningEffort;
  selectionSource?: SubagentModelSelectionSource;
}

export interface AgentLaunchRejectedToolRaw {
  ok: false;
  launchState: 'rejected';
  subagentType: SubagentType;
  errorCode: 'too_many_child_runs' | 'invalid_args' | 'execution_failed';
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

export const AGENT_WAIT_APPROVAL_BLOCKED_REASON = 'approval_pending' as const;

export const AGENT_WAIT_BLOCKED_REASONS = [
  AGENT_WAIT_APPROVAL_BLOCKED_REASON,
] as const;

export type AgentWaitBlockedReason =
  (typeof AGENT_WAIT_BLOCKED_REASONS)[number];

interface AgentWaitToolRaw {
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
    blockedReason: AgentWaitBlockedReason;
  }>;
}

type AgentStopToolRaw =
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

type ToolResultRawGuardMap = {
  [K in KnownToolResultRawTool]: (
    value: unknown,
  ) => value is ToolResultRawMap[K];
};

interface ToolResultEventPayloadBase<TTool extends string> {
  callId: string;
  step: number;
  tool: TTool;
  computerFilesMayHaveChanged: boolean;
  displayText: string;
  source?: ToolCallSourcePayload;
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

interface ToolResultFailureEventPayload<
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

interface DoneEventPayload {
  answer: string;
  ok: boolean;
}

type ThreadStatePersistedEventPayload = ThreadDetailResponse;

export interface ThreadStatePersistenceFailureDiagnostic {
  phase: string;
  message: string;
}

interface ThreadStatePersistFailedEventPayload {
  message: string;
  diagnostics?: ThreadStatePersistenceFailureDiagnostic[];
}

type ErrorEventPayload = ApiError;

interface SubagentSpawnedEventPayload {
  parentRunId: RunId;
  childRunId: RunId;
  childThreadId: ThreadId;
  subagentType: SubagentType;
  modelId?: string;
  reasoningEffort?: RunReasoningEffort;
  selectionSource?: SubagentModelSelectionSource;
}

// Aggregated provider token usage for one run (all counters, zero-filled).
export interface RunUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ContextUsageUpdatedEventPayload {
  state: 'measured' | 'compacted';
  modelId: string;
  inputTokens: number;
  contextWindow: number;
  thresholdTokens: number;
}

interface SubagentTerminalEventPayload {
  deliveryId: string;
  parentRunId: RunId;
  childRunId: RunId;
  // Present on lifecycle-produced events; lets the shell open the child
  // session transcript from the terminal card.
  childThreadId?: ThreadId;
  subagentType: SubagentType;
  terminalState: AgentChildTerminalState;
  ok: boolean;
  reason?: AgentChildTerminalReason;
  result: string;
  // Drill-down telemetry: wall-clock lifetime and token usage of the child run.
  elapsedMs?: number;
  usage?: RunUsageTotals;
  // 차일드 런이 실제로 호출한 공개 모델 정체 — 세션 뷰어 헤더에 표시
  modelId?: string;
  reasoningEffort?: RunReasoningEffort;
}

interface SubagentApprovalRequiredEventPayload {
  parentRunId: RunId;
  childRunId: RunId;
  subagentType: SubagentType;
  approval: ApprovalRequired;
}

export interface InterjectAppliedEventPayload {
  runId: RunId;
  count: number;
  receivedSeqs: number[];
}

export type ArtifactCommittedEventPayload = ThreadArtifactVersion;

export interface SharedRunEventPayloadMap {
  run_ack: RunAckEventPayload;
  commentary_delta: TextDeltaEventPayload;
  tool_call: ToolCallEventPayload;
  tool_call_delta: ToolCallDeltaEventPayload;
  tool_result: ToolResultEventPayload;
  subagent_spawned: SubagentSpawnedEventPayload;
  subagent_terminal: SubagentTerminalEventPayload;
  subagent_approval_required: SubagentApprovalRequiredEventPayload;
  interject_applied: InterjectAppliedEventPayload;
  approval_required: ApprovalRequired;
  // 모델 라운드마다 갱신되는 런 누적 토큰 사용량 — 상태줄 라이브 표시용
  usage_updated: RunUsageTotals;
  // 정확한 모델 입력 사용량과 실제 컴팩션 임계값 — 컨텍스트 고리 표시용
  context_usage_updated: ContextUsageUpdatedEventPayload;
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
    isRecord(value.args) &&
    (value.source === undefined || isToolCallSourcePayload(value.source))
  );
}

export function isToolCallDeltaEventPayload(
  value: unknown,
): value is ToolCallDeltaEventPayload {
  return (
    isRecord(value) &&
    isString(value.callId) &&
    isNumber(value.step) &&
    isString(value.tool) &&
    isString(value.argsDelta)
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
      isSubagentType(value.subagentType) &&
      (value.modelId === undefined || isString(value.modelId)) &&
      (value.reasoningEffort === undefined ||
        isRunReasoningEffort(value.reasoningEffort)) &&
      (value.selectionSource === undefined ||
        isSubagentModelSelectionSource(value.selectionSource))
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

export function isAgentWaitBlockedReason(
  value: unknown,
): value is AgentWaitBlockedReason {
  return value === AGENT_WAIT_APPROVAL_BLOCKED_REASON;
}

function isAgentWaitBlockedRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.childRunId) &&
    isAgentWaitBlockedReason(value.blockedReason)
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
    !isBoolean(value.computerFilesMayHaveChanged) ||
    'workspaceFilesMayHaveChanged' in value ||
    !isString(value.displayText) ||
    (value.source !== undefined && !isToolCallSourcePayload(value.source)) ||
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
    isSubagentType(value.subagentType) &&
    (value.modelId === undefined || isString(value.modelId)) &&
    (value.reasoningEffort === undefined ||
      isRunReasoningEffort(value.reasoningEffort)) &&
    (value.selectionSource === undefined ||
      isSubagentModelSelectionSource(value.selectionSource))
  );
}

export function isRunUsageTotals(value: unknown): value is RunUsageTotals {
  return (
    isRecord(value) &&
    isNumber(value.inputTokens) &&
    isNumber(value.outputTokens) &&
    isNumber(value.cachedInputTokens)
  );
}

export function isContextUsageUpdatedEventPayload(
  value: unknown,
): value is ContextUsageUpdatedEventPayload {
  return (
    isRecord(value) &&
    (value.state === 'measured' || value.state === 'compacted') &&
    isString(value.modelId) &&
    value.modelId.trim().length > 0 &&
    isNonNegativeSafeInteger(value.inputTokens) &&
    isPositiveSafeInteger(value.contextWindow) &&
    isPositiveSafeInteger(value.thresholdTokens) &&
    value.thresholdTokens <= value.contextWindow
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRunEventTimestamp(value: unknown): value is string {
  if (
    !isString(value) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    return false;
  }
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
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
    (value.reason === undefined || isAgentChildTerminalReason(value.reason)) &&
    (value.childThreadId === undefined ||
      (isString(value.childThreadId) && isThreadId(value.childThreadId))) &&
    (value.elapsedMs === undefined || isNumber(value.elapsedMs)) &&
    (value.usage === undefined || isRunUsageTotals(value.usage)) &&
    (value.modelId === undefined || isString(value.modelId)) &&
    (value.reasoningEffort === undefined ||
      isRunReasoningEffort(value.reasoningEffort))
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

export function isInterjectAppliedEventPayload(
  value: unknown,
): value is InterjectAppliedEventPayload {
  return (
    isRecord(value) &&
    isString(value.runId) &&
    isRunId(value.runId) &&
    isPositiveInteger(value.count) &&
    Array.isArray(value.receivedSeqs) &&
    value.receivedSeqs.length === value.count &&
    value.receivedSeqs.every(isPositiveInteger)
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
    !isNonNegativeSafeInteger(value.seq) ||
    !isRunEventTimestamp(value.ts)
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
    case 'tool_call_delta':
      return isToolCallDeltaEventPayload(value.payload);
    case 'tool_result':
      return isToolResultEventPayload(value.payload);
    case 'subagent_spawned':
      return isSubagentSpawnedEventPayload(value.payload);
    case 'subagent_terminal':
      return isSubagentTerminalEventPayload(value.payload);
    case 'subagent_approval_required':
      return isSubagentApprovalRequiredEventPayload(value.payload);
    case 'interject_applied':
      return isInterjectAppliedEventPayload(value.payload);
    case 'approval_required':
      return isApprovalRequired(value.payload);
    case 'usage_updated':
      return isRunUsageTotals(value.payload);
    case 'context_usage_updated':
      return isContextUsageUpdatedEventPayload(value.payload);
    case 'done':
      return isDoneEventPayload(value.payload);
    case 'error':
      return isErrorEventPayload(value.payload);
    default:
      return false;
  }
}
