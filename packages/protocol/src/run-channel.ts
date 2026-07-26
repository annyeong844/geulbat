import { isApprovalRequest, type ApprovalRequest } from './run-approval.js';
import { isCancelRequest, type CancelRequest } from './cancel.js';
import { isErrorCode, type ErrorCode } from './errors.js';
import {
  isGoalCommand,
  isGoalSnapshot,
  type GoalCommand,
  type GoalSnapshot,
} from './goal.js';
import { isRunId, isThreadId, type RunId, type ThreadId } from './ids.js';
import {
  isRunEvent,
  isToolOutputDeltaEventPayload,
  type RunEvent,
  type ToolOutputDeltaEventPayload,
} from './run-events.js';
import { isRunStartRequest, type RunStartRequest } from './run-contract.js';
import {
  isApprovedPlanRef,
  isPlanningWorkflowSnapshot,
  isPlanWorkflowCommand,
  type ApprovedPlanRef,
  type PlanningWorkflowSnapshot,
  type PlanWorkflowCommand,
} from './planning-workflow.js';
import {
  isBoolean,
  isNumber,
  isRecord,
  isString,
} from './wire-value-guards.js';

export interface RunEventReplayCursor {
  runId: RunEvent['runId'];
  seq: number;
}

interface RunAuthMessage {
  type: 'run.auth';
  requestId: string;
  token: string;
  runEventCursors?: RunEventReplayCursor[];
  threadSubscriptions?: ThreadId[];
}

interface RunStartMessage {
  type: 'run.start';
  requestId: string;
  request: RunStartRequest;
}

interface RunCancelMessage {
  type: 'run.cancel';
  requestId: string;
  request: CancelRequest;
}

export interface RunChildCancelRequest {
  parentRunId: RunId;
  childRunId: RunId;
}

interface RunChildCancelMessage {
  type: 'run.child.cancel';
  requestId: string;
  request: RunChildCancelRequest;
}

export interface RunThreadSubscribeRequest {
  threadId: ThreadId;
}

interface RunThreadSubscribeMessage {
  type: 'run.thread.subscribe';
  requestId: string;
  request: RunThreadSubscribeRequest;
}

interface RunApproveMessage {
  type: 'run.approve';
  requestId: string;
  request: ApprovalRequest;
}

interface PlanWorkflowCommandMessage {
  type: 'plan.command';
  requestId: string;
  request: PlanWorkflowCommand;
}

interface GoalCommandMessage {
  type: 'goal.command';
  requestId: string;
  request: GoalCommand;
}

interface RunInterjectEnvelopeMessage {
  type: 'run.interject';
  requestId: string;
  request: Record<string, unknown>;
}

export interface RunInterjectRequest {
  runId: CancelRequest['runId'];
  text: string;
}

// 대기 중 스티어 취소 — 모델이 소비하기 전의 큐 항목을 receivedSeq로 지운다
interface RunInterjectCancelEnvelopeMessage {
  type: 'run.interject.cancel';
  requestId: string;
  request: Record<string, unknown>;
}

// 대기 중 스티어 즉시 반영 — 현재 라운드의 남은 도구 호출을 건너뛰고
// 다음 모델 호출 직전 소비 지점으로 최대한 빨리 도달하게 한다
interface RunInterjectFlushEnvelopeMessage {
  type: 'run.interject.flush';
  requestId: string;
  request: Record<string, unknown>;
}

// 아티팩트 프레임 발 read-only 도구 호출 — 프레임은 데이터(toolName/args)만
// 주고, 신뢰 컨텍스트(threadId, workingDirectory)는 부모(웹셸)가 자기 신뢰
// 상태에서 주입한다. 서버는 PTC와 공유하는 read-only 게이트 통과분만 실행한다.
interface RunToolEnvelopeMessage {
  type: 'run.tool';
  requestId: string;
  request: Record<string, unknown>;
}

export interface RunEventAckRequest {
  runId: RunEvent['runId'];
  threadId: RunEvent['threadId'];
  seq: number;
}

interface RunEventAckEnvelopeMessage {
  type: 'run.event.ack';
  requestId: string;
  request: RunEventAckRequest;
}

export interface RunToolRequest {
  threadId: ThreadId;
  toolName: string;
  args: Record<string, unknown>;
  scopeHandle: string;
  // 프레임이 만든 상관 id(af-N) — 결과를 프레임 pending 요청에 되돌릴 때 쓴다.
  frameRequestId: string;
  workingDirectory?: string;
}

