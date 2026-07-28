import { isRecord, tryParseJson } from '../runtime-json.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import type { FunctionCall } from '../llm/index.js';
import type { RunContext } from '../run-context.js';
import type { ExecuteResult } from '../tools/types.js';
import type { ToolResultProjectionCapability } from '../tools/tool-registry-model.js';
import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  type ToolOutputSnapshot,
  writeToolOutputSnapshot,
} from '../files/tool-output-store.js';
import { parseHostCommandOutputRef } from '../host-command-output-store.js';
import {
  PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_RUN_ID,
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
} from '../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import type {
  ToolResultObservation,
  ToolResultParseQuality,
  ToolResultProjectionOutcome,
} from './observer/agent-loop-observer.js';
import {
  buildSlimOutput,
  readToolOutputSource,
  type ToolOutputPreviewProjection,
} from './tool-output-projection-formatters.js';

const logger = createLogger('tool-output-offload');

const TOOL_OUTPUT_INLINE_MAX_BYTES_ENV = 'GEULBAT_TOOL_OUTPUT_INLINE_MAX_BYTES';
const DEFAULT_TOOL_OUTPUT_INLINE_MAX_BYTES = 40 * 1024;

interface ToolOutputProjectionPolicy {
  inlineMaxBytes: number;
}

type ToolOutputProjectionPolicyEnv = Partial<
  Record<typeof TOOL_OUTPUT_INLINE_MAX_BYTES_ENV, string>
>;

export function resolveToolOutputProjectionPolicyFromEnv(
  env: ToolOutputProjectionPolicyEnv = process.env,
): ToolOutputProjectionPolicy {
  return {
    inlineMaxBytes: readPositiveIntegerEnv(
      env,
      TOOL_OUTPUT_INLINE_MAX_BYTES_ENV,
      DEFAULT_TOOL_OUTPUT_INLINE_MAX_BYTES,
    ),
  };
}

const PROCESS_TOOL_OUTPUT_PROJECTION_POLICY =
  resolveToolOutputProjectionPolicyFromEnv();

interface ToolOutputOffloadArgs {
  functionCall: Pick<FunctionCall, 'callId' | 'name' | 'arguments'>;
  runContext: Pick<RunContext, 'threadId' | 'stateRoot'>;
  runId: string;
  projectionPolicy?: ToolOutputProjectionPolicy;
  projectionRound?: ToolOutputProjectionRound;
  measureModelVisibleResultBytes?: (toolResult: ExecuteResult) => number;
  observeToolResult?: (observation: ToolResultObservation) => void;
  elapsedMs?: number | null;
  resultProjection?: ToolResultProjectionCapability;
  toolOutputRecoveryAvailable?: boolean;
  toolResult: ExecuteResult;
}

interface PriorProjectedToolOutput {
  callId: string;
  outputRef: string;
}

export interface ToolOutputProjectionRound {
  findExactDuplicate(output: string): PriorProjectedToolOutput | undefined;
  getInlineShareBytes(): number;
  recordVisibleResult(args: {
    fullOutput: string;
    modelVisibleBytes: number;
    outputRef?: string;
    callId: string;
  }): void;
}

export function createToolOutputProjectionRound(args: {
  availableModelVisibleBytes: number | undefined;
  resultCount: number;
}): ToolOutputProjectionRound {
  let remainingModelVisibleBytes = args.availableModelVisibleBytes ?? 0;
  let remainingResultCount = args.resultCount;
  const firstOutputByExactBody = new Map<string, PriorProjectedToolOutput>();

  return {
    findExactDuplicate(output) {
      return firstOutputByExactBody.get(output);
    },
    getInlineShareBytes() {
      if (remainingResultCount <= 0) {
        return 0;
      }
      return Math.floor(remainingModelVisibleBytes / remainingResultCount);
    },
    recordVisibleResult({ fullOutput, modelVisibleBytes, outputRef, callId }) {
      remainingModelVisibleBytes = Math.max(
        0,
        remainingModelVisibleBytes - modelVisibleBytes,
      );
      remainingResultCount = Math.max(0, remainingResultCount - 1);
      if (outputRef !== undefined && !firstOutputByExactBody.has(fullOutput)) {
        firstOutputByExactBody.set(fullOutput, { callId, outputRef });
      }
    },
  };
}

