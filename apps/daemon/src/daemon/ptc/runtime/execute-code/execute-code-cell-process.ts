import type {
  DetachedProcessHandle,
  DetachedProcessOutputBufferPolicy,
  DetachedProcessOutputOffsets,
  DetachedProcessStartResult,
} from '../../../utils/detached-process.js';

export interface ExecuteCodeCellProcessInvocation {
  cellId: string;
  executable: string;
  args: string[];
  timeoutMs?: number;
  redactionMarkers?: readonly string[];
  redactionReplacement?: string;
  outputBufferPolicy?: DetachedProcessOutputBufferPolicy;
}

type ExecuteCodeCellProcessStartResult =
  DetachedProcessStartResult<DetachedProcessHandle>;

export type StartPtcExecuteCodeCellProcess = (
  invocation: ExecuteCodeCellProcessInvocation,
) =>
  | ExecuteCodeCellProcessStartResult
  | Promise<ExecuteCodeCellProcessStartResult>;

export type AttachPtcExecuteCodeCellProcess = (args: {
  outputRef: string;
  outputBufferPolicy?: DetachedProcessOutputBufferPolicy;
  outputReadOffsets?: DetachedProcessOutputOffsets;
}) =>
  | ExecuteCodeCellProcessStartResult
  | Promise<ExecuteCodeCellProcessStartResult>;

export type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessPreparedOutputDelivery,
  DetachedProcessOutputSegment,
} from '../../../utils/detached-process.js';
