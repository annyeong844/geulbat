import { isRecord, tryParseJson } from './runtime-json.js';
import {
  buildToolOutputRef,
  buildToolOutputSnapshot,
  readToolOutputSnapshot,
  writeToolOutputSnapshot,
} from './files/tool-output-store.js';
import {
  PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_RUN_ID,
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  isPtcExecuteCodeRuntimeCellTerminalStatus,
  type PtcExecuteCodeCellId,
  type PtcExecuteCodeCellTerminalResultStore,
  type PtcExecuteCodeRuntimeResult,
} from './ptc/runtime/execute-code/execute-code-runtime-contract.js';

const PTC_EXECUTE_CODE_CELL_TERMINAL_EXEC_RESULT_RUN_ID =
  '__ptc_execute_code_cell_terminal_exec_result__';

export function createPtcExecuteCodeCellTerminalResultStore(): PtcExecuteCodeCellTerminalResultStore {
  return {
    async persist(args) {
      const outputRef = buildPtcExecuteCodeCellTerminalResultOutputRef(args);
      const snapshot = buildToolOutputSnapshot({
        outputRef,
        threadId: args.threadId,
        runId: PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_RUN_ID,
        callId: args.cellId,
        toolName: PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
        output: args.output,
      });
      await writeToolOutputSnapshot({ stateRoot: args.stateRoot, snapshot });

      return {
        outputRef,
        fullOutputBytes: snapshot.fullOutputBytes,
        fullOutputChars: snapshot.fullOutputChars,
        status: args.status,
        exitCode: args.exitCode,
      };
    },

    async read(args) {
      const outputRef = buildPtcExecuteCodeCellTerminalResultOutputRef(args);
      let snapshotResult: Awaited<ReturnType<typeof readToolOutputSnapshot>>;
      try {
        snapshotResult = await readToolOutputSnapshot({
          stateRoot: args.stateRoot,
          threadId: args.threadId,
          outputRef,
        });
      } catch {
        return {
          ok: false,
          message: 'PTC execute_code durable terminal result is unavailable',
        };
      }
      if (!snapshotResult.ok) {
        if (snapshotResult.errorCode === 'not_found') {
          return { ok: true, value: undefined };
        }
        return { ok: false, message: snapshotResult.message };
      }

      const snapshot = snapshotResult.value;
      const parsed = tryParseJson(snapshot.output);
      if (
        snapshot.toolName !== PTC_EXECUTE_CODE_WAIT_TOOL_NAME ||
        !parsed.ok ||
        !isRecord(parsed.value) ||
        parsed.value.kind !== 'ptc_execute_code_cell_wait' ||
        parsed.value.capabilityId !== PTC_EXECUTE_CODE_TOOL_NAME ||
        parsed.value.policyId !== PTC_EXECUTE_CODE_POLICY_ID ||
        parsed.value.executionSurface !== 'node_via_lab_detached_cell' ||
        parsed.value.cellId !== args.cellId ||
        !isPtcExecuteCodeRuntimeCellTerminalStatus(parsed.value.status) ||
        (parsed.value.exitCode !== null &&
          typeof parsed.value.exitCode !== 'number') ||
        typeof parsed.value.stdout !== 'string' ||
        typeof parsed.value.stderr !== 'string'
      ) {
        return {
          ok: false,
          message: 'PTC execute_code durable terminal result is invalid',
        };
      }

      return {
        ok: true,
        value: {
          outputRef,
          fullOutputBytes: snapshot.fullOutputBytes,
          fullOutputChars: snapshot.fullOutputChars,
          status: parsed.value.status,
          exitCode: parsed.value.exitCode,
        },
      };
    },

    async persistRecovery(args) {
      const outputRef =
        buildPtcExecuteCodeCellTerminalExecResultOutputRef(args);
      await writeToolOutputSnapshot({
        stateRoot: args.stateRoot,
        snapshot: buildToolOutputSnapshot({
          outputRef,
          threadId: args.threadId,
          runId: PTC_EXECUTE_CODE_CELL_TERMINAL_EXEC_RESULT_RUN_ID,
          callId: args.cellId,
          toolName: PTC_EXECUTE_CODE_TOOL_NAME,
          output: JSON.stringify(args.result),
        }),
      });
    },

    async readRecovery(args) {
      return await readTerminalExecRecoveryResult(args);
    },
  };
}

