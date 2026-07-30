import type {
  SharedRunEventPayloadMap,
  ToolOutputDeltaEventPayload,
} from '@geulbat/protocol/run-events';
import {
  isErrorCode,
  isToolFailureDiagnostics,
  type ErrorCode,
  type ToolFailureDiagnostics,
} from '@geulbat/protocol/errors';
import type { AgentChildTerminalState } from '@geulbat/protocol/subagent-terminal';
import type { RunId } from '@geulbat/protocol/ids';
import type { RunProviderId } from '@geulbat/protocol/run-contract';
import type { JsonValue } from '@geulbat/protocol/runtime-persistence';
import {
  isProviderReplayScopeId as isProtocolProviderReplayScopeId,
  type ProviderReplayScopeId,
} from '@geulbat/protocol/provider-auth';

export type { ProviderReplayScopeId, RunProviderId };

export function isProviderReplayScopeId(
  value: unknown,
): value is ProviderReplayScopeId {
  return isProtocolProviderReplayScopeId(value);
}

export type ToolCallArgs = SharedRunEventPayloadMap['tool_call']['args'];

export type ToolRecoveryStrategy =
  | 'replay_safe'
  | 'idempotency_key'
  | 'reconcile_then_replay'
  | 'durable_handle'
  | 'at_least_once';

export function isToolRecoveryStrategy(
  value: unknown,
): value is ToolRecoveryStrategy {
  return (
    value === 'replay_safe' ||
    value === 'idempotency_key' ||
    value === 'reconcile_then_replay' ||
    value === 'durable_handle' ||
    value === 'at_least_once'
  );
}

export type ExecuteResult =
  | { ok: true; output: string; errorCode?: undefined; error?: undefined }
  | {
      ok: false;
      output: string;
      errorCode: ErrorCode;
      error: string;
      diagnostics?: ToolFailureDiagnostics;
    };

export type RunCheckpointToolInvocation =
  | {
      status: 'in_flight';
      callId: string;
      toolName: string;
      recoveryStrategy: ToolRecoveryStrategy;
      recoveryState: JsonValue;
    }
  | {
      status: 'reconciled';
      callId: string;
      toolName: string;
      recoveryStrategy: ToolRecoveryStrategy;
      recoveryState: JsonValue;
      result: ExecuteResult;
    };

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseExecuteResult(value: unknown): ExecuteResult | null {
  if (!isUnknownRecord(value) || typeof value.output !== 'string') {
    return null;
  }
  if (value.ok === true) {
    return { ok: true, output: value.output };
  }
  if (
    value.ok !== false ||
    !isErrorCode(value.errorCode) ||
    typeof value.error !== 'string' ||
    (value.diagnostics !== undefined &&
      !isToolFailureDiagnostics(value.diagnostics))
  ) {
    return null;
  }
  return {
    ok: false,
    output: value.output,
    errorCode: value.errorCode,
    error: value.error,
    ...(value.diagnostics === undefined
      ? {}
      : { diagnostics: value.diagnostics }),
  };
}

interface AgentTransientEventPayloadMap {
  tool_output_delta: ToolOutputDeltaEventPayload;
}

export type AgentEventPayloadMap = SharedRunEventPayloadMap &
  AgentTransientEventPayloadMap;

export type AgentEventType = keyof AgentEventPayloadMap;

export type AgentEvent = {
  [Type in AgentEventType]: {
    type: Type;
    payload: AgentEventPayloadMap[Type];
  };
}[AgentEventType];

export type TerminalAgentEvent = Extract<
  AgentEvent,
  { type: 'done' | 'error' }
>;

export type TransientAgentEvent = Extract<
  AgentEvent,
  { type: keyof AgentTransientEventPayloadMap }
>;

export type RunEventAgentEvent = Exclude<AgentEvent, TransientAgentEvent>;

export type AgentEventEmitter = <Type extends AgentEventType>(
  type: Type,
  payload: AgentEventPayloadMap[Type],
) => void;

export const RUN_RUNNING_STATUS = 'running' as const;
export const RUN_APPROVAL_PENDING_STATUS = 'approval_pending' as const;

export type RunStatus =
  | typeof RUN_RUNNING_STATUS
  | typeof RUN_APPROVAL_PENDING_STATUS
  | AgentChildTerminalState;

export interface ToolRunState {
  runId: RunId;
  seq: number;
  abortController: AbortController;
  status: RunStatus;
  createdAt: string;
  parentRunId?: RunId;
  childRunIds: Set<RunId>;
  backgroundChildRunIds: Set<RunId>;
  backgroundChildLaunchReservationIds: Set<string>;
  subagentResultReportSummary?: string;
}

export type RootToolRunState = ToolRunState & { parentRunId?: undefined };
export type ChildToolRunState = ToolRunState & { parentRunId: RunId };

export function isRootRunState(state: ToolRunState): state is RootToolRunState {
  return state.parentRunId === undefined;
}

export function isChildRunState(
  state: ToolRunState,
): state is ChildToolRunState {
  return state.parentRunId !== undefined;
}
