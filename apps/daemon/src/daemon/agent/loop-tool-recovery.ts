import { isRecord, tryParseJsonRecord } from '../runtime-json.js';
import type { FunctionCall, HistoryItem } from '../llm/index.js';
import { toolError } from '../tools/result.js';
import { readTranscriptEntries } from '../sessions/transcript-log.js';
import { readProviderRoundHistory } from '../sessions/provider-round-journal.js';
import { createAgentEvent, type AgentEventEmitter } from './events.js';
import {
  loadExistingHistory,
  type ProviderHistoryTarget,
} from './loop-history.js';
import { resolveProviderRequestOptionsForRun } from '../llm/provider/provider-options.js';
import { executeFunctionCall } from './loop-tool-approval.js';
import {
  buildAgentToolExecutionContextBase,
  buildToolCallExecutionRuntime,
  isToolOutputRecoveryAvailable,
} from './loop-tool-runtime.js';
import { recordToolCall, recordToolResult } from './loop-tool-support.js';
import type { AgentInput } from './loop-types.js';
import type { ToolRecoveryStrategy } from '../tools/tool-registry-model.js';
import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  PTC_PACKAGE_INSTALL_TOOL_NAME,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';

interface RecoverableTranscriptToolCall {
  functionCall: FunctionCall;
  toolArgs: Record<string, unknown>;
  round: number;
  recoveryStrategy?: ToolRecoveryStrategy;
  transcriptRecorded: boolean;
}

