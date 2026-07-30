// 런 체크포인트의 **영속 형식**을 소유한다.
//
// `run-checkpoint-store`는 스레드당 파일 하나를 원자적으로 교체하며 상태를
// 전이시키고, 이 파일은 그 파일에서 읽은 신뢰할 수 없는 값을 도메인 값으로
// 바꾸는 경계를 소유한다. 형식이 바뀌면 여기만 바뀐다.
//
// 내보내는 것은 레코드 형식(스키마 버전과 타입)과 읽기 진입점
// `parseRunCheckpoint`·`isMissingFileError`뿐이다. 그 아래 하위 파서들은 이
// 파일 안에 갇혀 있고, 바깥에서 부분 파싱을 조립할 수 없다.
//
// 파싱은 fail-closed다. 저장된 값이 형식을 어기면 조용히 기본값으로 넘기지
// 않고 거부한다 — 복구가 잘못된 상태를 이어가는 것보다 낫다.

import {
  assertRunId,
  assertThreadId,
  isRunId,
  isThreadId,
  type RunId,
  type ThreadId,
} from '@geulbat/protocol/ids';
import {
  isImageGenerationModelId,
  isRunModelId,
  isRunProviderId,
  isRunProviderTransitionRecovery,
  isRunReasoningEffort,
  isRunServiceTier,
  isRunSubagentModelRouting,
  isVideoGenerationModelId,
  isVideoGenerationSettings,
  resolveRunModelDescriptor,
  type ImageGenerationModelId,
  type RunProviderTransitionRecovery,
  type RunProviderId,
  type RunReasoningEffort,
  type RunServiceTier,
  type RunSubagentModelRouting,
  type VideoGenerationModelId,
  type VideoGenerationSettings,
} from '@geulbat/protocol/run-contract';
import {
  isApprovalClass,
  isApprovalGrantScope,
  isPermissionMode,
  type ApprovalClass,
  type ApprovalGrantScope,
  type PermissionMode,
} from '@geulbat/protocol/run-approval';
import { isErrorEventPayload } from '@geulbat/protocol/run-events';
import {
  isApprovedPlanRef,
  type ApprovedPlanRef,
} from '@geulbat/protocol/planning-workflow';
import {
  isModelSettlementIdentity,
  type ModelSettlementIdentity,
} from '@geulbat/protocol/thread-metadata';
import {
  validateToolCapabilityPolicy,
  type ToolCapabilityPolicy,
} from '@geulbat/tool-library/tool-capability-policy';
import type { ToolLibraryProjectionIdentity } from '@geulbat/tool-library/projection-codec';
import { isJsonValue, isRecord, type JsonValue } from '../runtime-json.js';

import {
  isToolRecoveryStrategy,
  parseExecuteResult,
  type RunCheckpointToolInvocation,
  type TerminalAgentEvent,
} from '../runtime-contracts.js';
import type { PendingInterject } from './active-run-interject-buffer.js';
import type { RunCheckpointEvent } from './run-event-journal.js';

export const RUN_CHECKPOINT_SCHEMA_VERSION = 1;
export const RUN_CHECKPOINT_MODEL_SETTLEMENT_SOURCES = [
  'aborted',
  'blocked',
  'model_failure',
  'no_progress',
  'structured_output_failure',
  'structured_output',
  'structured_output_unhandled',
  'natural',
  'tool_completion',
  'tool_failure',
  'verification_unavailable',
] as const;
export type RunCheckpointModelSettlementSource =
  (typeof RUN_CHECKPOINT_MODEL_SETTLEMENT_SOURCES)[number];
const SHA256_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export interface RecoverableRunRequest {
  workingDirectory?: string;
  permissionMode: PermissionMode;
  planningWorkflow?: {
    workflowId: string;
  };
  approvedPlanRef?: ApprovedPlanRef;
  goal?: {
    goalId: string;
  };
  loopImplementation?: {
    readonly implementationId: string;
    readonly contractVersion: string;
  };
  providerModel?: { providerId: RunProviderId; model: string };
  providerTransitionRecovery?: RunProviderTransitionRecovery;
  currentFile?: string;
  selection?: { startLine: number; endLine: number; text: string };
  ultraReasoning?: boolean;
  reasoningEffort?: RunReasoningEffort;
  serviceTier?: RunServiceTier;
  subagentModelRouting?: RunSubagentModelRouting;
  toolSurface?: {
    directRegistryNames: string[];
    allowedRegistryNames: string[];
  };
  toolCapabilityPolicy?: ToolCapabilityPolicy;
  toolLibraryProjectionIdentity?: ToolLibraryProjectionIdentity;
  imageGenerationModel?: ImageGenerationModelId;
  videoGenerationModel?: VideoGenerationModelId;
  videoGenerationSettings?: VideoGenerationSettings;
  backgroundChild?: {
    parentRunId: RunId;
    ownerThreadId: ThreadId;
    computerSessionId: string;
    timeoutAt?: string;
  };
}

