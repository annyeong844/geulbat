import assert from 'node:assert/strict';
import {
  buildAgentToolExecutionContextBase,
  buildToolCallExecutionRuntime,
} from '../daemon/agent/loop-tool-runtime.js';
import { createDaemonContext } from '../daemon/context.js';
import type {
  AnyTool,
  ExecuteResult,
  ToolExecutionContext,
  ToolParseResult,
} from '../daemon/tools/types.js';
import { makeApprovalContext } from './approval-runtime.js';
import { testRunId } from './run-id.js';
import { makeRunContext } from './run-context.js';
import { testThreadId } from './thread-id.js';
import { createRunState } from '../daemon/agent/runtime/run-state.js';
import {
  TEST_AUTO_SUBAGENT_MODEL_ROUTING,
  TEST_INHERITED_SOL_MODEL_PIN,
} from './subagent-model-routing.js';

export function registerOnce(
  daemonContext: ReturnType<typeof createDaemonContext>,
  tool: AnyTool,
): void {
  daemonContext.toolRegistry.registerTool(tool);
}

function parseObjectArgs<TArgs extends object>(
  raw: unknown,
): ToolParseResult<TArgs> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'tool arguments must be an object.' };
  }
  return { ok: true, value: raw as TArgs };
}

export function makeTestTool<
  TArgs extends object = Record<string, unknown>,
>(args: {
  name: string;
  description: string;
  sideEffectLevel: AnyTool['sideEffectLevel'];
  mayMutateComputerFiles?: boolean;
  parallelBatchKind?: AnyTool['parallelBatchKind'];
  requiresApproval: boolean;
  parseArgs?: (raw: unknown) => ToolParseResult<TArgs>;
  executeParsed: (
    parsedArgs: TArgs,
    ctx: ToolExecutionContext,
  ) => Promise<ExecuteResult>;
}): AnyTool {
  return {
    name: args.name,
    description: args.description,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: args.sideEffectLevel,
    mayMutateComputerFiles: args.mayMutateComputerFiles ?? false,
    ...(args.parallelBatchKind
      ? { parallelBatchKind: args.parallelBatchKind }
      : {}),
    timeoutMs: 1_000,
    requiresApproval: args.requiresApproval,
    parseArgs: args.parseArgs ?? parseObjectArgs,
    executeParsed: args.executeParsed,
  };
}

export function makeExecutionRuntime(
  daemonContext: ReturnType<typeof createDaemonContext>,
  args: {
    runContext: ReturnType<typeof makeRunContext>;
    runId: string;
    approvalContext: ReturnType<typeof makeApprovalContext>;
    emit: Parameters<typeof buildToolCallExecutionRuntime>[0]['emit'];
    currentFile?: string;
    selection?: ToolExecutionContext['selection'];
    signal?: AbortSignal;
    runState?: ReturnType<typeof createRunState>;
    computerFileRoot?: string;
    ultraReasoning?: boolean;
  },
) {
  return buildToolCallExecutionRuntime({
    approvalContext: args.approvalContext,
    emit: args.emit,
    toolRegistry: daemonContext.toolRegistry,
    approvalGate: daemonContext.approvalGate,
    approvalGrants: daemonContext.approvalGrants,
    executionContextBase: buildAgentToolExecutionContextBase({
      runContext: args.runContext,
      runId: args.runId,
      approvalContext: args.approvalContext,
      emit: args.emit,
      currentFile: args.currentFile,
      selection: args.selection,
      signal: args.signal,
      runState: args.runState,
      ...(args.computerFileRoot === undefined
        ? {}
        : { computerFileRoot: args.computerFileRoot }),
      memoryIndex: undefined,
      runtimeServices: daemonContext,
      providerRunSelection: TEST_INHERITED_SOL_MODEL_PIN.providerRunSelection,
      ultraReasoning: args.ultraReasoning ?? false,
      subagentModelRouting: TEST_AUTO_SUBAGENT_MODEL_ROUTING,
    }),
  });
}

/**
 * 이름만 주면 등록 가능한 최소 도구 — registry/context 테스트가 "유효한 도구가
 * 하나 있다"만 필요할 때 쓴다. 도구 shape는 makeTestTool 하나만 알게 두고,
 * parseArgs는 원래의 관대한 동작을 명시적으로 유지한다(공용 기본값은 객체가
 * 아닌 입력을 거부하므로 그대로 두면 동작이 바뀐다).
 */
export function makeRegistrableTestTool(name: string): AnyTool {
  return makeTestTool({
    name,
    description: 'test tool',
    sideEffectLevel: 'none',
    requiresApproval: false,
    parseArgs() {
      return { ok: true, value: {} };
    },
    async executeParsed() {
      return { ok: true, output: name };
    },
  });
}

export async function startApprovalCheckpoint(
  daemonContext: ReturnType<typeof createDaemonContext>,
  threadId: ReturnType<typeof testThreadId>,
  runId: ReturnType<typeof testRunId>,
): Promise<void> {
  const result = await daemonContext.runCheckpoints.startRun({
    runId,
    threadId,
    request: { workingDirectory: '.', permissionMode: 'basic' },
  });
  assert.equal(result.ok, true);
}

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