interface DuplicateSlimOutput {
  offloaded: true;
  duplicate: true;
  tool: string;
  callId: string;
  outputRef: string;
  duplicateOfCallId: string;
  duplicateOfOutputRef: string;
  summary: string;
  fullOutputBytes: number;
  fullOutputChars: number;
}

export async function maybeOffloadToolResult(
  args: ToolOutputOffloadArgs,
): Promise<ExecuteResult> {
  const { functionCall, runContext, runId, toolResult } = args;
  const fullOutputBytes = Buffer.byteLength(toolResult.output, 'utf8');
  const parsedOutput = tryParseJson(toolResult.output);
  const projectionRound = args.projectionRound;
  const measureModelVisibleResultBytes = args.measureModelVisibleResultBytes;
  if (
    (projectionRound !== undefined || args.observeToolResult !== undefined) &&
    measureModelVisibleResultBytes === undefined
  ) {
    throw new Error(
      'tool output projection feedback requires a model-visible byte measurer',
    );
  }
  const finish = (
    result: ExecuteResult,
    projection: ToolResultProjectionOutcome,
    outputRef?: string,
  ): ExecuteResult => {
    const modelVisibleBytes = measureModelVisibleResultBytes?.(result);
    if (projectionRound !== undefined && modelVisibleBytes !== undefined) {
      projectionRound.recordVisibleResult({
        fullOutput: toolResult.output,
        modelVisibleBytes,
        ...(outputRef === undefined ? {} : { outputRef }),
        callId: functionCall.callId,
      });
    }
    if (
      args.observeToolResult !== undefined &&
      modelVisibleBytes !== undefined
    ) {
      args.observeToolResult({
        schemaVersion: 1,
        runId,
        threadId: runContext.threadId,
        callId: functionCall.callId,
        toolName: functionCall.name,
        outcome: result.ok ? 'success' : 'failure',
        elapsedMs: args.elapsedMs ?? null,
        fullOutputBytes,
        modelVisibleBytes,
        parseQuality: classifyToolResultParseQuality(
          toolResult.output,
          parsedOutput,
        ),
        projection,
        exactDurableRecovery:
          args.resultProjection?.exactDurableRecovery === true,
      });
    }
    return result;
  };
  const recoveryAvailable = args.toolOutputRecoveryAvailable ?? true;
  const resultProjection = args.resultProjection;
  if (resultProjection === undefined || !recoveryAvailable) {
    return finish(toolResult, 'inline');
  }

  const projectionPolicy =
    args.projectionPolicy ?? PROCESS_TOOL_OUTPUT_PROJECTION_POLICY;
  const exceedsIndividualInlineBudget =
    fullOutputBytes > projectionPolicy.inlineMaxBytes;
  if (projectionRound === undefined && !exceedsIndividualInlineBudget) {
    return finish(toolResult, 'inline');
  }

  const existingRecoveryRef = readExistingDurableRecoveryRef({
    toolName: functionCall.name,
    parsedOutput,
    threadId: runContext.threadId,
  });
  if (existingRecoveryRef !== undefined) {
    return finish(toolResult, 'existing_ref', existingRecoveryRef);
  }

  const priorExactDuplicate = projectionRound?.findExactDuplicate(
    toolResult.output,
  );
  const outputRef = buildToolOutputRef({
    callId: functionCall.callId,
    runId,
    threadId: runContext.threadId,
  });
  const parsedArguments = tryParseJson(functionCall.arguments);
  const source = readToolOutputSource(
    functionCall.name,
    parsedOutput,
    parsedArguments,
  );
  const snapshot = buildToolOutputSnapshot({
    outputRef,
    threadId: runContext.threadId,
    runId,
    callId: functionCall.callId,
    toolName: functionCall.name,
    output: toolResult.output,
    ...(source ? { source } : {}),
  });

  const projectedInlineShareBytes = projectionRound?.getInlineShareBytes();
  const fitsProjectedOutput =
    projectedInlineShareBytes !== undefined &&
    measureModelVisibleResultBytes !== undefined
      ? (output: ToolOutputPreviewProjection) => {
          const serializedOutput = JSON.stringify({
            ...output,
            ok: toolResult.ok,
          });
          return (
            Buffer.byteLength(serializedOutput, 'utf8') <=
              projectionPolicy.inlineMaxBytes &&
            measureModelVisibleResultBytes(
              withToolResultOutput(toolResult, serializedOutput),
            ) <= projectedInlineShareBytes
          );
        }
      : undefined;
  const projectedOutput = JSON.stringify({
    ...(priorExactDuplicate === undefined
      ? buildSlimOutput(
          snapshot,
          resultProjection.modelProjection,
          fitsProjectedOutput,
        )
      : buildDuplicateSlimOutput(snapshot, priorExactDuplicate)),
    ok: toolResult.ok,
  });
  const projectedToolResult = withToolResultOutput(toolResult, projectedOutput);
  const fullModelVisibleBytes = measureModelVisibleResultBytes?.(toolResult);
  const projectedModelVisibleBytes =
    measureModelVisibleResultBytes?.(projectedToolResult);
  const aggregatePrefersProjection =
    projectionRound !== undefined &&
    fullModelVisibleBytes !== undefined &&
    projectedModelVisibleBytes !== undefined &&
    fullModelVisibleBytes > projectionRound.getInlineShareBytes() &&
    projectedModelVisibleBytes < fullModelVisibleBytes;
  const shouldProject =
    priorExactDuplicate !== undefined ||
    exceedsIndividualInlineBudget ||
    aggregatePrefersProjection;
  if (!shouldProject) {
    return finish(toolResult, 'inline');
  }

  try {
    await writeToolOutputSnapshot({
      stateRoot: runContext.stateRoot,
      snapshot,
    });
  } catch {
    logger.warn('failed to offload tool output snapshot:', {
      callId: functionCall.callId,
      runId,
      threadId: runContext.threadId,
      toolName: functionCall.name,
    });
    if (resultProjection.snapshotFailure === 'inline') {
      const output = buildSnapshotFailureInlineFallback(
        toolResult.output,
        functionCall.name,
      );
      return finish(
        withToolResultOutput(toolResult, output),
        'snapshot_failed_inline',
      );
    }
    if (!toolResult.ok) {
      return finish(
        {
          ...toolResult,
          output: buildSnapshotFailureInlineFallback(
            toolResult.output,
            functionCall.name,
          ),
        },
        'snapshot_failed_inline',
      );
    }
    return finish(
      {
        ok: false,
        output: '',
        errorCode: 'internal',
        error:
          'failed to offload tool output snapshot; full output was not recorded.',
      },
      'snapshot_failed',
    );
  }
  return finish(
    projectedToolResult,
    priorExactDuplicate === undefined ? 'summary_ref' : 'duplicate_ref',
    outputRef,
  );
}