export type RunToolResultPayload =
  | { ok: true; output: string }
  | {
      ok: false;
      // Daemon tool failures use ErrorCode. `unavailable` is owned by the
      // in-shell artifact-frame bridge when no tool channel is wired.
      errorCode: ErrorCode | 'unavailable';
      error: string;
    };

/**
 * Transport-level client messages. Envelope-only variants retain an opaque
 * request record until their capability-specific reader validates it.
 */
export type RunChannelClientMessage =
  | RunAuthMessage
  | RunStartMessage
  | RunCancelMessage
  | RunChildCancelMessage
  | RunThreadSubscribeMessage
  | RunApproveMessage
  | PlanWorkflowCommandMessage
  | GoalCommandMessage
  | RunInterjectEnvelopeMessage
  | RunInterjectCancelEnvelopeMessage
  | RunInterjectFlushEnvelopeMessage
  | RunEventAckEnvelopeMessage
  | RunToolEnvelopeMessage;

interface RunAuthOkMessage {
  type: 'run.auth.ok';
  requestId: string;
  ok: true;
  computerSessionId: string;
}

interface RunEventMessage {
  type: 'run.event';
  event: RunEvent;
}

export interface PlanningWorkflowMessage {
  type: 'plan.workflow';
  threadId: ThreadId;
  snapshot: PlanningWorkflowSnapshot | null;
}

export interface GoalStateMessage {
  type: 'goal.state';
  threadId: ThreadId;
  snapshot: GoalSnapshot | null;
}

export interface RunToolOutputDeltaMessage {
  type: 'run.tool.output.delta';
  runId: RunId;
  threadId: ThreadId;
  payload: ToolOutputDeltaEventPayload;
}

interface RunCancelControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.cancel';
  ok: true;
}

interface RunChildCancelControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.child.cancel';
  ok: true;
}

interface RunApproveControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.approve';
  ok: true;
}

interface PlanWorkflowCommandControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'plan.command';
  ok: true;
  commandKind: PlanWorkflowCommand['kind'];
  snapshot: PlanningWorkflowSnapshot | null;
  approvedPlanRef?: ApprovedPlanRef;
}

interface GoalCommandControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'goal.command';
  ok: true;
  commandKind: GoalCommand['kind'];
  snapshot: GoalSnapshot | null;
}

interface RunInterjectControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.interject';
  ok: true;
  receivedSeq: number;
  bufferDepth: number;
}

interface RunInterjectCancelControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.interject.cancel';
  ok: true;
  cancelled: boolean;
}

interface RunInterjectFlushControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.interject.flush';
  ok: true;
  // 큐에 항목이 있어 플러시가 예약되면 true, 큐가 비어 무의미하면 false
  flushed: boolean;
}

interface RunToolControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.tool';
  ok: true;
  // 도구 결과 v1 — 스트리밍 없이 requestId 상관 단일 응답
  result: RunToolResultPayload;
}

interface RunEventAckControlMessage {
  type: 'run.control';
  requestId: string;
  action: 'run.event.ack';
  ok: true;
  seq: number;
}

export type RunControlMessage =
  | RunCancelControlMessage
  | RunChildCancelControlMessage
  | RunApproveControlMessage
  | PlanWorkflowCommandControlMessage
  | GoalCommandControlMessage
  | RunInterjectControlMessage
  | RunInterjectCancelControlMessage
  | RunInterjectFlushControlMessage
  | RunEventAckControlMessage
  | RunToolControlMessage;

interface RunErrorMessage {
  type: 'run.error';
  requestId?: string;
  code: ErrorCode;
  message: string;
  status: number;
}

export type RunChannelServerMessage =
  | RunAuthOkMessage
  | RunEventMessage
  | PlanningWorkflowMessage
  | GoalStateMessage
  | RunToolOutputDeltaMessage
  | RunControlMessage
  | RunErrorMessage;

// Authentication is the one client message whose authority-bearing fields live
// directly on the transport envelope. Keep it exact so a misspelled or future
// auth selector cannot be silently ignored by an older daemon.
export function isRunAuthMessage(value: unknown): value is RunAuthMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'type',
      'requestId',
      'token',
      'runEventCursors',
      'threadSubscriptions',
    ]) &&
    value.type === 'run.auth' &&
    isString(value.requestId) &&
    isString(value.token) &&
    (value.runEventCursors === undefined ||
      (Array.isArray(value.runEventCursors) &&
        value.runEventCursors.every(isRunEventReplayCursor))) &&
    (value.threadSubscriptions === undefined ||
      (Array.isArray(value.threadSubscriptions) &&
        value.threadSubscriptions.every(
          (threadId) => isString(threadId) && isThreadId(threadId),
        )))
  );
}

