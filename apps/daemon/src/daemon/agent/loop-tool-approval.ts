// Approval flow entry owner:
// - resolve approval target
// - run preflight / auto-approve checks
// - route prompt/wait handling when approval is required
import type { SideEffectLevel } from '@geulbat/protocol/run-events';
import { getErrorMessage } from '@geulbat/shared-utils/error';
import { createLogger } from '@geulbat/shared-utils/logger';
import type { ExecuteResult } from '../tools/types.js';
import type { FunctionCall, HistoryItem } from '../llm/index.js';
import {
  collectPreflight,
  resolveApprovalClass,
  resolveRuntimeSideEffectLevel,
  shouldAutoApprove,
  shouldRequireApproval,
} from '../tools/approval-runtime-policy.js';
import type {
  ApprovalClass,
  ApprovalGrantContext,
} from '../tools/approval-grants.js';
import { toolError } from '../tools/result.js';
import type { RunWorkspaceContext } from '../run-workspace-context.js';
import { executeResolvedFunctionCall } from './loop-tool-execute-context.js';
import type { ToolCallArgs } from './events.js';
import {
  emitAndSettleTerminalFailure,
  type StepResult,
} from './loop-shared.js';
import { recordToolResult } from './loop-tool-support.js';
import { assertRunId as assertValidRunId } from '@geulbat/protocol/ids';
import type { ApprovalContext } from './loop-types.js';
import { markRunApprovalPending, type RunState } from './runtime/run-state.js';
import type {
  AgentToolCallExecutionRuntime,
  ApprovalTarget,
} from './loop-tool-runtime.js';
import {
  getToolRuntimeRunContext,
  getToolRuntimeRunState,
  getToolRuntimeSignal,
  getToolRuntimeWorkspaceRoot,
} from './loop-tool-runtime.js';

const logger = createLogger('agent/tool-approval');

type ApprovalDecisionResult = 'approved' | StepResult<ExecuteResult>;

export async function executeFunctionCall(args: {
  functionCall: FunctionCall;
  round: number;
  toolArgs: ToolCallArgs;
  history: HistoryItem[];
  runtime: AgentToolCallExecutionRuntime;
}): Promise<StepResult<ExecuteResult>> {
  const { functionCall, round, toolArgs, history, runtime } = args;
  const meta = runtime.toolRegistry.getToolMeta(functionCall.name);
  const runtimeSideEffectLevel =
    resolveRuntimeSideEffectLevel(functionCall.name, toolArgs, {
      toolRegistry: runtime.toolRegistry,
    }) ??
    meta?.sideEffectLevel ??
    'write';
  const approvalClass = resolveApprovalClass(functionCall.name, toolArgs);
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
  });

  if (approvalState.needsApproval) {
    const decision = await resolveApprovalDecision({
      functionCall,
      round,
      approvalTarget,
      approvalClass,
      runtimeSideEffectLevel,
      toolArgs,
      history,
      runtime,
    });
    if (decision !== 'approved') {
      return decision;
    }
    return {
      ok: true,
      value: await executeResolvedFunctionCall({
        functionCall,
        toolArgs,
        approvalGranted: true,
        runtime,
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
    }),
  };
}

function resolveApprovalTarget(
  approvalContext: AgentToolCallExecutionRuntime['approvalContext'],
  runId: string,
  threadId: RunWorkspaceContext['threadId'],
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
): Promise<{ needsApproval: boolean; approvalGranted: boolean }> {
  const { approvalTarget, toolName, toolArgs, runtime } = args;
  const sideEffectLevel =
    args.sideEffectLevel ??
    resolveRuntimeSideEffectLevel(toolName, toolArgs, {
      toolRegistry: runtime.toolRegistry,
    });
  if (!sideEffectLevel) {
    return { needsApproval: true, approvalGranted: false };
  }
  if (sideEffectLevel !== 'write' && sideEffectLevel !== 'destructive') {
    return { needsApproval: false, approvalGranted: false };
  }

  const approvalClass =
    args.approvalClass ?? resolveApprovalClass(toolName, toolArgs);
  const autoApproved = shouldAutoApprove(
    {
      runId: approvalTarget.runId,
      threadId: approvalTarget.threadId,
      sessionId: runtime.approvalContext.sessionId,
      approvalClass,
      sideEffectLevel,
      permissionMode: runtime.approvalContext.permissionMode,
    },
    { approvalGrants: runtime.approvalGrants },
  );
  if (autoApproved) {
    return { needsApproval: false, approvalGranted: true };
  }

  try {
    const preflight = await collectPreflight(
      getToolRuntimeWorkspaceRoot(runtime),
      toolArgs,
    );
    return {
      needsApproval: shouldRequireApproval(toolName, preflight, {
        toolRegistry: runtime.toolRegistry,
      }),
      approvalGranted: false,
    };
  } catch (error) {
    logger.warn('tool approval preflight failed; falling back to fail-closed', {
      toolName,
      message: getErrorMessage(error),
    });
    return { needsApproval: true, approvalGranted: false };
  }
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

  const decision = await approvalGate.waitForApproval(
    functionCall.callId,
    approvalTarget.runId,
    approvalTarget.threadId,
    buildApprovalGrantContext(
      approvalContext,
      approvalTarget.runId,
      approvalTarget.threadId,
      approvalClass,
      runtimeSideEffectLevel,
    ),
    signal,
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
    );
  }

  if (decision === 'aborted') {
    return buildAbortedApprovalResult(emit, runState, signal);
  }

  return 'approved';
}

async function buildDeniedApprovalResult(
  functionCall: ResolveApprovalDecisionArgs['functionCall'],
  round: number,
  runContext: RunWorkspaceContext,
  runId: string,
  history: ResolveApprovalDecisionArgs['history'],
  emit: ResolveApprovalDecisionArgs['runtime']['emit'],
  runState?: RunState,
): Promise<StepResult<ExecuteResult>> {
  const deniedError = `tool "${functionCall.name}" denied`;
  await recordToolResult({
    functionCall,
    round,
    toolResult: toolError('approval_denied', deniedError),
    workspaceFilesMayHaveChanged: false,
    runContext,
    runId,
    history,
    emit,
  });
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
): StepResult<ExecuteResult> {
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
  threadId: RunWorkspaceContext['threadId'],
  approvalClass: ApprovalClass,
  sideEffectLevel: SideEffectLevel,
): ApprovalGrantContext {
  return {
    runId,
    threadId,
    sessionId: approvalContext.sessionId,
    approvalClass,
    sideEffectLevel,
    permissionMode: approvalContext.permissionMode,
  };
}