function withToolResultOutput(
  toolResult: ExecuteResult,
  output: string,
): ExecuteResult {
  return toolResult.ok
    ? { ok: true, output }
    : {
        ok: false,
        output,
        errorCode: toolResult.errorCode,
        error: toolResult.error,
        ...(toolResult.diagnostics === undefined
          ? {}
          : { diagnostics: toolResult.diagnostics }),
      };
}

function classifyToolResultParseQuality(
  output: string,
  parsedOutput: ReturnType<typeof tryParseJson>,
): ToolResultParseQuality {
  if (output.length === 0) {
    return 'empty';
  }
  return parsedOutput.ok ? 'structured_json' : 'opaque_text';
}

function buildDuplicateSlimOutput(
  snapshot: ToolOutputSnapshot,
  prior: PriorProjectedToolOutput,
): DuplicateSlimOutput {
  return {
    offloaded: true,
    duplicate: true,
    tool: snapshot.toolName,
    callId: snapshot.callId,
    outputRef: snapshot.outputRef,
    duplicateOfCallId: prior.callId,
    duplicateOfOutputRef: prior.outputRef,
    summary: `${snapshot.toolName} returned the exact same result body as call ${prior.callId}. The complete result remains available through this call's outputRef.`,
    fullOutputBytes: snapshot.fullOutputBytes,
    fullOutputChars: snapshot.fullOutputChars,
  };
}

