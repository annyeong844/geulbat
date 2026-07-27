// Approval flow entry owner:
// - resolve approval target
// - run preflight / auto-approve checks
// - route prompt/wait handling when approval is required
import { getErrorMessage } from '../utils/error.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import { PLAN_APPROVAL_REQUIRED } from '../planning-approval.js';
import {
  assertAgentRunId as assertValidRunId,
  isAgentTerminalRunStatus,
  type SideEffectLevel,
} from './contract.js';
import type {
  ExecuteResult,
  ToolExecutionResourceSnapshotRef,
} from '../tools/types.js';
import type { FunctionCall, HistoryItem } from '../llm/index.js';
import {
  collectPreflight,
  isApprovalPreflightCurrent,
  resolveApprovalClass,
  resolveRuntimeSideEffectLevel,
  shouldAutoApprove,
  shouldRequireApproval,
  type ApprovalPreflight,
} from '../tools/approval-runtime-policy.js';
import type {
  ApprovalClass,
  ApprovalGrantContext,
} from '../tools/approval-grants.js';
import type { GenericApiErrorCode } from '../error-codes.js';
import { toolError } from '../tools/result.js';
import type { AgentResult } from './agent-result.js';
import type { RunContext } from '../run-context.js';
import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  resolvePtcExecuteCodeWriteCallbackConfigFromEnv,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import {
  isPtcExecuteCodeDelegatedApprovalCallbackToolMetaAllowed,
  isPtcExecuteCodeWriteCallbackToolMetaAllowed,
  isRuntimeSourcedReadOnlyToolAllowed,
} from '../tools/builtin/ptc-callback-tool-surface.js';
import { executeResolvedFunctionCall } from './loop-tool-execute-context.js';
import { createCallbackToolDispatcher } from './callback-tool-dispatcher.js';
import type { ToolCallArgs } from './events.js';
import { emitAndSettleTerminalFailure } from './loop-shared.js';
import { recordToolResult } from './loop-tool-support.js';
import type { ApprovalContext } from './loop-types.js';
import {
  markRunApprovalPending,
  type RunFailureOutcome,
  type RunState,
} from './runtime/run-state.js';
import type {
  AgentToolCallExecutionRuntime,
  ApprovalTarget,
} from './loop-tool-runtime.js';
import {
  getToolRuntimeRunContext,
  getToolRuntimeRunState,
  getToolRuntimeSignal,
} from './loop-tool-runtime.js';
import {
  AGENT_LOOP_TOOL_CALL_SOURCE,
  type ToolCallSource,
} from './tool-call-source.js';
import { isRecord } from '../runtime-json.js';
const logger = createLogger('agent/tool-approval');

export interface DeferredFunctionCallTerminalFailure {
  code: GenericApiErrorCode;
  message: string;
  outcome: RunFailureOutcome;
  signal?: AbortSignal;
}

type FunctionCallExecutionResult =
  | { ok: true; value: ExecuteResult }
  | ({
      ok: false;
      result: AgentResult;
    } & { deferredTerminalFailure?: DeferredFunctionCallTerminalFailure });

type ApprovalDecisionResult = 'approved' | FunctionCallExecutionResult;

