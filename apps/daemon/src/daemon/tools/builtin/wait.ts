import { z } from 'zod';
import {
  PTC_EXECUTE_CODE_CELL_WAIT_MAX_YIELD_MS,
  PTC_EXECUTE_CODE_CELL_WAIT_MIN_YIELD_MS,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  type PtcExecuteCodeRuntimeCellWaitSummary,
  type PtcExecuteCodeRuntimeWaitFailureReason,
  type PtcExecuteCodeRuntimeWaitResult,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import type { ErrorCode } from '../../error-codes.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const waitArgsSchema = z.strictObject({
  cell_id: z
    .string()
    .min(1, 'cell_id is required.')
    .refine((value) => value.trim().length > 0, {
      message: 'cell_id is required.',
    })
    .max(256)
    .describe(
      'PTC exec cell id returned as cellId when exec reports status "running". Use the exact key cell_id; cellId is not accepted.',
    ),
  terminate: z
    .boolean()
    .optional()
    .describe('Terminate a still-running cell before returning its output.'),
  yield_time_ms: z
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
    'Use after exec returns status "running" with a cellId. Pass that value as cell_id to observe completion, read retained output, or terminate the running PTC exec cell.',
  argsSchema: waitArgsSchema,
  sideEffectLevel: 'none',
  mayMutateWorkspaceFiles: false,
  parallelBatchKind: 'ptc_cell',
  requiresApproval: false,
  async executeParsed(args: WaitArgs, ctx) {
    if (!ctx.threadId) {
      return toolError('execution_failed', 'thread context is required.');
    }
    const runtime = ctx.agentSpawnRuntime?.ptcExecuteCode;
    if (!runtime) {
      return toolError('execution_failed', 'PTC exec runtime is required.');
    }

    const result = await runtime.waitForCell({
      runContext: { threadId: ctx.threadId },
      request: {
        cellId: args.cell_id,
        ...(args.terminate !== undefined ? { terminate: args.terminate } : {}),
        ...(args.yield_time_ms !== undefined
          ? { yieldTimeMs: args.yield_time_ms }
          : {}),
      },
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
      output: stringifyWaitSummary(result.value),
    };
  },
});

function stringifyWaitSummary(
  summary: PtcExecuteCodeRuntimeCellWaitSummary,
): string {
  if (summary.status === 'missing' || summary.status === 'expired') {
    return JSON.stringify({
      kind: 'ptc_execute_code_cell_wait',
      capabilityId: summary.capabilityId,
      policyId: summary.policyId,
      executionSurface: summary.executionSurface,
      status: summary.status,
      cellId: summary.cellId,
      remediation: summary.remediation,
    });
  }

  return JSON.stringify({
    kind: 'ptc_execute_code_cell_wait',
    capabilityId: summary.capabilityId,
    policyId: summary.policyId,
    executionSurface: summary.executionSurface,
    status: summary.status,
    cellId: summary.cellId,
    ...('exitCode' in summary ? { exitCode: summary.exitCode } : {}),
    stdout: summary.stdout,
    stderr: summary.stderr,
  });
}

function stringifyWaitFailure(
  failure: Extract<PtcExecuteCodeRuntimeWaitResult, { ok: false }>,
): string {
  return JSON.stringify({
    kind: 'ptc_execute_code_cell_wait_error',
    reasonCode: failure.reasonCode,
    message: failure.message,
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
    case 'ptc_execute_code_cell_wait_unavailable':
    case 'ptc_lab_command_output_rejected':
    case 'ptc_execute_code_session_cleanup_failed':
      return 'execution_failed';
  }
}
