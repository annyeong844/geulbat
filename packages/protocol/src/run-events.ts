import {
  isApiError,
  isErrorCode,
  isToolFailureDiagnostics,
  type ApiError,
  type ErrorCode,
  type ToolFailureDiagnostics,
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
import {
  isBoolean,
  isCanonicalIsoTimestamp,
  isNumber,
  isRecord,
  isString,
} from './wire-value-guards.js';
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
  isPlanningWorkflowSnapshot,
  type PlanningWorkflowSnapshot,
} from './planning-workflow.js';
import { isGoalSnapshot, type GoalSnapshot } from './goal.js';
import {
  isThreadDetailResponse,
  type ThreadDetailResponse,
} from './threads.js';
import {
  isAgentChildTerminalReason,
  isAgentChildTerminalState,
  isSubagentResultReport,
  type AgentChildTerminalReason,
  type AgentChildTerminalState,
  type SubagentResultReport,
} from './subagent-terminal.js';
import {
  isProviderRuntimeStatusEventPayload,
  isRunUsageTotals,
  isSubagentCapabilities,
  isSubagentRuntimeDiagnostics,
  isSubagentToolSurfaceProfile,
  isSubagentType,
  type ProviderRuntimeStatusEventPayload,
  type RunUsageTotals,
  type SubagentCapability,
  type SubagentRuntimeDiagnostics,
  type SubagentToolSurfaceProfile,
  type SubagentType,
} from './run-runtime-status.js';

export type { SideEffectLevel };
export { isToolCallSourcePayload };
export {
  PROVIDER_RETRY_OUTCOMES,
  PROVIDER_RUNTIME_PHASES,
  SUBAGENT_CAPABILITIES,
  SUBAGENT_RUNTIME_PHASES,
  SUBAGENT_RUNTIME_TOOL_STATES,
  SUBAGENT_TOOL_SURFACE_PROFILES,
  SUBAGENT_TYPES,
  isProviderRequestDiagnostics,
  isProviderRetryDiagnostics,
  isProviderRuntimeStatusEventPayload,
  isRunUsageTotals,
  isSubagentCapabilities,
  isSubagentRuntimeDiagnostics,
  isSubagentRuntimePhase,
  isSubagentRuntimeToolState,
  isSubagentToolSurfaceProfile,
  isSubagentType,
} from './run-runtime-status.js';
export type {
  ProviderRequestDiagnostics,
  ProviderRetryDiagnostics,
  ProviderRetryOutcome,
  ProviderRuntimePhase,
  ProviderRuntimeStatusEventPayload,
  RunUsageTotals,
  SubagentCapability,
  SubagentRuntimeDiagnostics,
  SubagentRuntimePhase,
  SubagentRuntimeToolState,
  SubagentToolSurfaceProfile,
  SubagentType,
} from './run-runtime-status.js';

type RunEventType = keyof SharedRunEventPayloadMap;

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