export async function executeFunctionCall(args: {
  functionCall: FunctionCall;
  round: number;
  toolArgs: ToolCallArgs;
  history: HistoryItem[];
  runtime: AgentToolCallExecutionRuntime;
  source?: ToolCallSource;
  denialMode?: 'terminal' | 'code_visible' | 'data_only';
  deferTerminalFailure?: boolean;
  resourceSnapshotRef?: ToolExecutionResourceSnapshotRef;
}): Promise<FunctionCallExecutionResult> {
  const { functionCall, round, toolArgs, history, runtime } = args;
  const source = args.source ?? AGENT_LOOP_TOOL_CALL_SOURCE;
  const denialMode = args.denialMode ?? 'terminal';
  const isAgentLoopTerminal =
    source.kind === 'agent_loop' && denialMode === 'terminal';
  const isPtcCodeVisible =
    source.kind === 'ptc_callback' && denialMode === 'code_visible';
  // 프레임발 호출은 코드가 사용자에게 보이지 않으므로 code_visible과 의미가
  // 다르다 — 거부는 데이터 응답으로만 돌아간다 (back-channel 설계 §8).
  const isArtifactFrameDataOnly =
    source.kind === 'artifact_frame' && denialMode === 'data_only';
  if (!isAgentLoopTerminal && !isPtcCodeVisible && !isArtifactFrameDataOnly) {
    throw new Error('unsupported tool dispatch source/denialMode combination');
  }
  const callbackToolDispatcher =
    isAgentLoopTerminal && functionCall.name === PTC_EXECUTE_CODE_TOOL_NAME
      ? createCallbackToolDispatcher({
          runtime,
          history,
          parentRound: round,
          parentToolCallId: functionCall.callId,
          dispatchFunctionCall: executeFunctionCall,
        })
      : undefined;
  const meta = runtime.toolRegistry.getToolMeta(functionCall.name);
  const runtimeSideEffectLevel =
    resolveRuntimeSideEffectLevel(functionCall.name, toolArgs, {
      toolRegistry: runtime.toolRegistry,
    }) ??
    meta?.sideEffectLevel ??
    'write';
  // full_access(yolo) 모드의 PTC 콜백은 표면 allowlist를 우회한다 (오너 결정
  // 2026-07-23): 셀 코드는 모델 작성이라 agent-loop와 같은 신뢰 등급이고,
  // 모드가 이미 전면 위임이므로 destructive 도구(exec_command 등)도 셀에서
  // 직행한다. 아티팩트 프레임은 외부 콘텐츠 구동이라 우회 대상이 아니다.
  const bypassPtcSurfaceGate =
    isPtcCodeVisible &&
    runtime.approvalContext.permissionMode === 'full_access';
  if ((isPtcCodeVisible && !bypassPtcSurfaceGate) || isArtifactFrameDataOnly) {
    // PTC 콜백과 아티팩트 프레임은 read-only 게이트와 opt-in built-in
    // write allowlist를 공유한다. 모델이 작성한 PTC 코드만 설치형 외부
    // 도구의 delegated approval lane을 더 받는다. 승인 필요 판정은 아래
    // approvalState가 그대로 중재한다 — 프레임/콜백 직통이 승인을
    // 우회하지 않는다.
    const isAdmittedReadCallback = isRuntimeSourcedReadOnlyToolAllowed(
      functionCall.name,
      meta ?? {},
      runtimeSideEffectLevel,
    );
    const writeCallbackConfig =
      resolvePtcExecuteCodeWriteCallbackConfigFromEnv();
    const isAdmittedWriteCallback =
      runtimeSideEffectLevel === 'write' &&
      ((isPtcCodeVisible &&
        isPtcExecuteCodeDelegatedApprovalCallbackToolMetaAllowed(
          functionCall.name,
          meta ?? {},
        )) ||
        (writeCallbackConfig.enabled &&
          isPtcExecuteCodeWriteCallbackToolMetaAllowed(
            functionCall.name,
            meta ?? {},
          )));
    if (!isAdmittedReadCallback && !isAdmittedWriteCallback) {
      if (isArtifactFrameDataOnly) {
        // 프레임에는 코드 가시 채널이 없다 — 거부를 데이터 응답으로 돌려
        // UI가 프롬프트(티어 B)로 강등하게 한다.
        return {
          ok: true,
          value: toolError(
            'approval_required',
            `tool "${functionCall.name}" is outside the artifact frame callback surface`,
          ),
        };
      }
      throw new Error(
        'PTC callback dispatch rejected a tool outside the admitted callback surface',
      );
    }
  }
  if (
    runtime.executionContextBase.planningWorkflow !== undefined &&
    isBlockedDuringPlanning(
      functionCall.name,
      runtimeSideEffectLevel,
      meta?.mayMutateComputerFiles === true,
    )
  ) {
    return {
      ok: true,
      value: toolError(
        'approval_required',
        `${PLAN_APPROVAL_REQUIRED}: tool "${functionCall.name}" cannot execute before the exact plan revision is approved and published; effective permission mode "${runtime.approvalContext.permissionMode}" bypasses per-tool prompts, not the plan approval gate`,
        {
          phase: 'admission',
          reasonCode: 'plan_approval_required',
          retryHint:
            'Approve and publish the exact current plan revision, then retry the tool.',
          gate: {
            kind: 'plan_approval',
            effectivePermissionMode: runtime.approvalContext.permissionMode,
          },
        },
      ),
    };
  }
  const requestedPlan = readUpdatePlanStructure(functionCall.name, toolArgs);
  if (requestedPlan !== null) {
    try {
      await runtime.executionContextBase.runtimeServices?.planningWorkflows.assertPlanUpdateAllowed(
        runtime.executionContextBase.threadId,
        requestedPlan,
      );
    } catch (error: unknown) {
      return {
        ok: true,
        value: toolError('approval_required', getErrorMessage(error)),
      };
    }
  }
  const approvalClass = resolveApprovalClass(functionCall.name, toolArgs, {
    toolRegistry: runtime.toolRegistry,
  });
  const approvalTarget = resolveApprovalTarget(
    runtime.approvalContext,
    runtime.executionContextBase.runId,
    runtime.executionContextBase.threadId,
  );
  const approvalState = await resolveToolApprovalState({
    approvalTarget,
    toolName: functionCall.name,
    toolArgs,
    approvalClass,
    sideEffectLevel: runtimeSideEffectLevel,
    runtime,
    // 승인은 세션 단위 (오너 결정 2026-07-23, Q5=(a) 갱신): PTC 셀 코드는
    // 모델이 작성하므로 agent-loop 직접 호출과 같은 신뢰 등급 — 세션/런
    // grant를 중첩 콜백에도 인정한다. 아티팩트 프레임은 외부 콘텐츠가
    // 구동하므로 저장된 grant를 무시하는 fail-closed를 유지한다.
    ...(isArtifactFrameDataOnly
      ? { grantEligibility: 'full_access_only' }
      : {}),
  });

  if (approvalState.needsApproval) {
    if (denialMode === 'data_only') {
      // 프레임에는 승인 프롬프트를 중계할 채널이 없다 — 대기 없이 거부하고
      // UI가 프롬프트 경로(티어 B)로 승인 중재를 넘긴다.
      return {
        ok: true,
        value: toolError(
          'approval_required',
          `tool "${functionCall.name}" requires user approval; artifact frame calls cannot resolve approvals`,
        ),
      };
    }
    if (denialMode === 'code_visible') {
      // A detached-cell callback can outlive its parent run. Once the run
      // has settled there is no channel left that can resolve the prompt
      // (the approve control route 404s on inactive runs and the web-shell
      // hides the card at idle), so waiting would only block the cell until
      // bridge teardown. Fall back to the no-wait code-visible rejection.
      const runState = getToolRuntimeRunState(runtime);
      if (runState !== undefined && isAgentTerminalRunStatus(runState.status)) {
        return {
          ok: true,
          value: toolError(
            'approval_required',
            `tool "${functionCall.name}" requires user approval, but the parent run has already settled; interactive approval is unavailable for post-run callbacks`,
          ),
        };
      }
      // W2 interactive approval loop for PTC write callbacks: the canonical
      // approval_required event and gate wait are reused, but denial and
      // abort come back as code-visible results so the run continues. Run
      // status is intentionally left untouched — the outer exec tool (or a
      // detached cell) is genuinely still running while its callback waits,
      // and a background cell callback must not block run completion.
      const decision = await waitForPtcCallbackApprovalDecision({
        functionCall,
        approvalTarget,
        approvalClass,
        runtimeSideEffectLevel,
        toolArgs,
        runtime,
      });
      if (decision === 'denied') {
        return {
          ok: true,
          value: toolError(
            'approval_denied',
            `tool "${functionCall.name}" denied`,
          ),
        };
      }
      if (decision === 'aborted') {
        return {
          ok: true,
          value: toolError('aborted', 'approval aborted'),
        };
      }
      const preflightFailure = await revalidateApprovedToolPreflight({
        approvalState,
        toolName: functionCall.name,
        toolArgs,
        runtime,
      });
      if (preflightFailure !== undefined) {
        return { ok: true, value: preflightFailure };
      }
      return {
        ok: true,
        value: await executeResolvedFunctionCall({
          functionCall,
          toolArgs,
          approvalGranted: true,
          runtime,
          ...(args.resourceSnapshotRef === undefined
            ? {}
            : { resourceSnapshotRef: args.resourceSnapshotRef }),
        }),
      };
    }
    const decision = await resolveApprovalDecision({
      functionCall,
      round,
      approvalTarget,
      approvalClass,
      runtimeSideEffectLevel,
      toolArgs,
      history,
      runtime,
      deferTerminalFailure: args.deferTerminalFailure === true,
    });
    if (decision !== 'approved') {
      return decision;
    }
    const preflightFailure = await revalidateApprovedToolPreflight({
      approvalState,
      toolName: functionCall.name,
      toolArgs,
      runtime,
    });
    if (preflightFailure !== undefined) {
      return { ok: true, value: preflightFailure };
    }
    return {
      ok: true,
      value: await executeResolvedFunctionCall({
        functionCall,
        toolArgs,
        approvalGranted: true,
        runtime,
        ...(args.resourceSnapshotRef === undefined
          ? {}
          : { resourceSnapshotRef: args.resourceSnapshotRef }),
        ...(callbackToolDispatcher ? { callbackToolDispatcher } : {}),
      }),
    };
  }

  return {
    ok: true,
    value: await executeResolvedFunctionCall({
      functionCall,
      toolArgs,
      approvalGranted: approvalState.approvalGranted,
      runtime,
      ...(args.resourceSnapshotRef === undefined
        ? {}
        : { resourceSnapshotRef: args.resourceSnapshotRef }),
      ...(callbackToolDispatcher ? { callbackToolDispatcher } : {}),
    }),
  };
}