async function readTerminalExecRecoveryResult(args: {
  stateRoot: string;
  threadId: string;
  cellId: PtcExecuteCodeCellId;
}): Promise<
  | { ok: true; value: PtcExecuteCodeRuntimeResult | undefined }
  | { ok: false; message: string }
> {
  const outputRef = buildPtcExecuteCodeCellTerminalExecResultOutputRef(args);
  let snapshotResult: Awaited<ReturnType<typeof readToolOutputSnapshot>>;
  try {
    snapshotResult = await readToolOutputSnapshot({
      stateRoot: args.stateRoot,
      threadId: args.threadId,
      outputRef,
    });
  } catch {
    return {
      ok: false,
      message: 'PTC execute_code durable terminal recovery is unavailable',
    };
  }
  if (!snapshotResult.ok) {
    return snapshotResult.errorCode === 'not_found'
      ? { ok: true, value: undefined }
      : { ok: false, message: snapshotResult.message };
  }
  const snapshot = snapshotResult.value;
  const parsed = tryParseJson(snapshot.output);
  if (
    snapshot.toolName !== PTC_EXECUTE_CODE_TOOL_NAME ||
    !parsed.ok ||
    !isPtcExecuteCodeRuntimeRecoveryResult(parsed.value)
  ) {
    return {
      ok: false,
      message: 'PTC execute_code durable terminal recovery is invalid',
    };
  }
  return { ok: true, value: parsed.value };
}

function isPtcExecuteCodeRuntimeRecoveryResult(
  value: unknown,
): value is PtcExecuteCodeRuntimeResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return false;
  }
  if (!value.ok) {
    return (
      typeof value.reasonCode === 'string' &&
      value.reasonCode.startsWith('ptc_') &&
      typeof value.message === 'string' &&
      (value.remediation === undefined ||
        typeof value.remediation === 'string') &&
      (value.diagnostics === undefined ||
        isRecoveryDiagnostics(value.diagnostics))
    );
  }
  const summary = value.value;
  return (
    isRecord(summary) &&
    summary.ok === true &&
    summary.capabilityId === PTC_EXECUTE_CODE_TOOL_NAME &&
    summary.policyId === PTC_EXECUTE_CODE_POLICY_ID &&
    summary.executionSurface === 'node_via_lab_batch_command' &&
    summary.executionClass === 'lab_execute_code' &&
    summary.profile === 'lab' &&
    Number.isSafeInteger(summary.exitCode) &&
    typeof summary.stdout === 'string' &&
    typeof summary.stderr === 'string' &&
    Number.isSafeInteger(summary.effectiveTimeoutMs) &&
    Number.isSafeInteger(summary.durationMs)
  );
}

function isRecoveryDiagnostics(
  value: unknown,
): value is Record<string, string | number | boolean> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        typeof entry === 'string' ||
        typeof entry === 'number' ||
        typeof entry === 'boolean',
    )
  );
}

function buildPtcExecuteCodeCellTerminalResultOutputRef(args: {
  threadId: string;
  cellId: PtcExecuteCodeCellId;
}): string {
  return buildToolOutputRef({
    threadId: args.threadId,
    runId: PTC_EXECUTE_CODE_CELL_TERMINAL_RESULT_RUN_ID,
    callId: args.cellId,
  });
}

function buildPtcExecuteCodeCellTerminalExecResultOutputRef(args: {
  threadId: string;
  cellId: PtcExecuteCodeCellId;
}): string {
  return buildToolOutputRef({
    threadId: args.threadId,
    runId: PTC_EXECUTE_CODE_CELL_TERMINAL_EXEC_RESULT_RUN_ID,
    callId: args.cellId,
  });
}