export async function recoverPendingReplaySafeToolCalls(args: {
  agentInput: AgentInput;
}): Promise<{
  modelPrompt: string;
  transcriptPrompt: string;
  recoveredCallCount: number;
}> {
  const { agentInput } = args;
  const { runContext, runtimeServices } = agentInput;
  const providerRequestOptions = resolveProviderRequestOptionsForRun(
    runtimeServices.providerRequestOptions,
    {
      ...(agentInput.providerModel === undefined
        ? {}
        : { providerModel: agentInput.providerModel }),
      ...(agentInput.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: agentInput.reasoningEffort }),
    },
  );
  const providerTarget = {
    providerId: providerRequestOptions.providerId,
    model: providerRequestOptions.model,
  };
  const recoverableInput = await readRecoverableRunPrompts({
    stateRoot: runContext.stateRoot,
    threadId: runContext.threadId,
    providerTarget,
  });
  const transcript = await readTranscriptEntries(
    runContext.stateRoot,
    runContext.threadId,
  );
  let currentTurnStart = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (transcript[index]?.role === 'user') {
      currentTurnStart = index;
      break;
    }
  }
  if (currentTurnStart < 0) {
    throw new Error('recoverable run has no persisted user input');
  }
  const currentTurn = transcript.slice(currentTurnStart);
  const resultCallIds = new Set<string>();
  const transcriptCallIds = new Set<string>();
  for (const entry of currentTurn) {
    if (entry.role !== 'tool_result') {
      continue;
    }
    const parsed = tryParseJsonRecord(entry.content);
    const callId = parsed.ok ? readString(parsed.value.callId) : undefined;
    if (callId) {
      resultCallIds.add(callId);
    }
  }
  const transcriptPendingCalls = currentTurn
    .filter((entry) => entry.role === 'tool_call')
    .map((entry) => parseRecoverableTranscriptToolCall(entry.content))
    .filter((call) => {
      transcriptCallIds.add(call.functionCall.callId);
      return !resultCallIds.has(call.functionCall.callId);
    });
  const history = await loadExistingHistory(
    runContext.stateRoot,
    runContext.threadId,
    providerTarget,
  );
  for (const item of history) {
    if (item.kind === 'function_call_output') {
      resultCallIds.add(item.callId);
    }
  }
  const providerRoundRecords = await readProviderRoundHistory(
    runContext.stateRoot,
    runContext.threadId,
  );
  const journalCallById = new Map(
    providerRoundRecords.flatMap((record) =>
      record.functionCalls.map(
        (functionCall) =>
          [functionCall.callId, { functionCall, round: record.round }] as const,
      ),
    ),
  );
  const providerPendingCalls: RecoverableTranscriptToolCall[] = [];
  for (const item of history) {
    if (
      item.kind !== 'backend_item' ||
      !isRecord(item.data) ||
      item.data['type'] !== 'function_call'
    ) {
      continue;
    }
    const callId = readString(item.data['call_id']);
    if (
      callId === undefined ||
      resultCallIds.has(callId) ||
      transcriptCallIds.has(callId)
    ) {
      continue;
    }
    const journalCall = journalCallById.get(callId);
    if (journalCall === undefined) {
      throw new Error(
        `provider function call is missing recovery metadata: ${callId}`,
      );
    }
    const parsedArgs = tryParseJsonRecord(journalCall.functionCall.arguments);
    if (!parsedArgs.ok) {
      throw new Error(
        `provider function call has invalid recovery arguments: ${callId}`,
      );
    }
    providerPendingCalls.push({
      functionCall: {
        id: journalCall.functionCall.id,
        callId: journalCall.functionCall.callId,
        name: journalCall.functionCall.name,
        arguments: journalCall.functionCall.arguments,
      },
      toolArgs: parsedArgs.value,
      round: journalCall.round,
      ...(journalCall.functionCall.replaySafe
        ? { recoveryStrategy: 'replay_safe' as const }
        : {}),
      transcriptRecorded: false,
    });
  }
  const pendingCalls = [...transcriptPendingCalls, ...providerPendingCalls];

  if (pendingCalls.length > 0) {
    const pendingPtcRuntimeCall = pendingCalls.some(
      (pending) =>
        pending.functionCall.name === PTC_EXECUTE_CODE_TOOL_NAME ||
        pending.functionCall.name === PTC_EXECUTE_CODE_WAIT_TOOL_NAME ||
        pending.functionCall.name === PTC_PACKAGE_INSTALL_TOOL_NAME,
    );
    if (pendingPtcRuntimeCall) {
      const cleanup = await runtimeServices.ptcExecuteCode.reapRestartResidue?.(
        {
          stateRoot: runContext.stateRoot,
        },
      );
      if (cleanup === undefined) {
        throw new Error('PTC restart residue cleanup is unavailable');
      }
      if (!cleanup.ok) {
        throw new Error('PTC restart residue cleanup failed');
      }
    }

    const emit: AgentEventEmitter = (type, payload) => {
      agentInput.onEvent(createAgentEvent(type, payload));
    };
    const executionContextBase = buildAgentToolExecutionContextBase({
      runContext,
      runId: agentInput.runId,
      approvalContext: agentInput.approvalContext,
      emit,
      currentFile: agentInput.currentFile,
      selection: agentInput.selection,
      signal: agentInput.signal,
      runState: agentInput.runState,
      ...(agentInput.toolSurface === undefined
        ? {}
        : {
            allowedRegistryNames: agentInput.toolSurface.allowedRegistryNames,
          }),
      ...(agentInput.subagentModelRouting === undefined
        ? {}
        : { subagentModelRouting: agentInput.subagentModelRouting }),
      ...(runtimeServices.computerFileRoot === undefined
        ? {}
        : { computerFileRoot: runtimeServices.computerFileRoot }),
      fileStateCache: runtimeServices.fileStateCache,
      memoryIndex: runtimeServices.memoryIndex,
      agentSpawnRuntime: runtimeServices,
    });
    const runtime = buildToolCallExecutionRuntime({
      approvalContext: agentInput.approvalContext,
      emit,
      toolRegistry: runtimeServices.toolRegistry,
      approvalGate: runtimeServices.approvalGate,
      approvalGrants: runtimeServices.approvalGrants,
      executionContextBase,
    });

    for (const pending of pendingCalls) {
      if (pending.transcriptRecorded) {
        emit('tool_call', {
          callId: pending.functionCall.callId,
          step: pending.round,
          tool: pending.functionCall.name,
          args: pending.toolArgs,
        });
      } else {
        await recordToolCall({
          functionCall: pending.functionCall,
          round: pending.round,
          toolArgs: pending.toolArgs,
          runContext,
          emit,
          ...(pending.recoveryStrategy === undefined
            ? {}
            : { recoveryStrategy: pending.recoveryStrategy }),
        });
      }
      const currentStrategy = runtimeServices.toolRegistry.getToolMeta(
        pending.functionCall.name,
      )?.recoveryStrategy;
      const execution =
        pending.recoveryStrategy === 'replay_safe' &&
        currentStrategy === 'replay_safe'
          ? await executeFunctionCall({
              functionCall: pending.functionCall,
              round: pending.round,
              toolArgs: pending.toolArgs,
              history,
              runtime,
              deferTerminalFailure: true,
            })
          : {
              ok: true as const,
              value: toolError(
                'execution_failed',
                `tool "${pending.functionCall.name}" cannot be replayed after daemon restart because its durable recovery strategy is unavailable`,
              ),
            };
      const toolResult = execution.ok
        ? execution.value
        : toolError(
            'execution_failed',
            `tool "${pending.functionCall.name}" recovery could not settle`,
          );
      await recordToolResult({
        functionCall: pending.functionCall,
        round: pending.round,
        toolResult,
        toolOutputRecoveryAvailable: isToolOutputRecoveryAvailable(runtime),
        computerFilesMayHaveChanged: false,
        runContext,
        runId: agentInput.runId,
        history,
        emit,
      });
    }
  }

  return {
    ...recoverableInput,
    recoveredCallCount: pendingCalls.length,
  };
}