export type RunCheckpointApproval =
  | {
      status: 'pending';
      callId: string;
      approvalClass: ApprovalClass;
    }
  | {
      status: 'decided';
      callId: string;
      approvalClass: ApprovalClass;
      decision: 'approved' | 'denied';
      grantScope: ApprovalGrantScope;
    }
  | {
      status: 'decided';
      callId: string;
      approvalClass: ApprovalClass;
      decision: 'aborted';
    };

export type RunCheckpointTerminalEvent = TerminalAgentEvent;

export interface RunCheckpointToolResultReady {
  callId: string;
  toolName: string;
  resultRef: string;
}

export interface RunCheckpointTerminalSnapshot {
  event: RunCheckpointTerminalEvent;
  eventCursor: number;
  acknowledged: boolean;
  modelSettlementIdentity?: ModelSettlementIdentity;
}

export type RunCheckpointModelRoundPhase =
  | 'prepared'
  | 'streaming'
  | 'terminal_observed';

export interface RunCheckpointModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface RunCheckpointModelRoundSettlement {
  candidateDigest: `sha256:${string}`;
  usage: RunCheckpointModelUsage;
  phase: 'candidate_recorded' | 'effects_started' | 'committed';
  resultDigest: `sha256:${string}` | null;
  result: JsonValue | null;
  disposition: 'continue' | 'terminal' | null;
  source: RunCheckpointModelSettlementSource | null;
  committedAt: string | null;
  continuationHistoryText: string | null;
}

export interface RunCheckpointModelRoundContinuation {
  round: number;
  logicalRequestIdentity: ModelSettlementIdentity;
  historyText: string;
}

export interface RunCheckpointActiveModelRound {
  round: number;
  claimId: string;
  claimRevision: number;
  modelRoundAttempt: number;
  providerRequestAttempt: number;
  providerId: RunProviderId;
  model: string;
  transportKind: 'websocket' | 'http_json_sse';
  providerRequestIdentity: string;
  contextDigest: `sha256:${string}`;
  toolLibraryProjectionIdentity: ToolLibraryProjectionIdentity;
  responseFormat: null;
  providerReplayScopeId: `sha256:${string}` | null;
  phase: RunCheckpointModelRoundPhase;
  logicalRequestIdentity: ModelSettlementIdentity | null;
  settlement: RunCheckpointModelRoundSettlement | null;
}

export interface RunCheckpointModelRoundState {
  nextRound: number;
  active: RunCheckpointActiveModelRound | null;
  settledUsage: RunCheckpointModelUsage;
  continuation: RunCheckpointModelRoundContinuation | null;
}

