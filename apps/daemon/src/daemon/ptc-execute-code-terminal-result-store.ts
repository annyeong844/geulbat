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
  type PtcExecuteCodeCellId,
  type PtcExecuteCodeCellTerminalResultStore,
  type PtcExecuteCodeRuntimeCellTerminalStatus,
} from './ptc/runtime/execute-code/execute-code-runtime-contract.js';

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
        !isPtcExecuteCodeTerminalWaitStatus(parsed.value.status) ||
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
  };
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

function isPtcExecuteCodeTerminalWaitStatus(
  value: unknown,
): value is PtcExecuteCodeRuntimeCellTerminalStatus {
  return (
    value === 'completed' ||
    value === 'terminated' ||
    value === 'completed_with_cleanup_failure' ||
    value === 'terminated_with_cleanup_failure'
  );
}