function isRunEventReplayCursor(value: unknown): value is RunEventReplayCursor {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['runId', 'seq']) &&
    isString(value.runId) &&
    isRunId(value.runId) &&
    isRunEventSequence(value.seq)
  );
}

export function isRunCancelMessage(value: unknown): value is RunCancelMessage {
  return (
    isRecord(value) &&
    value.type === 'run.cancel' &&
    isString(value.requestId) &&
    isCancelRequest(value.request)
  );
}

export function isRunChildCancelMessage(
  value: unknown,
): value is RunChildCancelMessage {
  return (
    isRecord(value) &&
    value.type === 'run.child.cancel' &&
    isString(value.requestId) &&
    isRecord(value.request) &&
    hasOnlyKeys(value.request, ['parentRunId', 'childRunId']) &&
    isString(value.request.parentRunId) &&
    isRunId(value.request.parentRunId) &&
    isString(value.request.childRunId) &&
    isRunId(value.request.childRunId)
  );
}

export function isRunThreadSubscribeMessage(
  value: unknown,
): value is RunThreadSubscribeMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'requestId', 'request']) &&
    value.type === 'run.thread.subscribe' &&
    isString(value.requestId) &&
    isRecord(value.request) &&
    hasOnlyKeys(value.request, ['threadId']) &&
    isString(value.request.threadId) &&
    isThreadId(value.request.threadId)
  );
}

export function isRunApproveMessage(
  value: unknown,
): value is RunApproveMessage {
  return (
    isRecord(value) &&
    value.type === 'run.approve' &&
    isString(value.requestId) &&
    isApprovalRequest(value.request)
  );
}

export function isPlanWorkflowCommandMessage(
  value: unknown,
): value is PlanWorkflowCommandMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'requestId', 'request']) &&
    value.type === 'plan.command' &&
    isString(value.requestId) &&
    isPlanWorkflowCommand(value.request)
  );
}

export function isGoalCommandMessage(
  value: unknown,
): value is GoalCommandMessage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'requestId', 'request']) &&
    value.type === 'goal.command' &&
    isString(value.requestId) &&
    isGoalCommand(value.request)
  );
}

export function isRunStartMessage(value: unknown): value is RunStartMessage {
  return (
    isRecord(value) &&
    value.type === 'run.start' &&
    isString(value.requestId) &&
    isRunStartRequest(value.request)
  );
}

/**
 * These guards validate only the transport envelope. Extra envelope fields are
 * intentionally additive; each opaque request record is decoded by its
 * capability owner before dispatch, and that full decoder owns unknown-key
 * policy for the authority or mutation command itself.
 */
export function isRunInterjectEnvelope(
  value: unknown,
): value is RunInterjectEnvelopeMessage {
  return (
    isRecord(value) &&
    value.type === 'run.interject' &&
    isString(value.requestId) &&
    isRecord(value.request)
  );
}

export function isRunInterjectCancelEnvelope(
  value: unknown,
): value is RunInterjectCancelEnvelopeMessage {
  return (
    isRecord(value) &&
    value.type === 'run.interject.cancel' &&
    isString(value.requestId) &&
    isRecord(value.request)
  );
}

export function isRunInterjectFlushEnvelope(
  value: unknown,
): value is RunInterjectFlushEnvelopeMessage {
  return (
    isRecord(value) &&
    value.type === 'run.interject.flush' &&
    isString(value.requestId) &&
    isRecord(value.request)
  );
}

export function isRunToolEnvelope(
  value: unknown,
): value is RunToolEnvelopeMessage {
  return (
    isRecord(value) &&
    value.type === 'run.tool' &&
    isString(value.requestId) &&
    isRecord(value.request)
  );
}

function isRunEventSequence(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isRunEventAckRequest(value: unknown): value is RunEventAckRequest {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['runId', 'threadId', 'seq']) &&
    isString(value.runId) &&
    isRunId(value.runId) &&
    isString(value.threadId) &&
    isThreadId(value.threadId) &&
    isRunEventSequence(value.seq)
  );
}

export function isRunEventAckEnvelope(
  value: unknown,
): value is RunEventAckEnvelopeMessage {
  return (
    isRecord(value) &&
    value.type === 'run.event.ack' &&
    isString(value.requestId) &&
    isRunEventAckRequest(value.request)
  );
}

function isRunToolResultPayload(value: unknown): value is RunToolResultPayload {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    return isString(value.output);
  }
  return (
    value.ok === false &&
    (isErrorCode(value.errorCode) || value.errorCode === 'unavailable') &&
    isString(value.error)
  );
}