export interface ToolOutputDeltaEventPayload {
  callId: string;
  tool: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

export const SUBAGENT_LAUNCH_REQUEST_STATES = [
  'queued',
  'starting',
  'started',
  'interrupted',
  'cancelled',
  'failed_to_start',
] as const;
export type SubagentLaunchRequestState =
  (typeof SUBAGENT_LAUNCH_REQUEST_STATES)[number];

export const SUBAGENT_LAUNCH_PRIORITY_CLASSES = [
  'low',
  'normal',
  'high',
] as const;
export type SubagentLaunchPriorityClass =
  (typeof SUBAGENT_LAUNCH_PRIORITY_CLASSES)[number];

export const SUBAGENT_LAUNCH_DEFER_REASONS = [
  'resource_budget',
  'configured_capacity',
  'provider_cooldown',
  'main_reserve',
  'batch_group_wait',
  'recovery_reconciliation',
] as const;
export type SubagentLaunchDeferReason =
  (typeof SUBAGENT_LAUNCH_DEFER_REASONS)[number];

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

export interface AgentLaunchQueuedToolRaw {
  ok: true;
  childRunId: string;
  childThreadId: string;
  subagentType: SubagentType;
  launchState: 'queued';
  deferReason: SubagentLaunchDeferReason;
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
  | AgentLaunchQueuedToolRaw
  | AgentLaunchRejectedToolRaw;

export const AGENT_WAIT_APPROVAL_BLOCKED_REASON = 'approval_pending' as const;

export const AGENT_WAIT_BLOCKED_REASONS = [
  AGENT_WAIT_APPROVAL_BLOCKED_REASON,
] as const;

export type AgentWaitBlockedReason =
  (typeof AGENT_WAIT_BLOCKED_REASONS)[number];

interface AgentWaitToolRaw {
  ok: true;
  completed: Array<{
    deliveryId?: string;
    childRunId: string;
    terminalState: AgentChildTerminalState;
    ok: boolean;
    reason?: AgentChildTerminalReason;
    result?: string;
    resultRef?: string;
    resultDigest?: `sha256:${string}`;
    resultReport?: SubagentResultReport;
    parentRunId?: RunId;
    childThreadId?: ThreadId;
    subagentType?: SubagentType;
    capabilities?: readonly SubagentCapability[];
    toolSurface?: SubagentToolSurfaceProfile;
    runtime?: SubagentRuntimeDiagnostics;
    completedAt?: string;
    elapsedMs?: number;
    usage?: RunUsageTotals;
    modelId?: string;
    reasoningEffort?: RunReasoningEffort;
  }>;
  pending: string[];
  blocked: Array<{
    childRunId: string;
    blockedReason: AgentWaitBlockedReason;
  }>;
  launches?: Array<{
    childRunId: string;
    childThreadId: string;
    previousChildRunId?: string;
    launchState: SubagentLaunchRequestState;
    priorityClass: SubagentLaunchPriorityClass;
    enqueueOrder: number;
    createdAt: string;
    updatedAt: string;
    runtime?: SubagentRuntimeDiagnostics;
    deferReason?: SubagentLaunchDeferReason;
    failureReason?: string;
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
    }
  | {
      ok: true;
      childRunId: string;
      stopState: 'cancelled_before_start';
    };

interface AgentSetPriorityToolRaw {
  ok: true;
  childRunId: string;
  launchState: SubagentLaunchRequestState;
  priorityClass: SubagentLaunchPriorityClass;
  updateState: 'updated' | 'unchanged' | 'not_queued';
}

export const SUBAGENT_RETRY_DISPOSITIONS = [
  'created',
  'same_call_replay',
  'already_retried',
] as const;

export type SubagentRetryDisposition =
  (typeof SUBAGENT_RETRY_DISPOSITIONS)[number];

export interface AgentRetryToolRaw {
  ok: true;
  previousChildRunId: string;
  childRunId: string;
  childThreadId: string;
  retryDisposition: SubagentRetryDisposition;
  launchState: SubagentLaunchRequestState;
  deferReason: SubagentLaunchDeferReason | null;
  failureReason: string | null;
  modelId: string;
  reasoningEffort: RunReasoningEffort;
  selectionSource: SubagentModelSelectionSource;
}

/* 대용량 결과 오프로드 — 인라인 한도를 넘는 tool_result는 raw 자리에 원본
   대신 read_tool_output으로 재진입 가능한 슬림 참조가 실린다. 기록(emit)
   경로가 만드는 형태는 재독(저널 replay/재접속 복구) 경로도 동일하게
   수용해야 한다 — 한쪽만 아는 비대칭 검증은 저널을 영구 오염시켜 run.auth
   복구를 죽인다 (2026-07-21 agent_wait S0 실증). */
export interface OffloadedToolResultRaw {
  ok: true;
  offloaded: true;
  tool: string;
  callId: string;
  outputRef: string;
  summary: string;
  fullOutputBytes: number;
  fullOutputChars: number;
  recoveryTool: 'read_tool_output';
}

export function isOffloadedToolResultRaw(
  value: unknown,
): value is OffloadedToolResultRaw {
  return (
    isRecord(value) &&
    value.ok === true &&
    value.offloaded === true &&
    isString(value.tool) &&
    isString(value.callId) &&
    isString(value.outputRef) &&
    isString(value.summary) &&
    isNumber(value.fullOutputBytes) &&
    isNumber(value.fullOutputChars) &&
    value.recoveryTool === 'read_tool_output'
  );
}

export interface ToolResultRawMap {
  agent_spawn: AgentLaunchToolRaw;
  agent_send_input: AgentLaunchToolRaw;
  // agent_wait는 오프로드 대상(출력이 자식 결과 모음이라 커질 수 있다) —
  // raw가 원본 또는 슬림 참조 둘 다일 수 있다.
  agent_wait: AgentWaitToolRaw | OffloadedToolResultRaw;
  agent_stop: AgentStopToolRaw;
  agent_set_priority: AgentSetPriorityToolRaw;
  agent_retry: AgentRetryToolRaw;
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
  diagnostics?: ToolFailureDiagnostics;
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

interface SubagentLifecycleDiagnostics {
  // Optional for replay compatibility with events journaled before selective
  // child capabilities became public diagnostics. Current producers always
  // send both fields, including an empty capability list.
  capabilities?: readonly SubagentCapability[];
  toolSurface?: SubagentToolSurfaceProfile;
  runtime?: SubagentRuntimeDiagnostics;
}

interface SubagentSpawnedEventPayload extends SubagentLifecycleDiagnostics {
  parentRunId: RunId;
  childRunId: RunId;
  childThreadId: ThreadId;
  subagentType: SubagentType;
  modelId?: string;
  reasoningEffort?: RunReasoningEffort;
  selectionSource?: SubagentModelSelectionSource;
}

interface SubagentStatusEventPayload extends SubagentLifecycleDiagnostics {
  parentRunId: RunId;
  childRunId: RunId;
  childThreadId: ThreadId;
  subagentType: SubagentType;
  modelId?: string;
  reasoningEffort?: RunReasoningEffort;
  selectionSource?: SubagentModelSelectionSource;
}

interface KnownContextUsageUpdatedEventPayload {
  state: 'measured';
  /** Missing only on snapshots persisted before measurement quality existed. */
  quality?: 'exact' | 'estimated';
  modelId: string;
  inputTokens: number;
  contextWindow: number;
  thresholdTokens: number;
  requestBytes?: number;
}

interface CompactedContextUsageUpdatedEventPayloadBase {
  state: 'compacted';
  /** Missing only on snapshots persisted before measurement quality existed. */
  quality?: 'exact';
  modelId: string;
  inputTokens: number;
  contextWindow: number;
  thresholdTokens: number;
  requestBytes?: number;
}

type CompactedContextUsageUpdatedEventPayload =
  CompactedContextUsageUpdatedEventPayloadBase &
    (
      | {
          /** Legacy snapshot persisted before commit provenance existed. */
          compactionEntryId?: undefined;
          historyBytesBefore?: undefined;
          historyBytesAfter?: undefined;
        }
      | {
          compactionEntryId: string;
          historyBytesBefore: number;
          historyBytesAfter: number;
        }
    );

interface UnknownContextUsageUpdatedEventPayload {
  state: 'measured';
  quality: 'unknown';
  modelId: string;
  requestBytes: number;
  contextWindow?: number;
  thresholdTokens?: number;
}

export type ContextUsageUpdatedEventPayload =
  | KnownContextUsageUpdatedEventPayload
  | CompactedContextUsageUpdatedEventPayload
  | UnknownContextUsageUpdatedEventPayload;

interface SubagentTerminalEventPayload extends SubagentLifecycleDiagnostics {
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
  resultRef?: string;
  resultDigest?: `sha256:${string}`;
  resultReport?: SubagentResultReport;
  completedAt?: string;
  // Drill-down telemetry: wall-clock lifetime and token usage of the child run.
  elapsedMs?: number;
  usage?: RunUsageTotals;
  // 차일드 런이 실제로 호출한 공개 모델 정체 — 세션 뷰어 헤더에 표시
  modelId?: string;
  reasoningEffort?: RunReasoningEffort;
}

interface SubagentApprovalRequiredEventPayload extends SubagentLifecycleDiagnostics {
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
  provider_status: ProviderRuntimeStatusEventPayload;
  commentary_delta: TextDeltaEventPayload;
  tool_call: ToolCallEventPayload;
  tool_call_delta: ToolCallDeltaEventPayload;
  tool_result: ToolResultEventPayload;
  subagent_spawned: SubagentSpawnedEventPayload;
  subagent_status: SubagentStatusEventPayload;
  subagent_terminal: SubagentTerminalEventPayload;
  subagent_approval_required: SubagentApprovalRequiredEventPayload;
  interject_applied: InterjectAppliedEventPayload;
  approval_required: ApprovalRequired;
  // 모델 라운드마다 갱신되는 런 누적 토큰 사용량 — 상태줄 라이브 표시용
  usage_updated: RunUsageTotals;
  // 정확한 모델 입력 사용량과 실제 컴팩션 임계값 — 컨텍스트 고리 표시용
  context_usage_updated: ContextUsageUpdatedEventPayload;
  final_answer_delta: TextDeltaEventPayload;
  // 아티팩트 전용 답변의 봉투 텍스트 라이브 스트림 — 채팅(final_answer_delta)
  // 대신 중앙 아티팩트 창이 소비한다. 커밋 전 생성 과정을 실시간으로 보여준다.
  artifact_stream_delta: TextDeltaEventPayload;
  artifact_committed: ArtifactCommittedEventPayload;
  planning_workflow_updated: PlanningWorkflowSnapshot;
  goal_updated: GoalSnapshot;
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

export function isToolOutputDeltaEventPayload(
  value: unknown,
): value is ToolOutputDeltaEventPayload {
  return (
    isRecord(value) &&
    isString(value.callId) &&
    isString(value.tool) &&
    (value.stream === 'stdout' || value.stream === 'stderr') &&
    isString(value.text)
  );
}

export function isSubagentLaunchRequestState(
  value: unknown,
): value is SubagentLaunchRequestState {
  return SUBAGENT_LAUNCH_REQUEST_STATES.some((state) => state === value);
}

export function isSubagentLaunchPriorityClass(
  value: unknown,
): value is SubagentLaunchPriorityClass {
  return SUBAGENT_LAUNCH_PRIORITY_CLASSES.some(
    (priorityClass) => priorityClass === value,
  );
}

export function isSubagentLaunchDeferReason(
  value: unknown,
): value is SubagentLaunchDeferReason {
  return SUBAGENT_LAUNCH_DEFER_REASONS.some((reason) => reason === value);
}

function hasValidSubagentLifecycleDiagnostics(
  value: Record<string, unknown>,
): boolean {
  if (
    value.runtime !== undefined &&
    !isSubagentRuntimeDiagnostics(value.runtime)
  ) {
    return false;
  }
  if (value.capabilities === undefined && value.toolSurface === undefined) {
    return true;
  }
  if (
    !isSubagentCapabilities(value.capabilities) ||
    !isSubagentToolSurfaceProfile(value.toolSurface)
  ) {
    return false;
  }
  if (value.subagentType === 'worker') {
    return value.capabilities.length === 0 && value.toolSurface === 'worker';
  }
  return value.capabilities.includes('ptc')
    ? value.toolSurface === 'explorer_ptc'
    : value.toolSurface === 'explorer';
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
      (value.launchState === 'started' ||
        (value.launchState === 'queued' &&
          isSubagentLaunchDeferReason(value.deferReason))) &&
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

function isAgentWaitCompletedRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.deliveryId === undefined ||
      (isString(value.deliveryId) && value.deliveryId.trim() !== '')) &&
    isString(value.childRunId) &&
    isAgentChildTerminalState(value.terminalState) &&
    isBoolean(value.ok) &&
    (value.reason === undefined || isAgentChildTerminalReason(value.reason)) &&
    (value.result === undefined || isString(value.result)) &&
    (value.resultRef === undefined ||
      (isString(value.resultRef) && value.resultRef.trim() !== '')) &&
    (value.result !== undefined || value.resultRef !== undefined) &&
    (value.resultDigest === undefined ||
      (isString(value.resultDigest) &&
        /^sha256:[a-f0-9]{64}$/u.test(value.resultDigest))) &&
    (value.resultReport === undefined ||
      isSubagentResultReport(value.resultReport)) &&
    (value.parentRunId === undefined ||
      (isString(value.parentRunId) && isRunId(value.parentRunId))) &&
    (value.childThreadId === undefined ||
      (isString(value.childThreadId) && isThreadId(value.childThreadId))) &&
    (value.subagentType === undefined
      ? value.capabilities === undefined &&
        value.toolSurface === undefined &&
        (value.runtime === undefined ||
          isSubagentRuntimeDiagnostics(value.runtime))
      : isSubagentType(value.subagentType) &&
        hasValidSubagentLifecycleDiagnostics(value)) &&
    (value.completedAt === undefined ||
      isCanonicalIsoTimestamp(value.completedAt)) &&
    (value.elapsedMs === undefined || isNumber(value.elapsedMs)) &&
    (value.usage === undefined || isRunUsageTotals(value.usage)) &&
    (value.modelId === undefined || isString(value.modelId)) &&
    (value.reasoningEffort === undefined ||
      isRunReasoningEffort(value.reasoningEffort))
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

function isAgentWaitLaunchRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.childRunId) &&
    isRunId(value.childRunId) &&
    isString(value.childThreadId) &&
    isThreadId(value.childThreadId) &&
    (value.previousChildRunId === undefined ||
      (isString(value.previousChildRunId) &&
        isRunId(value.previousChildRunId))) &&
    isSubagentLaunchRequestState(value.launchState) &&
    isSubagentLaunchPriorityClass(value.priorityClass) &&
    isNumber(value.enqueueOrder) &&
    Number.isSafeInteger(value.enqueueOrder) &&
    value.enqueueOrder > 0 &&
    isCanonicalIsoTimestamp(value.createdAt) &&
    isCanonicalIsoTimestamp(value.updatedAt) &&
    (value.runtime === undefined ||
      isSubagentRuntimeDiagnostics(value.runtime)) &&
    (value.deferReason === undefined ||
      isSubagentLaunchDeferReason(value.deferReason)) &&
    (value.failureReason === undefined || isString(value.failureReason))
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
    value.blocked.every(isAgentWaitBlockedRecord) &&
    (value.launches === undefined ||
      (Array.isArray(value.launches) &&
        value.launches.every(isAgentWaitLaunchRecord)))
  );
}

export function isAgentStopToolRaw(value: unknown): value is AgentStopToolRaw {
  return (
    isRecord(value) &&
    value.ok === true &&
    isString(value.childRunId) &&
    (value.stopState === 'stopping' ||
      value.stopState === 'already_terminal' ||
      value.stopState === 'cancelled_before_start')
  );
}

export function isAgentSetPriorityToolRaw(
  value: unknown,
): value is AgentSetPriorityToolRaw {
  return (
    isRecord(value) &&
    value.ok === true &&
    isString(value.childRunId) &&
    isSubagentLaunchRequestState(value.launchState) &&
    isSubagentLaunchPriorityClass(value.priorityClass) &&
    (value.updateState === 'updated' ||
      value.updateState === 'unchanged' ||
      value.updateState === 'not_queued')
  );
}

export function isAgentRetryToolRaw(
  value: unknown,
): value is AgentRetryToolRaw {
  return (
    isRecord(value) &&
    value.ok === true &&
    isString(value.previousChildRunId) &&
    isString(value.childRunId) &&
    isString(value.childThreadId) &&
    (SUBAGENT_RETRY_DISPOSITIONS as readonly unknown[]).includes(
      value.retryDisposition,
    ) &&
    isSubagentLaunchRequestState(value.launchState) &&
    (value.deferReason === null ||
      isSubagentLaunchDeferReason(value.deferReason)) &&
    (value.failureReason === null || isString(value.failureReason)) &&
    isString(value.modelId) &&
    isRunReasoningEffort(value.reasoningEffort) &&
    isSubagentModelSelectionSource(value.selectionSource)
  );
}

function isAgentWaitToolRawOrOffloaded(
  value: unknown,
): value is AgentWaitToolRaw | OffloadedToolResultRaw {
  return (
    isAgentWaitToolRaw(value) ||
    (isOffloadedToolResultRaw(value) && value.tool === 'agent_wait')
  );
}

const TOOL_RESULT_RAW_GUARDS: ToolResultRawGuardMap = {
  agent_spawn: isAgentLaunchToolRaw,
  agent_send_input: isAgentLaunchToolRaw,
  agent_wait: isAgentWaitToolRawOrOffloaded,
  agent_stop: isAgentStopToolRaw,
  agent_set_priority: isAgentSetPriorityToolRaw,
  agent_retry: isAgentRetryToolRaw,
};

function isToolResultRawOwner(tool: string): tool is KnownToolResultRawTool {
  return (
    tool === 'agent_spawn' ||
    tool === 'agent_send_input' ||
    tool === 'agent_wait' ||
    tool === 'agent_stop' ||
    tool === 'agent_set_priority' ||
    tool === 'agent_retry'
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
      value.diagnostics === undefined &&
      (!isToolResultRawOwner(value.tool) ||
        isToolResultRaw(value.tool, value.raw))
    );
  }