function readPositiveIntegerEnv(
  env: ToolOutputProjectionPolicyEnv,
  name: keyof ToolOutputProjectionPolicyEnv,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = raw.trim();
  if (!value) {
    throw new Error(`invalid ${name}: empty`);
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`invalid ${name}: expected positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`invalid ${name}: expected positive integer`);
  }
  return parsed;
}

function buildSnapshotFailureInlineFallback(
  output: string,
  tool: string,
): string {
  const parsed = tryParseJson(output);
  const record = parsed.ok && isRecord(parsed.value) ? parsed.value : null;

  return JSON.stringify({
    ...(record ?? { output }),
    offloaded: false,
    tool,
    outputSnapshot: {
      ok: false,
      errorCode: 'snapshot_write_failed',
    },
    recoveryTool: null,
    summary:
      'Durable output snapshot failed; the exact tool result is retained inline for this history entry.',
  });
}

function readExistingDurableRecoveryRef(args: {
  toolName: string;
  parsedOutput: ReturnType<typeof tryParseJson>;
  threadId: string;
}): string | undefined {
  if (!args.parsedOutput.ok || !isRecord(args.parsedOutput.value)) {
    return undefined;
  }
  const output = args.parsedOutput.value;
  const waitRef = readExistingWaitRecoveryRef({
    toolName: args.toolName,
    output,
    threadId: args.threadId,
  });
  if (waitRef !== undefined) {
    return waitRef;
  }
  const candidate =
    args.toolName === 'exec_command' && typeof output.outputRef === 'string'
      ? output.outputRef
      : args.toolName === 'write_stdin' &&
          isRecord(output.snapshot) &&
          typeof output.snapshot.outputRef === 'string'
        ? output.snapshot.outputRef
        : undefined;
  if (candidate === undefined) {
    return undefined;
  }
  const parsedRef = parseHostCommandOutputRef(candidate);
  return parsedRef.ok && parsedRef.threadId === args.threadId
    ? candidate
    : undefined;
}

function readExistingWaitRecoveryRef(args: {
  toolName: string;
  output: Record<string, unknown>;
  threadId: string;
}): string | undefined {
  if (args.toolName !== 'wait' || typeof args.output.cellId !== 'string') {
    return undefined;
  }
  const expectedOutputRef = buildToolOutputRef({
    threadId: args.threadId,
    runId: PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_RUN_ID,
    callId: args.output.cellId,
  });
  const output = args.output;
  const valid =
    output.kind === 'ptc_execute_code_cell_wait' &&
    output.capabilityId === PTC_EXECUTE_CODE_TOOL_NAME &&
    output.policyId === PTC_EXECUTE_CODE_POLICY_ID &&
    output.executionSurface === 'node_via_lab_detached_cell' &&
    (output.status === 'completed' ||
      output.status === 'terminated' ||
      output.status === 'completed_with_cleanup_failure' ||
      output.status === 'terminated_with_cleanup_failure') &&
    (output.exitCode === null ||
      (typeof output.exitCode === 'number' &&
        Number.isSafeInteger(output.exitCode))) &&
    output.offloaded === true &&
    output.recoveryTool === 'read_tool_output' &&
    output.outputRef === expectedOutputRef &&
    typeof output.fullOutputBytes === 'number' &&
    Number.isSafeInteger(output.fullOutputBytes) &&
    output.fullOutputBytes >= 0 &&
    typeof output.fullOutputChars === 'number' &&
    Number.isSafeInteger(output.fullOutputChars) &&
    output.fullOutputChars >= 0;
  return valid ? expectedOutputRef : undefined;
}