export interface RunCheckpoint {
  schemaVersion: typeof RUN_CHECKPOINT_SCHEMA_VERSION;
  revision: number;
  status: 'running' | 'terminal';
  runId: RunId;
  threadId: ThreadId;
  request: RecoverableRunRequest;
  interjectSeq: number;
  applyingInterject: PendingInterject | null;
  pendingInterjects: PendingInterject[];
  approvals: RunCheckpointApproval[];
  toolInvocations: RunCheckpointToolInvocation[];
  toolResultsReady: RunCheckpointToolResultReady[];
  modelRoundState: RunCheckpointModelRoundState | null;
  eventHistory: RunCheckpointEvent[];
  terminal: RunCheckpointTerminalSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

export function parseRunCheckpoint(value: unknown): RunCheckpoint {
  if (
    !isRecord(value) ||
    value.schemaVersion !== RUN_CHECKPOINT_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.revision !== 'number' ||
    value.revision < 1 ||
    (value.status !== 'running' && value.status !== 'terminal') ||
    typeof value.runId !== 'string' ||
    !isRunId(value.runId) ||
    typeof value.threadId !== 'string' ||
    !isThreadId(value.threadId) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    throw new Error('invalid run checkpoint');
  }
  const interjectSeq = parseInterjectSeq(value.interjectSeq);
  const applyingInterject =
    value.applyingInterject === undefined || value.applyingInterject === null
      ? null
      : parsePendingInterject(value.applyingInterject);
  const pendingInterjects =
    value.pendingInterjects === undefined
      ? []
      : parsePendingInterjects(value.pendingInterjects);
  const approvals =
    value.approvals === undefined
      ? []
      : parseCheckpointApprovals(value.approvals);
  const toolInvocations =
    value.toolInvocations === undefined
      ? []
      : parseCheckpointToolInvocations(value.toolInvocations);
  const toolResultsReady =
    value.toolResultsReady === undefined
      ? []
      : parseCheckpointToolResultsReady(value.toolResultsReady);
  const modelRoundState =
    value.modelRoundState === undefined || value.modelRoundState === null
      ? null
      : parseCheckpointModelRoundState(value.modelRoundState);
  const terminal =
    value.terminal === undefined || value.terminal === null
      ? null
      : parseRunCheckpointTerminalSnapshot(value.terminal);
  if (value.status === 'running' && terminal !== null) {
    throw new Error('running checkpoint cannot have terminal snapshot');
  }
  if (value.status === 'terminal' && toolResultsReady.length > 0) {
    throw new Error('terminal checkpoint cannot have ready tool results');
  }
  if (value.status === 'terminal' && toolInvocations.length > 0) {
    throw new Error(
      'terminal checkpoint cannot have unsettled tool invocations',
    );
  }
  const orderedInterjects = [
    ...(applyingInterject === null ? [] : [applyingInterject]),
    ...pendingInterjects,
  ];
  if (
    orderedInterjects.some(
      (interject, index) =>
        interject.receivedSeq > interjectSeq ||
        (index > 0 &&
          interject.receivedSeq <=
            (orderedInterjects[index - 1]?.receivedSeq ?? 0)),
    )
  ) {
    throw new Error('invalid run checkpoint interject order');
  }
  return {
    schemaVersion: RUN_CHECKPOINT_SCHEMA_VERSION,
    revision: value.revision,
    status: value.status,
    runId: assertRunId(value.runId),
    threadId: assertThreadId(value.threadId),
    request: parseRecoverableRunRequest(value.request),
    interjectSeq,
    applyingInterject,
    pendingInterjects,
    approvals,
    toolInvocations,
    toolResultsReady,
    modelRoundState,
    eventHistory: [],
    terminal,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseCheckpointModelRoundState(
  value: unknown,
): RunCheckpointModelRoundState {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.nextRound) ||
    typeof value.nextRound !== 'number' ||
    value.nextRound < 0
  ) {
    throw new Error('invalid run checkpoint model round state');
  }
  const active =
    value.active === null
      ? null
      : parseCheckpointActiveModelRound(value.active);
  if (active !== null && active.round !== value.nextRound) {
    throw new Error('active model round does not match the durable cursor');
  }
  const continuation =
    value.continuation === undefined || value.continuation === null
      ? null
      : parseCheckpointModelRoundContinuation(value.continuation);
  if (continuation !== null && continuation.round + 1 !== value.nextRound) {
    throw new Error(
      'model round continuation does not precede the durable cursor',
    );
  }
  return {
    nextRound: value.nextRound,
    active,
    settledUsage:
      value.settledUsage === undefined
        ? createEmptyCheckpointModelUsage()
        : parseCheckpointModelUsage(value.settledUsage),
    continuation,
  };
}

function parseCheckpointModelRoundContinuation(
  value: unknown,
): RunCheckpointModelRoundContinuation {
  if (
    !isRecord(value) ||
    !isNonNegativeSafeInteger(value.round) ||
    !isModelSettlementIdentity(value.logicalRequestIdentity) ||
    typeof value.historyText !== 'string'
  ) {
    throw new Error('invalid model round continuation');
  }
  return {
    round: value.round,
    logicalRequestIdentity: value.logicalRequestIdentity,
    historyText: value.historyText,
  };
}

function parseCheckpointActiveModelRound(
  value: unknown,
): RunCheckpointActiveModelRound {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.round) ||
    typeof value.round !== 'number' ||
    value.round < 0 ||
    typeof value.claimId !== 'string' ||
    value.claimId.trim() === '' ||
    !Number.isSafeInteger(value.claimRevision) ||
    typeof value.claimRevision !== 'number' ||
    value.claimRevision < 1 ||
    !Number.isSafeInteger(value.modelRoundAttempt) ||
    typeof value.modelRoundAttempt !== 'number' ||
    value.modelRoundAttempt < 0 ||
    !Number.isSafeInteger(value.providerRequestAttempt) ||
    typeof value.providerRequestAttempt !== 'number' ||
    value.providerRequestAttempt < 0 ||
    !isRunProviderId(value.providerId) ||
    typeof value.model !== 'string' ||
    value.model.trim() === '' ||
    (value.transportKind !== 'websocket' &&
      value.transportKind !== 'http_json_sse') ||
    typeof value.providerRequestIdentity !== 'string' ||
    !SHA256_HEX_PATTERN.test(value.providerRequestIdentity) ||
    typeof value.contextDigest !== 'string' ||
    !isSha256Id(value.contextDigest) ||
    value.responseFormat !== null ||
    (value.providerReplayScopeId !== null &&
      (typeof value.providerReplayScopeId !== 'string' ||
        !isSha256Id(value.providerReplayScopeId))) ||
    (value.phase !== 'prepared' &&
      value.phase !== 'streaming' &&
      value.phase !== 'terminal_observed')
  ) {
    throw new Error('invalid active model round checkpoint');
  }
  const toolLibraryProjectionIdentity =
    parseCheckpointToolLibraryProjectionIdentity(
      value.toolLibraryProjectionIdentity,
    );
  if (toolLibraryProjectionIdentity === undefined) {
    throw new Error('active model round requires a tool projection identity');
  }
  const logicalRequestIdentity =
    value.logicalRequestIdentity === undefined ||
    value.logicalRequestIdentity === null
      ? null
      : isModelSettlementIdentity(value.logicalRequestIdentity)
        ? value.logicalRequestIdentity
        : undefined;
  if (logicalRequestIdentity === undefined) {
    throw new Error('invalid active model round logical request identity');
  }
  const settlement =
    value.settlement === undefined || value.settlement === null
      ? null
      : parseCheckpointModelRoundSettlement(value.settlement);
  if (settlement !== null && logicalRequestIdentity === null) {
    throw new Error('model round settlement requires a logical identity');
  }
  return {
    round: value.round,
    claimId: value.claimId,
    claimRevision: value.claimRevision,
    modelRoundAttempt: value.modelRoundAttempt,
    providerRequestAttempt: value.providerRequestAttempt,
    providerId: value.providerId,
    model: value.model,
    transportKind: value.transportKind,
    providerRequestIdentity: value.providerRequestIdentity,
    contextDigest: value.contextDigest,
    toolLibraryProjectionIdentity,
    responseFormat: null,
    providerReplayScopeId: value.providerReplayScopeId,
    phase: value.phase,
    logicalRequestIdentity,
    settlement,
  };
}