type RunControlAction = RunControlMessage['action'];
type RunControlEnvelopeField = 'type' | 'requestId' | 'action' | 'ok';
type RunControlMessageFor<TAction extends RunControlAction> = Extract<
  RunControlMessage,
  { action: TAction }
>;
// Adding an action or a required action-specific field must also add a
// compatible runtime guard, or this mapped type fails compilation.
type RunControlFieldGuardMap = {
  [TAction in RunControlAction]: {
    [TField in Exclude<
      keyof RunControlMessageFor<TAction>,
      RunControlEnvelopeField
    >]: (value: unknown) => value is RunControlMessageFor<TAction>[TField];
  };
};

const RUN_CONTROL_FIELD_GUARDS = {
  'run.cancel': {},
  'run.child.cancel': {},
  'run.approve': {},
  'plan.command': {
    commandKind: (value: unknown): value is PlanWorkflowCommand['kind'] =>
      value === 'approve' ||
      value === 'request_revision' ||
      value === 'explain_visual' ||
      value === 'cancel',
    snapshot: (value: unknown): value is PlanningWorkflowSnapshot | null =>
      value === null || isPlanningWorkflowSnapshot(value),
    approvedPlanRef: (value: unknown): value is ApprovedPlanRef | undefined =>
      value === undefined || isApprovedPlanRef(value),
  },
  'goal.command': {
    commandKind: (value: unknown): value is GoalCommand['kind'] =>
      value === 'pause' || value === 'resume' || value === 'cancel',
    snapshot: (value: unknown): value is GoalSnapshot | null =>
      value === null || isGoalSnapshot(value),
  },
  'run.interject': {
    receivedSeq: (value: unknown): value is number =>
      isNumber(value) && Number.isInteger(value) && value > 0,
    bufferDepth: (value: unknown): value is number =>
      isNumber(value) && Number.isInteger(value) && value >= 0,
  },
  'run.interject.cancel': {
    cancelled: isBoolean,
  },
  'run.interject.flush': {
    flushed: isBoolean,
  },
  'run.event.ack': {
    seq: isRunEventSequence,
  },
  'run.tool': {
    result: isRunToolResultPayload,
  },
} satisfies RunControlFieldGuardMap;

function isRunControlAction(value: string): value is RunControlAction {
  return Object.hasOwn(RUN_CONTROL_FIELD_GUARDS, value);
}

function hasValidRunControlFields(
  action: RunControlAction,
  value: Record<string, unknown>,
): boolean {
  const fieldGuards: Readonly<
    Record<string, (fieldValue: unknown) => boolean>
  > = RUN_CONTROL_FIELD_GUARDS[action];
  return Object.entries(fieldGuards).every(([field, isValid]) =>
    isValid(value[field]),
  );
}

// Server messages are informational projections. Their required semantic
// fields remain validated, while unknown fields are intentionally tolerated so
// an older shell can ignore additive diagnostics from a newer daemon.
export function isRunChannelServerMessage(
  value: unknown,
): value is RunChannelServerMessage {
  if (!isRecord(value) || !isString(value.type)) {
    return false;
  }

  switch (value.type) {
    case 'run.auth.ok':
      return (
        isString(value.requestId) &&
        value.ok === true &&
        isString(value.computerSessionId) &&
        value.computerSessionId.trim().length > 0
      );
    case 'run.event':
      return isRunEvent(value.event);
    case 'plan.workflow':
      return (
        isString(value.threadId) &&
        isThreadId(value.threadId) &&
        (value.snapshot === null ||
          (isPlanningWorkflowSnapshot(value.snapshot) &&
            value.snapshot.threadId === value.threadId))
      );
    case 'goal.state':
      return (
        isString(value.threadId) &&
        isThreadId(value.threadId) &&
        (value.snapshot === null ||
          (isGoalSnapshot(value.snapshot) &&
            value.snapshot.threadId === value.threadId))
      );
    case 'run.tool.output.delta':
      return (
        isString(value.runId) &&
        isRunId(value.runId) &&
        isString(value.threadId) &&
        isThreadId(value.threadId) &&
        isToolOutputDeltaEventPayload(value.payload)
      );
    case 'run.control': {
      if (
        !isString(value.requestId) ||
        !isString(value.action) ||
        !isRunControlAction(value.action) ||
        value.ok !== true
      ) {
        return false;
      }
      return hasValidRunControlFields(value.action, value);
    }
    case 'run.error':
      return (
        (value.requestId === undefined || isString(value.requestId)) &&
        isErrorCode(value.code) &&
        isString(value.message) &&
        isNumber(value.status)
      );
    default:
      return false;
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