const PLAN_MODE_DELEGATION_TOOL_NAMES = new Set([
  'agent_spawn',
  'agent_retry',
  'agent_send_input',
  'agent_set_priority',
]);

function isBlockedDuringPlanning(
  toolName: string,
  sideEffectLevel: SideEffectLevel,
  mayMutateComputerFiles: boolean,
): boolean {
  return (
    toolName === 'update_plan' ||
    PLAN_MODE_DELEGATION_TOOL_NAMES.has(toolName) ||
    mayMutateComputerFiles ||
    sideEffectLevel === 'write' ||
    sideEffectLevel === 'destructive'
  );
}

function readUpdatePlanStructure(
  toolName: string,
  args: ToolCallArgs,
): Array<{
  id?: string;
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}> | null {
  if (toolName !== 'update_plan' || !isUnknownArray(args['plan'])) {
    return null;
  }
  const plan = args['plan'];
  const result: Array<{
    id?: string;
    step: string;
    status: 'pending' | 'in_progress' | 'completed';
  }> = [];
  for (const value of plan) {
    if (
      !isRecord(value) ||
      typeof value.step !== 'string' ||
      (value.status !== 'pending' &&
        value.status !== 'in_progress' &&
        value.status !== 'completed') ||
      (value.id !== undefined && typeof value.id !== 'string')
    ) {
      return null;
    }
    result.push({
      ...(typeof value.id === 'string' ? { id: value.id } : {}),
      step: value.step,
      status: value.status,
    });
  }
  return result;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function resolveApprovalTarget(
  approvalContext: AgentToolCallExecutionRuntime['approvalContext'],
  runId: string,
  threadId: RunContext['threadId'],
): ApprovalTarget {
  return {
    runId: approvalContext.ownerRunId ?? runId,
    threadId: approvalContext.ownerThreadId ?? threadId,
  };
}

interface ResolveToolApprovalStateArgs {
  approvalTarget: ApprovalTarget;
  toolName: string;
  toolArgs: ToolCallArgs;
  approvalClass?: ApprovalClass;
  sideEffectLevel?: SideEffectLevel | null;
  // 'full_access_only' is a fail-closed eligibility restriction, not a new
  // grant policy: stored class-only grants are ignored as auto-approval
  // evidence while the canonical full_access rule stays intact.
  grantEligibility?: 'all' | 'full_access_only';
  runtime: Pick<
    AgentToolCallExecutionRuntime,
    | 'approvalContext'
    | 'approvalGrants'
    | 'toolRegistry'
    | 'executionContextBase'
  >;
}

export async function resolveToolApprovalState(
  args: ResolveToolApprovalStateArgs,
): Promise<{
  needsApproval: boolean;
  approvalGranted: boolean;
  preflight?: ApprovalPreflight;
}> {
  const { approvalTarget, toolName, toolArgs, runtime } = args;
  const sideEffectLevel =
    args.sideEffectLevel ??
    resolveRuntimeSideEffectLevel(toolName, toolArgs, {
      toolRegistry: runtime.toolRegistry,
    });
  if (!sideEffectLevel) {
    // 메타를 못 찾은 도구는 fail-closed로 승인창을 띄우되, full_access(yolo)
    // 모드는 예외 — 모드 자체가 전면 위임이므로 여기서도 자동 승인한다
    // (오너 결정 2026-07-23).
    if (runtime.approvalContext.permissionMode === 'full_access') {
      return { needsApproval: false, approvalGranted: true };
    }
    return { needsApproval: true, approvalGranted: false };
  }
  if (sideEffectLevel !== 'write' && sideEffectLevel !== 'destructive') {
    return { needsApproval: false, approvalGranted: false };
  }

  const needsApproval = shouldRequireApproval(toolName, {
    toolRegistry: runtime.toolRegistry,
  });
  if (!needsApproval) {
    return { needsApproval: false, approvalGranted: false };
  }

  const approvalClass =
    args.approvalClass ??
    resolveApprovalClass(toolName, toolArgs, {
      toolRegistry: runtime.toolRegistry,
    });
  const approvalGrants =
    args.grantEligibility === 'full_access_only'
      ? { hasApprovalGrant: () => false }
      : runtime.approvalGrants;
  const autoApproved = shouldAutoApprove(
    {
      runId: approvalTarget.runId,
      computerSessionId: runtime.approvalContext.computerSessionId,
      approvalClass,
      sideEffectLevel,
      permissionMode: runtime.approvalContext.permissionMode,
    },
    { approvalGrants },
  );
  if (autoApproved) {
    return { needsApproval: false, approvalGranted: true };
  }

  try {
    const preflight = await collectPreflight(
      toolName,
      runtime.executionContextBase,
      toolArgs,
    );
    return {
      needsApproval: true,
      approvalGranted: false,
      ...(preflight === undefined ? {} : { preflight }),
    };
  } catch (error) {
    logger.warn('tool approval preflight failed; falling back to fail-closed', {
      toolName,
      message: getErrorMessage(error),
    });
    return { needsApproval: true, approvalGranted: false };
  }
}

async function revalidateApprovedToolPreflight(args: {
  approvalState: { preflight?: ApprovalPreflight };
  toolName: string;
  toolArgs: ToolCallArgs;
  runtime: Pick<AgentToolCallExecutionRuntime, 'executionContextBase'>;
}): Promise<ExecuteResult | undefined> {
  const preflight = args.approvalState.preflight;
  if (preflight === undefined || preflight.mutationTargets.length === 0) {
    return undefined;
  }

  try {
    if (
      await isApprovalPreflightCurrent(
        args.toolName,
        args.runtime.executionContextBase,
        args.toolArgs,
        preflight,
      )
    ) {
      return undefined;
    }
  } catch (error: unknown) {
    logger.warn('tool approval target revalidation failed', {
      toolName: args.toolName,
      message: getErrorMessage(error),
    });
  }

  return toolError(
    'access_denied',
    `tool "${args.toolName}" target changed or could not be revalidated after approval`,
  );
}

interface WaitForPtcCallbackApprovalDecisionArgs {
  functionCall: FunctionCall;
  approvalTarget: ApprovalTarget;
  approvalClass: ApprovalClass;
  runtimeSideEffectLevel: NonNullable<SideEffectLevel>;
  toolArgs: ToolCallArgs;
  runtime: Pick<
    AgentToolCallExecutionRuntime,
    'approvalContext' | 'emit' | 'approvalGate' | 'executionContextBase'
  >;
}

// W2 wait branch for ptc_callback sources: same approval_required event and
// gate as the terminal flow, but no run-state transition and no terminal
// result builders — the caller maps denied/aborted to code-visible results.
// The wait is bounded by the merged run/callback signal, so exec timeout or
// bridge teardown resolves it as 'aborted' and the gate keeps no pending
// entry behind.
async function waitForPtcCallbackApprovalDecision(
  args: WaitForPtcCallbackApprovalDecisionArgs,
): Promise<'approved' | 'denied' | 'aborted'> {
  const {
    functionCall,
    approvalTarget,
    approvalClass,
    runtimeSideEffectLevel,
    toolArgs,
    runtime,
  } = args;
  const { approvalContext, emit, approvalGate } = runtime;
  const signal = getToolRuntimeSignal(runtime);

  return await approvalGate.waitForApproval(
    functionCall.callId,
    approvalTarget.runId,
    approvalTarget.threadId,
    buildApprovalGrantContext(
      approvalContext,
      approvalTarget.runId,
      approvalClass,
      runtimeSideEffectLevel,
    ),
    signal,
    () => {
      emit('approval_required', {
        callId: functionCall.callId,
        runId: assertValidRunId(approvalTarget.runId),
        threadId: approvalTarget.threadId,
        toolName: functionCall.name,
        approvalClass,
        permissionMode: approvalContext.permissionMode,
        argumentsPreview: toolArgs,
        sideEffectLevel: runtimeSideEffectLevel,
      });
    },
    (permissionMode) => {
      approvalContext.permissionMode = permissionMode;
      runtime.executionContextBase.permissionMode = permissionMode;
    },
  );
}

interface ResolveApprovalDecisionArgs {
  functionCall: FunctionCall;
  round: number;
  approvalTarget: ApprovalTarget;
  approvalClass: ApprovalClass;
  runtimeSideEffectLevel: NonNullable<SideEffectLevel>;
  toolArgs: ToolCallArgs;
  history: HistoryItem[];
  runtime: Pick<
    AgentToolCallExecutionRuntime,
    'approvalContext' | 'emit' | 'approvalGate' | 'executionContextBase'
  >;
  deferTerminalFailure?: boolean;
}

export async function resolveApprovalDecision(
  args: ResolveApprovalDecisionArgs,
): Promise<ApprovalDecisionResult> {
  const {
    functionCall,
    round,
    approvalTarget,
    approvalClass,
    runtimeSideEffectLevel,
    toolArgs,
    history,
    runtime,
  } = args;
  const { approvalContext, emit, approvalGate } = runtime;
  const signal = getToolRuntimeSignal(runtime);
  const runState = getToolRuntimeRunState(runtime);
  const runContext = getToolRuntimeRunContext(runtime);

  if (runState) {
    markRunApprovalPending(runState);
  }
  const decision = await approvalGate.waitForApproval(
    functionCall.callId,
    approvalTarget.runId,
    approvalTarget.threadId,
    buildApprovalGrantContext(
      approvalContext,
      approvalTarget.runId,
      approvalClass,
      runtimeSideEffectLevel,
    ),
    signal,
    () => {
      emit('approval_required', {
        callId: functionCall.callId,
        runId: assertValidRunId(approvalTarget.runId),
        threadId: approvalTarget.threadId,
        toolName: functionCall.name,
        approvalClass,
        permissionMode: approvalContext.permissionMode,
        argumentsPreview: toolArgs,
        sideEffectLevel: runtimeSideEffectLevel,
      });
    },
    (permissionMode) => {
      approvalContext.permissionMode = permissionMode;
      runtime.executionContextBase.permissionMode = permissionMode;
    },
  );

  if (decision === 'denied') {
    return buildDeniedApprovalResult(
      functionCall,
      round,
      runContext,
      runtime.executionContextBase.runId,
      history,
      emit,
      runState,
      args.deferTerminalFailure === true,
    );
  }

  if (decision === 'aborted') {
    return buildAbortedApprovalResult(
      emit,
      runState,
      signal,
      args.deferTerminalFailure === true,
    );
  }

  return 'approved';
}

async function buildDeniedApprovalResult(
  functionCall: ResolveApprovalDecisionArgs['functionCall'],
  round: number,
  runContext: RunContext,
  runId: string,
  history: ResolveApprovalDecisionArgs['history'],
  emit: ResolveApprovalDecisionArgs['runtime']['emit'],
  runState?: RunState,
  deferTerminalFailure = false,
): Promise<FunctionCallExecutionResult> {
  const deniedError = `tool "${functionCall.name}" denied`;
  await recordToolResult({
    functionCall,
    round,
    toolResult: toolError('approval_denied', deniedError),
    computerFilesMayHaveChanged: false,
    runContext,
    runId,
    history,
    emit,
  });
  if (deferTerminalFailure) {
    return {
      ok: false,
      result: { ok: false, finalProse: '' },
      deferredTerminalFailure: {
        code: 'approval_denied',
        message: deniedError,
        outcome: 'failed',
      },
    };
  }
  return {
    ok: false,
    result: emitAndSettleTerminalFailure(
      emit,
      'approval_denied',
      deniedError,
      runState,
      undefined,
      'failed',
    ),
  };
}

function buildAbortedApprovalResult(
  emit: ResolveApprovalDecisionArgs['runtime']['emit'],
  runState?: RunState,
  signal?: AbortSignal,
  deferTerminalFailure = false,
): FunctionCallExecutionResult {
  if (deferTerminalFailure) {
    return {
      ok: false,
      result: { ok: false, finalProse: '' },
      deferredTerminalFailure: {
        code: 'aborted',
        message: 'approval aborted',
        outcome: 'cancelled',
        ...(signal !== undefined ? { signal } : {}),
      },
    };
  }
  return {
    ok: false,
    result: emitAndSettleTerminalFailure(
      emit,
      'aborted',
      'approval aborted',
      runState,
      signal,
      'cancelled',
    ),
  };
}

function buildApprovalGrantContext(
  approvalContext: ApprovalContext,
  runId: string,
  approvalClass: ApprovalClass,
  sideEffectLevel: SideEffectLevel,
): ApprovalGrantContext {
  return {
    runId,
    computerSessionId: approvalContext.computerSessionId,
    approvalClass,
    sideEffectLevel,
    permissionMode: approvalContext.permissionMode,
  };
}