function parseCheckpointModelRoundSettlement(
  value: unknown,
): RunCheckpointModelRoundSettlement {
  if (
    !isRecord(value) ||
    typeof value.candidateDigest !== 'string' ||
    !isSha256Id(value.candidateDigest) ||
    (value.phase !== 'candidate_recorded' &&
      value.phase !== 'effects_started' &&
      value.phase !== 'committed')
  ) {
    throw new Error('invalid model round settlement');
  }
  const usage = parseCheckpointModelUsage(value.usage);
  if (value.phase !== 'committed') {
    if (
      value.resultDigest !== null ||
      value.result !== null ||
      value.disposition !== null ||
      value.source !== null ||
      value.continuationHistoryText !== null
    ) {
      throw new Error('uncommitted model round settlement contains a result');
    }
    return {
      candidateDigest: value.candidateDigest,
      usage,
      phase: value.phase,
      resultDigest: null,
      result: null,
      disposition: null,
      source: null,
      committedAt: null,
      continuationHistoryText: null,
    };
  }
  if (
    typeof value.resultDigest !== 'string' ||
    !isSha256Id(value.resultDigest) ||
    !isJsonValue(value.result) ||
    (value.disposition !== 'continue' && value.disposition !== 'terminal') ||
    !isRunCheckpointModelSettlementSource(value.source) ||
    typeof value.committedAt !== 'string' ||
    !isCanonicalTimestamp(value.committedAt) ||
    (value.continuationHistoryText !== null &&
      typeof value.continuationHistoryText !== 'string') ||
    (value.disposition === 'terminal' && value.continuationHistoryText !== null)
  ) {
    throw new Error('invalid committed model round settlement');
  }
  return {
    candidateDigest: value.candidateDigest,
    usage,
    phase: 'committed',
    resultDigest: value.resultDigest,
    result: value.result,
    disposition: value.disposition,
    source: value.source,
    committedAt: value.committedAt,
    continuationHistoryText: value.continuationHistoryText,
  };
}

