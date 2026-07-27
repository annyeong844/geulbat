import { z } from 'zod';
import {
  PTC_EXECUTE_CODE_CELL_WAIT_MAX_YIELD_MS,
  PTC_EXECUTE_CODE_CELL_WAIT_MIN_YIELD_MS,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  stringifyPtcExecuteCodeWaitSummary,
  type PtcExecuteCodeRuntimeWaitFailureReason,
  type PtcExecuteCodeRuntimeWaitResult,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import type { ErrorCode } from '../../error-codes.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';
import type { AgentRuntimePtcServices } from '../../daemon-runtime-contract.js';

// This tool depends only on its own PTC runtime; keep the declared
// service surface that narrow.
type WaitToolServices = {
  ptc: Pick<AgentRuntimePtcServices, 'executeCode'>;
};

const waitArgsSchema = z.strictObject({
  cell_id: z
    .string()
    .min(1, 'cell_id is required.')
    .refine((value) => value.trim().length > 0, {
      message: 'cell_id is required.',
    })
    .max(256)
    .describe(
      'PTC exec cell id returned as cellId when exec reports status "queued" or status "running". Use the exact key cell_id; cellId is not accepted.',
    ),
  terminate: z
    .boolean()
    .optional()
    .describe('Terminate a still-running cell before returning its output.'),
  'yield-time_ms': z
    .number()
    .int()
    .min(PTC_EXECUTE_CODE_CELL_WAIT_MIN_YIELD_MS)
    .max(PTC_EXECUTE_CODE_CELL_WAIT_MAX_YIELD_MS)
    .optional()
    .describe(
      'Optional observation window in milliseconds. Use the exact key yield_time_ms; yieldTimeMs is not accepted. Omit it to wait until the cell produces new output, completes, or the run is aborted.',
    ),
});

type WaitArgs = z.output<typeof waitArgsSchema>;

export const waitTool = defineZodTool({
  name: PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  description:
    'Use after exec returns status "queued" or status "running" with a cellId. Pass that value as cell_id to observe admission or completion, read retained output, or cancel/terminate the PTC exec cell. If the required cell is still queued or running after the observation window, call wait again with the same cell_id instead of ending the task.',
  argsSchema: waitArgsSchema,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  parallelBatchKind: 'ptc_cell',
  abortSettlement: 'await_execution',
  requiresApproval: false,
  recoveryStrategy: 'durable_handle',
  resultProjection: {
    exactDurableRecovery: true,
    modelProjection: 'runtime_summary',
    snapshotFailure: 'inline',
  },
  catalogSearchMetadata: {
    family: 'ptc',
    searchHints: ['wait cell', 'wait for output', 'cell output', 'poll exec'],
    tags: ['ptc', 'cell', 'wait'],
    whenToUse:
      'Wait for output or completion from a previously yielded PTC cell.',
    notFor: 'Waiting for subagents or starting a new code cell.',
  },
  async executeParsed(args: WaitArgs, ctx) {
    if (!ctx.threadId || !ctx.stateRoot) {
      return toolError('execution_failed', 'thread context is required.');
    }
    const services: WaitToolServices | undefined = ctx.runtimeServices;
    const runtime = services?.ptc.executeCode;
    if (!runtime) {
      return toolError('execution_failed', 'PTC exec runtime is required.');
    }

    const result = await runtime.waitForCell({
      runContext: { threadId: ctx.threadId, stateRoot: ctx.stateRoot },
      request: {
        cellId: args.cell_id,
        ...(args.terminate !== undefined ? { terminate: args.terminate } : {}),
        ...(args['yield-time_ms'] !== undefined
          ? { yieldTimeMs: args['yield-time_ms'] }
          : {}),
      },
      ...(ctx.runId === undefined
        ? {}
        : { invocation: { runId: ctx.runId, callId: ctx.callId } }),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    if (!result.ok) {
      return {
        ok: false,
        output: stringifyWaitFailure(result),
        errorCode: waitFailureToToolErrorCode(result.reasonCode),
        error: result.message,
      };
    }

    return {
      ok: true,
      output: stringifyPtcExecuteCodeWaitSummary(result.value),
    };
  },
});

function stringifyWaitFailure(
  failure: Extract<PtcExecuteCodeRuntimeWaitResult, { ok: false }>,
): string {
  return JSON.stringify({
    kind: 'ptc_execute_code_cell_wait_error',
    reasonCode: failure.reasonCode,
    message: failure.message,
    ...(failure.store === undefined ? {} : { store: failure.store }),
    ...(failure.storeError === undefined
      ? {}
      : { storeError: failure.storeError }),
  });
}

function waitFailureToToolErrorCode(
  reasonCode: PtcExecuteCodeRuntimeWaitFailureReason,
): ErrorCode {
  switch (reasonCode) {
    case 'ptc_execute_code_invalid':
      return 'invalid_args';
    case 'ptc_execute_code_cell_wait_cancelled':
      return 'aborted';
    case 'ptc_lab_command_timeout':
      return 'timeout';
    default:
      return 'execution_failed';
  }
}