  return (
    isErrorCode(value.errorCode) &&
    isString(value.error) &&
    (value.diagnostics === undefined ||
      isToolFailureDiagnostics(value.diagnostics))
  );
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
    hasValidSubagentLifecycleDiagnostics(value) &&
    (value.modelId === undefined || isString(value.modelId)) &&
    (value.reasoningEffort === undefined ||
      isRunReasoningEffort(value.reasoningEffort)) &&
    (value.selectionSource === undefined ||
      isSubagentModelSelectionSource(value.selectionSource))
  );
}

export function isSubagentStatusEventPayload(
  value: unknown,
): value is SubagentStatusEventPayload {
  return (
    isRecord(value) &&
    isString(value.parentRunId) &&
    isRunId(value.parentRunId) &&
    isString(value.childRunId) &&
    isRunId(value.childRunId) &&
    isString(value.childThreadId) &&
    isThreadId(value.childThreadId) &&
    isSubagentType(value.subagentType) &&
    hasValidSubagentLifecycleDiagnostics(value) &&
    (value.modelId === undefined || isString(value.modelId)) &&
    (value.reasoningEffort === undefined ||
      isRunReasoningEffort(value.reasoningEffort)) &&
    (value.selectionSource === undefined ||
      isSubagentModelSelectionSource(value.selectionSource))
  );
}