function parseCheckpointModelUsage(value: unknown): RunCheckpointModelUsage {
  if (
    !isRecord(value) ||
    !isNonNegativeSafeInteger(value.inputTokens) ||
    !isNonNegativeSafeInteger(value.outputTokens) ||
    !isNonNegativeSafeInteger(value.cachedInputTokens)
  ) {
    throw new Error('invalid run checkpoint model usage');
  }
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cachedInputTokens: value.cachedInputTokens,
  };
}

function createEmptyCheckpointModelUsage(): RunCheckpointModelUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isRunCheckpointModelSettlementSource(
  value: unknown,
): value is RunCheckpointModelSettlementSource {
  return (
    typeof value === 'string' &&
    (RUN_CHECKPOINT_MODEL_SETTLEMENT_SOURCES as readonly string[]).includes(
      value,
    )
  );
}

function parseRunCheckpointTerminalSnapshot(
  value: unknown,
): RunCheckpointTerminalSnapshot {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.eventCursor) ||
    typeof value.eventCursor !== 'number' ||
    value.eventCursor < 0 ||
    typeof value.acknowledged !== 'boolean' ||
    !isRecord(value.event) ||
    !isRecord(value.event.payload)
  ) {
    throw new Error('invalid run checkpoint terminal snapshot');
  }
  const modelSettlementIdentity =
    value.modelSettlementIdentity === undefined
      ? undefined
      : isModelSettlementIdentity(value.modelSettlementIdentity)
        ? value.modelSettlementIdentity
        : null;
  if (modelSettlementIdentity === null) {
    throw new Error('invalid terminal model settlement identity');
  }
  if (
    value.event.type === 'done' &&
    typeof value.event.payload.answer === 'string' &&
    typeof value.event.payload.ok === 'boolean'
  ) {
    return {
      eventCursor: value.eventCursor,
      acknowledged: value.acknowledged,
      ...(modelSettlementIdentity === undefined
        ? {}
        : { modelSettlementIdentity }),
      event: {
        type: 'done',
        payload: {
          answer: value.event.payload.answer,
          ok: value.event.payload.ok,
        },
      },
    };
  }
  if (
    value.event.type === 'error' &&
    isErrorEventPayload(value.event.payload)
  ) {
    return {
      eventCursor: value.eventCursor,
      acknowledged: value.acknowledged,
      ...(modelSettlementIdentity === undefined
        ? {}
        : { modelSettlementIdentity }),
      event: {
        type: 'error',
        payload: value.event.payload,
      },
    };
  }
  throw new Error('invalid run checkpoint terminal event');
}

function parseInterjectSeq(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid run checkpoint interject sequence');
  }
  return value;
}

function parsePendingInterjects(value: unknown): PendingInterject[] {
  if (!Array.isArray(value)) {
    throw new Error('invalid run checkpoint pending interjects');
  }
  return value.map(parsePendingInterject);
}

function parsePendingInterject(value: unknown): PendingInterject {
  if (
    !isRecord(value) ||
    typeof value.text !== 'string' ||
    typeof value.receivedSeq !== 'number' ||
    !Number.isSafeInteger(value.receivedSeq) ||
    value.receivedSeq < 1
  ) {
    throw new Error('invalid run checkpoint pending interject');
  }
  return { text: value.text, receivedSeq: value.receivedSeq };
}

function parseCheckpointApprovals(value: unknown): RunCheckpointApproval[] {
  if (!Array.isArray(value)) {
    throw new Error('invalid run checkpoint approvals');
  }
  const approvals = value.map(parseCheckpointApproval);
  if (
    new Set(approvals.map((approval) => approval.callId)).size !==
    approvals.length
  ) {
    throw new Error('invalid run checkpoint approval identities');
  }
  return approvals;
}

