import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
} from '../daemon/ptc/runtime/execute-code/execute-code-cell-process.js';
import type { PtcExecuteCodeCellId } from '../daemon/ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { makeDetachedSegment } from './ptc-execute-code-cell-process.js';

export const TEST_EXECUTE_CODE_CELL_REGISTRY_THREAD_ID =
  'thread-ptc-cell-registry';

export function makeCellIdFactory(prefix: string): () => PtcExecuteCodeCellId {
  let next = 0;
  return () => `${prefix}_${(next += 1)}` as PtcExecuteCodeCellId;
}

export function makeTerminalResult(args: {
  stdout: string;
  stderr?: string;
  exit?: DetachedProcessExitInfo;
}): {
  status: 'completed';
  output: DetachedProcessOutputSegment;
  exit: DetachedProcessExitInfo;
} {
  return {
    status: 'completed',
    output: makeDetachedSegment({
      stdout: args.stdout,
      ...(args.stderr !== undefined ? { stderr: args.stderr } : {}),
    }),
    exit: args.exit ?? { kind: 'exit', exitCode: 0, processTerminated: true },
  };
}

export function makeTrackedDetachedHandle(args: {
  output: DetachedProcessOutputSegment;
  exit?: DetachedProcessExitInfo | Promise<DetachedProcessExitInfo>;
}): DetachedProcessHandle & {
  terminatedCount(): number;
  terminateGraceMsValues(): number[];
} {
  let terminated = 0;
  const terminateGraceMsValues: number[] = [];
  return {
    drainNewOutput: () => args.output,
    exit: Promise.resolve(
      args.exit ?? { kind: 'exit', exitCode: 0, processTerminated: true },
    ),
    terminate: ({ graceMs }) => {
      terminated += 1;
      terminateGraceMsValues.push(graceMs);
    },
    terminatedCount: () => terminated,
    terminateGraceMsValues: () => [...terminateGraceMsValues],
  };
}
