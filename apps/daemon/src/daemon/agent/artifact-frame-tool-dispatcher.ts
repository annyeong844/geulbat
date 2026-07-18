import { randomUUID } from 'node:crypto';
import { getErrorMessage } from '@geulbat/shared-utils/error';
import { createLogger } from '@geulbat/shared-utils/logger';

import type { AgentRuntimeServices } from '../daemon-runtime-contract.js';
import type { FunctionCall } from '../llm/index.js';
import type { RunContext } from '../run-context.js';
import { resolveApprovalClass } from '../tools/approval-runtime-policy.js';
import { toolError } from '../tools/result.js';
import type { ExecuteResult } from '../tools/types.js';
import type { AgentEventEmitter } from './events.js';
import { executeFunctionCall } from './loop-tool-approval.js';
import {
  buildAgentToolExecutionContextBase,
  buildToolCallExecutionRuntime,
} from './loop-tool-runtime.js';
import { recordToolCall, recordToolResult } from './loop-tool-support.js';
import type { ApprovalContext } from './loop-types.js';
import type { ToolCallSource } from './tool-call-source.js';

const logger = createLogger('agent/artifact-frame-tool');

// 표준 run 이벤트 구독자는 없다 — 프레임발 호출은 run 이벤트 스트림이 아니라
// requestId 상관 단일 응답으로 돌아가고, 감사 기록은 audit_only 트랜스크립트
// 엔트리가 정본이다.
const noopEmit: AgentEventEmitter = () => {};

// 프로토콜 RunToolResultPayload와 구조 동일한 데이터 응답 — agent 계층은
// protocol 패키지에 의존하지 않으므로 여기서는 구조 타입으로 둔다.
export type ArtifactFrameToolCallResult =
  | { ok: true; output: string }
  | { ok: false; errorCode: string; error: string };

// 아티팩트 프레임 발 도구 호출의 경량 standalone dispatch
// (callback-tool-dispatcher의 형제). 실행 경계는 PTC와 공유하는 게이트
// (loop-tool-approval의 artifact_frame + data_only 조합)가 강제하고,
// 호출/결과는 audit_only + artifact_frame 소스로 스레드 트랜스크립트에
// 각인된다.
export async function dispatchArtifactFrameToolCall(args: {
  runtimeServices: AgentRuntimeServices;
  runContext: RunContext;
  runId: string;
  approvalContext: ApprovalContext;
  toolName: string;
  toolArgs: Record<string, unknown>;
  scopeHandle: string;
  frameRequestId: string;
}): Promise<ArtifactFrameToolCallResult> {
  const {
    runtimeServices,
    runContext,
    runId,
    approvalContext,
    toolName,
    toolArgs,
    scopeHandle,
    frameRequestId,
  } = args;
  const hostCallId = `artifact-frame-${randomUUID()}`;
  const meta = runtimeServices.toolRegistry.getToolMeta(toolName);
  const mayMutateComputerFiles = meta?.mayMutateComputerFiles === true;
  const source: ToolCallSource = {
    kind: 'artifact_frame',
    scopeHandle,
    runtimeToolCallId: frameRequestId,
    hostCallId,
    ...(mayMutateComputerFiles
      ? { approvalClass: resolveApprovalClass(toolName, toolArgs) }
      : {}),
  };
  const functionCall: FunctionCall = {
    id: hostCallId,
    callId: hostCallId,
    name: toolName,
    arguments: JSON.stringify(toolArgs),
  };
  const executionContextBase = buildAgentToolExecutionContextBase({
    runContext,
    runId,
    approvalContext,
    emit: noopEmit,
    currentFile: undefined,
    selection: undefined,
    signal: undefined,
    runState: undefined,
    ...(runtimeServices.computerFileRoot === undefined
      ? {}
      : { computerFileRoot: runtimeServices.computerFileRoot }),
    fileStateCache: runtimeServices.fileStateCache,
    memoryIndex: runtimeServices.memoryIndex,
    agentSpawnRuntime: runtimeServices,
  });
  const toolRuntime = buildToolCallExecutionRuntime({
    approvalContext,
    emit: noopEmit,
    toolRegistry: runtimeServices.toolRegistry,
    approvalGate: runtimeServices.approvalGate,
    approvalGrants: runtimeServices.approvalGrants,
    executionContextBase,
  });

  await recordToolCall({
    functionCall,
    round: 0,
    toolArgs,
    runContext,
    emit: noopEmit,
    source,
    historyMode: 'audit_only',
  });

  let result: ExecuteResult;
  try {
    const step = await executeFunctionCall({
      functionCall,
      round: 0,
      toolArgs,
      history: [],
      runtime: toolRuntime,
      source,
      denialMode: 'data_only',
    });
    result = step.ok
      ? step.value
      : toolError(
          'execution_failed',
          'artifact frame tool dispatch did not produce a result',
        );
  } catch (error: unknown) {
    logger
      .withContext({ threadId: runContext.threadId, tool: toolName })
      .error('artifact frame tool dispatch failed:', {
        message: getErrorMessage(error),
      });
    result = toolError('execution_failed', getErrorMessage(error));
  }

  await recordToolResult({
    functionCall,
    round: 0,
    toolResult: result,
    computerFilesMayHaveChanged: mayMutateComputerFiles && result.ok === true,
    runContext,
    runId,
    history: [],
    emit: noopEmit,
    source,
    historyMode: 'audit_only',
  });

  return result.ok
    ? { ok: true, output: result.output }
    : { ok: false, errorCode: result.errorCode, error: result.error };
}