function parseCheckpointApproval(value: unknown): RunCheckpointApproval {
  if (
    !isRecord(value) ||
    typeof value.callId !== 'string' ||
    value.callId.length === 0 ||
    !isApprovalClass(value.approvalClass)
  ) {
    throw new Error('invalid run checkpoint approval');
  }
  if (value.status === 'pending') {
    return {
      status: value.status,
      callId: value.callId,
      approvalClass: value.approvalClass,
    };
  }
  if (
    value.status === 'decided' &&
    (value.decision === 'approved' || value.decision === 'denied') &&
    isApprovalGrantScope(value.grantScope)
  ) {
    return {
      status: value.status,
      callId: value.callId,
      approvalClass: value.approvalClass,
      decision: value.decision,
      grantScope: value.grantScope,
    };
  }
  if (value.status === 'decided' && value.decision === 'aborted') {
    return {
      status: value.status,
      callId: value.callId,
      approvalClass: value.approvalClass,
      decision: value.decision,
    };
  }
  throw new Error('invalid run checkpoint approval state');
}

function parseCheckpointToolInvocations(
  value: unknown,
): RunCheckpointToolInvocation[] {
  if (!Array.isArray(value)) {
    throw new Error('invalid run checkpoint tool invocations');
  }
  const invocations = value.map(parseCheckpointToolInvocation);
  if (
    new Set(invocations.map((invocation) => invocation.callId)).size !==
    invocations.length
  ) {
    throw new Error('invalid run checkpoint tool invocation identities');
  }
  return invocations;
}

function parseCheckpointToolInvocation(
  value: unknown,
): RunCheckpointToolInvocation {
  if (
    !isRecord(value) ||
    typeof value.callId !== 'string' ||
    value.callId.length === 0 ||
    typeof value.toolName !== 'string' ||
    value.toolName.length === 0 ||
    !isToolRecoveryStrategy(value.recoveryStrategy) ||
    !isJsonValue(value.recoveryState)
  ) {
    throw new Error('invalid run checkpoint tool invocation');
  }
  const recoveryState = structuredClone(value.recoveryState);
  if (value.status === 'in_flight' && value.result === undefined) {
    return {
      status: 'in_flight',
      callId: value.callId,
      toolName: value.toolName,
      recoveryStrategy: value.recoveryStrategy,
      recoveryState,
    };
  }
  const result =
    value.status === 'reconciled' ? parseExecuteResult(value.result) : null;
  if (result === null) {
    throw new Error('invalid run checkpoint tool invocation result');
  }
  return {
    status: 'reconciled',
    callId: value.callId,
    toolName: value.toolName,
    recoveryStrategy: value.recoveryStrategy,
    recoveryState,
    result,
  };
}

function parseCheckpointToolResultsReady(
  value: unknown,
): RunCheckpointToolResultReady[] {
  if (!Array.isArray(value)) {
    throw new Error('invalid run checkpoint ready tool results');
  }
  const ready = value.map(parseCheckpointToolResultReady);
  if (
    new Set(ready.map((result) => result.callId)).size !== ready.length ||
    new Set(ready.map((result) => result.resultRef)).size !== ready.length
  ) {
    throw new Error('invalid run checkpoint ready tool result identities');
  }
  return ready;
}

function parseCheckpointToolResultReady(
  value: unknown,
): RunCheckpointToolResultReady {
  if (
    !isRecord(value) ||
    typeof value.callId !== 'string' ||
    value.callId.length === 0 ||
    typeof value.toolName !== 'string' ||
    value.toolName.length === 0 ||
    typeof value.resultRef !== 'string' ||
    value.resultRef.length === 0
  ) {
    throw new Error('invalid run checkpoint ready tool result');
  }
  return {
    callId: value.callId,
    toolName: value.toolName,
    resultRef: value.resultRef,
  };
}