async function readRecoverableRunPrompts(args: {
  stateRoot: string;
  threadId: string;
  providerTarget: ProviderHistoryTarget;
}): Promise<{ modelPrompt: string; transcriptPrompt: string }> {
  const transcript = await readTranscriptEntries(args.stateRoot, args.threadId);
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry?.role !== 'user') {
      continue;
    }
    const history = await loadExistingHistory(
      args.stateRoot,
      args.threadId,
      args.providerTarget,
    );
    return {
      modelPrompt: readLatestUserPrompt(history),
      transcriptPrompt: entry.content,
    };
  }
  throw new Error('recoverable run has no persisted user input');
}

function parseRecoverableTranscriptToolCall(
  content: string,
): RecoverableTranscriptToolCall {
  const parsed = tryParseJsonRecord(content);
  if (!parsed.ok) {
    throw new Error('invalid recoverable transcript tool call');
  }
  const id = readString(parsed.value.id);
  const callId = readString(parsed.value.callId);
  const name = readString(parsed.value.tool);
  const toolArgs = parsed.value.args;
  const round = parsed.value.round;
  const recoveryStrategy = readToolRecoveryStrategy(
    parsed.value.recoveryStrategy,
  );
  if (
    !id ||
    !callId ||
    !name ||
    typeof toolArgs !== 'object' ||
    toolArgs === null ||
    Array.isArray(toolArgs) ||
    typeof round !== 'number' ||
    !Number.isSafeInteger(round) ||
    round < 0
  ) {
    throw new Error('invalid recoverable transcript tool call');
  }
  return {
    functionCall: {
      id,
      callId,
      name,
      arguments: JSON.stringify(toolArgs),
    },
    toolArgs: { ...toolArgs },
    round,
    ...(recoveryStrategy === undefined ? {} : { recoveryStrategy }),
    transcriptRecorded: true,
  };
}

function readLatestUserPrompt(history: readonly HistoryItem[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.kind === 'user') {
      return item.text;
    }
  }
  throw new Error('recoverable run history has no user prompt');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readToolRecoveryStrategy(
  value: unknown,
): ToolRecoveryStrategy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === 'replay_safe' ||
    value === 'idempotency_key' ||
    value === 'reconcile_then_replay' ||
    value === 'durable_handle' ||
    value === 'at_least_once'
  ) {
    return value;
  }
  throw new Error('invalid recoverable transcript tool recovery strategy');
}