export function isContextUsageUpdatedEventPayload(
  value: unknown,
): value is ContextUsageUpdatedEventPayload {
  if (
    !isRecord(value) ||
    (value.state !== 'measured' && value.state !== 'compacted') ||
    !isString(value.modelId) ||
    value.modelId.trim().length === 0
  ) {
    return false;
  }

  const hasNoCompactionCommitProvenance =
    value.compactionEntryId === undefined &&
    value.historyBytesBefore === undefined &&
    value.historyBytesAfter === undefined;
  const hasValidCompactionCommitProvenance =
    isString(value.compactionEntryId) &&
    value.compactionEntryId.trim().length > 0 &&
    isPositiveSafeInteger(value.historyBytesBefore) &&
    isNonNegativeSafeInteger(value.historyBytesAfter) &&
    value.historyBytesAfter < value.historyBytesBefore;
  if (
    (value.state === 'measured' && !hasNoCompactionCommitProvenance) ||
    (value.state === 'compacted' &&
      !hasNoCompactionCommitProvenance &&
      !hasValidCompactionCommitProvenance)
  ) {
    return false;
  }

  if (value.quality === 'unknown') {
    const hasContextWindow = value.contextWindow !== undefined;
    const hasThresholdTokens = value.thresholdTokens !== undefined;
    return (
      value.state === 'measured' &&
      isPositiveSafeInteger(value.requestBytes) &&
      value.inputTokens === undefined &&
      hasContextWindow === hasThresholdTokens &&
      (!hasContextWindow ||
        (isPositiveSafeInteger(value.contextWindow) &&
          isPositiveSafeInteger(value.thresholdTokens) &&
          value.thresholdTokens <= value.contextWindow))
    );
  }

  if (
    value.quality !== undefined &&
    value.quality !== 'exact' &&
    value.quality !== 'estimated'
  ) {
    return false;
  }
  if (value.state === 'compacted' && value.quality === 'estimated') {
    return false;
  }

  return (
    isNonNegativeSafeInteger(value.inputTokens) &&
    isPositiveSafeInteger(value.contextWindow) &&
    isPositiveSafeInteger(value.thresholdTokens) &&
    value.thresholdTokens <= value.contextWindow &&
    (value.requestBytes === undefined ||
      isPositiveSafeInteger(value.requestBytes)) &&
    (value.quality !== 'estimated' || value.requestBytes !== undefined)
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
    hasValidSubagentLifecycleDiagnostics(value) &&
    isAgentChildTerminalState(value.terminalState) &&
    isBoolean(value.ok) &&
    isString(value.result) &&
    (value.resultRef === undefined ||
      (isString(value.resultRef) && value.resultRef.trim() !== '')) &&
    (value.resultDigest === undefined ||
      (isString(value.resultDigest) &&
        /^sha256:[a-f0-9]{64}$/u.test(value.resultDigest))) &&
    (value.resultReport === undefined ||
      (isSubagentResultReport(value.resultReport) &&
        value.resultReport.sourceResultRef === value.resultRef &&
        value.resultReport.sourceResultDigest === value.resultDigest)) &&
    (value.completedAt === undefined ||
      isCanonicalIsoTimestamp(value.completedAt)) &&
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
    hasValidSubagentLifecycleDiagnostics(value) &&
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

// 이벤트 종류별 payload 검사기 — 키가 RunEventType으로 고정돼 있어, 새 이벤트를
// 추가하면 여기 항목을 채울 때까지 컴파일이 깨진다. 값 타입도 종류별 payload에
// 묶여 있어 엉뚱한 검사기를 꽂는 것도 잡힌다. switch + default였을 때는 둘 다
// 조용히 통과했고 새 이벤트는 런타임에 거부돼 사라졌다.
// (adapter/web의 agentEventPayloadGuards와 같은 형태다.)
const RUN_EVENT_PAYLOAD_GUARDS: {
  [K in RunEventType]: (value: unknown) => value is RunEventPayloadMap[K];
} = {
  run_ack: isRunAckEventPayload,
  provider_status: isProviderRuntimeStatusEventPayload,
  commentary_delta: isTextDeltaEventPayload,
  final_answer_delta: isTextDeltaEventPayload,
  artifact_stream_delta: isTextDeltaEventPayload,
  artifact_committed: isArtifactCommittedEventPayload,
  planning_workflow_updated: isPlanningWorkflowSnapshot,
  goal_updated: isGoalSnapshot,
  thread_state_persisted: isThreadStatePersistedEventPayload,
  thread_state_persist_failed: isThreadStatePersistFailedEventPayload,
  tool_call: isToolCallEventPayload,
  tool_call_delta: isToolCallDeltaEventPayload,
  tool_result: isToolResultEventPayload,
  subagent_spawned: isSubagentSpawnedEventPayload,
  subagent_status: isSubagentStatusEventPayload,
  subagent_terminal: isSubagentTerminalEventPayload,
  subagent_approval_required: isSubagentApprovalRequiredEventPayload,
  interject_applied: isInterjectAppliedEventPayload,
  approval_required: isApprovalRequired,
  usage_updated: isRunUsageTotals,
  context_usage_updated: isContextUsageUpdatedEventPayload,
  done: isDoneEventPayload,
  error: isErrorEventPayload,
};

// 임의 문자열로 조회하는 자리 — 단언 없이 찾으려고 Map으로 한 번 옮긴다.
// 소진 검사는 위 레코드 리터럴이 맡고, 여기서는 미지의 type이 undefined가 된다.
const RUN_EVENT_PAYLOAD_GUARD_BY_TYPE = new Map<
  string,
  (value: unknown) => boolean
>(Object.entries(RUN_EVENT_PAYLOAD_GUARDS));

export function isRunEvent(value: unknown): value is RunEvent {
  if (
    !isRecord(value) ||
    !isString(value.runId) ||
    !isRunId(value.runId) ||
    !isString(value.threadId) ||
    !isThreadId(value.threadId) ||
    !isNonNegativeSafeInteger(value.seq) ||
    !isCanonicalIsoTimestamp(value.ts) ||
    !isString(value.type)
  ) {
    return false;
  }
  switch (value.type) {
    case 'run_ack':
      return (
        isRunAckEventPayload(value.payload) &&
        value.payload.runId === value.runId &&
        value.payload.threadId === value.threadId
      );
    case 'interject_applied':
      return (
        isInterjectAppliedEventPayload(value.payload) &&
        value.payload.runId === value.runId
      );
    case 'planning_workflow_updated':
      return (
        isPlanningWorkflowSnapshot(value.payload) &&
        value.payload.threadId === value.threadId
      );
    case 'goal_updated':
      return (
        isGoalSnapshot(value.payload) &&
        value.payload.threadId === value.threadId
      );
    default: {
      const guard = RUN_EVENT_PAYLOAD_GUARD_BY_TYPE.get(value.type);
      return guard !== undefined && guard(value.payload);
    }
  }
}