function parseRecoverableRunRequest(value: unknown): RecoverableRunRequest {
  if (
    !isRecord(value) ||
    (value.workingDirectory !== undefined &&
      typeof value.workingDirectory !== 'string') ||
    !isPermissionMode(value.permissionMode)
  ) {
    throw new Error('invalid recoverable run request');
  }
  const providerModel = parseProviderModel(value.providerModel);
  const providerTransitionRecovery = parseProviderTransitionRecovery(
    value.providerTransitionRecovery,
    providerModel,
  );
  const loopImplementation = parseAgentLoopImplementationIdentity(
    value.loopImplementation,
  );
  const selection = parseSelection(value.selection);
  const toolSurface = parseToolSurface(value.toolSurface);
  const toolCapabilityPolicy = parseCheckpointToolCapabilityPolicy(
    value.toolCapabilityPolicy,
  );
  const toolLibraryProjectionIdentity =
    parseCheckpointToolLibraryProjectionIdentity(
      value.toolLibraryProjectionIdentity,
    );
  const planningWorkflow = parsePlanningWorkflowBinding(value.planningWorkflow);
  const goal = parseGoalBinding(value.goal);
  const backgroundChild = parseBackgroundChildBinding(value.backgroundChild);
  if (
    (value.currentFile !== undefined &&
      typeof value.currentFile !== 'string') ||
    (value.ultraReasoning !== undefined &&
      typeof value.ultraReasoning !== 'boolean') ||
    (value.reasoningEffort !== undefined &&
      !isRunReasoningEffort(value.reasoningEffort)) ||
    (value.serviceTier !== undefined && !isRunServiceTier(value.serviceTier)) ||
    (value.serviceTier === 'fast' &&
      providerModel?.providerId !== 'openai_codex_direct') ||
    (value.subagentModelRouting !== undefined &&
      !isRunSubagentModelRouting(value.subagentModelRouting)) ||
    (value.imageGenerationModel !== undefined &&
      !isImageGenerationModelId(value.imageGenerationModel)) ||
    (value.videoGenerationModel !== undefined &&
      !isVideoGenerationModelId(value.videoGenerationModel)) ||
    (value.videoGenerationSettings !== undefined &&
      !isVideoGenerationSettings(value.videoGenerationSettings)) ||
    (value.approvedPlanRef !== undefined &&
      !isApprovedPlanRef(value.approvedPlanRef)) ||
    (planningWorkflow !== undefined && value.approvedPlanRef !== undefined) ||
    (planningWorkflow !== undefined && goal !== undefined)
  ) {
    throw new Error('invalid recoverable run request');
  }
  if (toolSurface !== undefined && toolCapabilityPolicy !== undefined) {
    throw new Error(
      'recoverable run request cannot contain both toolSurface and toolCapabilityPolicy',
    );
  }
  return {
    ...(value.workingDirectory === undefined
      ? {}
      : { workingDirectory: value.workingDirectory }),
    permissionMode: value.permissionMode,
    ...(planningWorkflow === undefined ? {} : { planningWorkflow }),
    ...(value.approvedPlanRef === undefined
      ? {}
      : { approvedPlanRef: value.approvedPlanRef }),
    ...(goal === undefined ? {} : { goal }),
    ...(loopImplementation === undefined ? {} : { loopImplementation }),
    ...(providerModel === undefined ? {} : { providerModel }),
    ...(providerTransitionRecovery === undefined
      ? {}
      : { providerTransitionRecovery }),
    ...(value.currentFile === undefined
      ? {}
      : { currentFile: value.currentFile }),
    ...(selection === undefined ? {} : { selection }),
    ...(value.ultraReasoning === undefined
      ? {}
      : { ultraReasoning: value.ultraReasoning }),
    ...(value.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: value.reasoningEffort }),
    ...(value.serviceTier === undefined
      ? {}
      : { serviceTier: value.serviceTier }),
    ...(value.subagentModelRouting === undefined
      ? {}
      : { subagentModelRouting: value.subagentModelRouting }),
    ...(toolSurface === undefined ? {} : { toolSurface }),
    ...(toolCapabilityPolicy === undefined ? {} : { toolCapabilityPolicy }),
    ...(toolLibraryProjectionIdentity === undefined
      ? {}
      : { toolLibraryProjectionIdentity }),
    ...(value.imageGenerationModel === undefined
      ? {}
      : { imageGenerationModel: value.imageGenerationModel }),
    ...(value.videoGenerationModel === undefined
      ? {}
      : { videoGenerationModel: value.videoGenerationModel }),
    ...(value.videoGenerationSettings === undefined
      ? {}
      : { videoGenerationSettings: value.videoGenerationSettings }),
    ...(backgroundChild === undefined ? {} : { backgroundChild }),
  };
}

function parseBackgroundChildBinding(
  value: unknown,
): RecoverableRunRequest['backgroundChild'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.parentRunId !== 'string' ||
    !isRunId(value.parentRunId) ||
    typeof value.ownerThreadId !== 'string' ||
    !isThreadId(value.ownerThreadId) ||
    typeof value.computerSessionId !== 'string' ||
    value.computerSessionId.trim().length === 0 ||
    (value.timeoutAt !== undefined &&
      (typeof value.timeoutAt !== 'string' ||
        !isCanonicalTimestamp(value.timeoutAt)))
  ) {
    throw new Error('invalid recoverable background child binding');
  }
  return {
    parentRunId: assertRunId(value.parentRunId),
    ownerThreadId: assertThreadId(value.ownerThreadId),
    computerSessionId: value.computerSessionId,
    ...(value.timeoutAt === undefined ? {} : { timeoutAt: value.timeoutAt }),
  };
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function parsePlanningWorkflowBinding(
  value: unknown,
): RecoverableRunRequest['planningWorkflow'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.workflowId !== 'string' ||
    value.workflowId.trim() === ''
  ) {
    throw new Error('invalid recoverable planning workflow binding');
  }
  return {
    workflowId: value.workflowId,
  };
}

function parseGoalBinding(value: unknown): RecoverableRunRequest['goal'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.goalId !== 'string' ||
    value.goalId.trim() === ''
  ) {
    throw new Error('invalid recoverable Goal binding');
  }
  return {
    goalId: value.goalId,
  };
}

function parseProviderTransitionRecovery(
  value: unknown,
  target: RecoverableRunRequest['providerModel'],
): RunProviderTransitionRecovery | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    target === undefined ||
    !isRunModelId(target.model) ||
    resolveRunModelDescriptor(target.model).providerId !== target.providerId ||
    !isRunProviderTransitionRecovery(value, target.model)
  ) {
    throw new Error('invalid recoverable provider transition recovery');
  }
  return value;
}

function parseAgentLoopImplementationIdentity(
  value: unknown,
): RecoverableRunRequest['loopImplementation'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.implementationId !== 'string' ||
    value.implementationId.trim().length === 0 ||
    typeof value.contractVersion !== 'string' ||
    value.contractVersion.trim().length === 0
  ) {
    throw new Error('invalid recoverable agent loop implementation identity');
  }
  return {
    implementationId: value.implementationId,
    contractVersion: value.contractVersion,
  };
}

function parseProviderModel(
  value: unknown,
): RecoverableRunRequest['providerModel'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !isRunProviderId(value.providerId) ||
    typeof value.model !== 'string'
  ) {
    throw new Error('invalid run checkpoint provider model');
  }
  return { providerId: value.providerId, model: value.model };
}

function parseSelection(value: unknown): RecoverableRunRequest['selection'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !Number.isInteger(value.startLine) ||
    typeof value.startLine !== 'number' ||
    !Number.isInteger(value.endLine) ||
    typeof value.endLine !== 'number' ||
    typeof value.text !== 'string'
  ) {
    throw new Error('invalid run checkpoint selection');
  }
  return {
    startLine: value.startLine,
    endLine: value.endLine,
    text: value.text,
  };
}

function parseCheckpointToolCapabilityPolicy(
  value: unknown,
): ToolCapabilityPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return validateToolCapabilityPolicy(value);
  } catch {
    throw new Error('invalid run checkpoint tool capability policy');
  }
}

function parseCheckpointToolLibraryProjectionIdentity(
  value: unknown,
): ToolLibraryProjectionIdentity | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    typeof value.sdkVersion !== 'string' ||
    value.sdkVersion.trim().length === 0 ||
    !isSha256Id(value.sdkProjectionHash) ||
    typeof value.policyId !== 'string' ||
    value.policyId.trim().length === 0
  ) {
    throw new Error('invalid recoverable tool library projection identity');
  }
  return {
    sdkVersion: value.sdkVersion,
    sdkProjectionHash: value.sdkProjectionHash,
    policyId: value.policyId,
  };
}

function isSha256Id(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && SHA256_ID_PATTERN.test(value);
}

function parseToolSurface(
  value: unknown,
): RecoverableRunRequest['toolSurface'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !isStringArray(value.directRegistryNames) ||
    !isStringArray(value.allowedRegistryNames)
  ) {
    throw new Error('invalid run checkpoint tool surface');
  }
  return {
    directRegistryNames: [...value.directRegistryNames],
    allowedRegistryNames: [...value.allowedRegistryNames],
  };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

export function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
