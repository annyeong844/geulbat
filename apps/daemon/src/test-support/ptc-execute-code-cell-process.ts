import type {
  DetachedProcessExitInfo,
  DetachedProcessHandle,
  DetachedProcessOutputSegment,
} from '../daemon/ptc/runtime/execute-code/execute-code-cell-process.js';

export function makeDetachedSegment(
  args: Partial<DetachedProcessOutputSegment> = {},
): DetachedProcessOutputSegment {
  return {
    stdout: args.stdout ?? '',
    stderr: args.stderr ?? '',
  };
}

export function makeDetachedHandle(args: {
  outputRef?: string;
  output: DetachedProcessOutputSegment;
  exit?: Promise<DetachedProcessExitInfo>;
}): DetachedProcessHandle {
  return {
    ...(args.outputRef === undefined ? {} : { outputRef: args.outputRef }),
    drainNewOutput: () => args.output,
    exit:
      args.exit ??
      Promise.resolve({
        kind: 'exit',
        exitCode: 0,
        processTerminated: true,
      }),
    terminate: () => {},
  };
}

export function deferredDetachedProcessExit(): {
  promise: Promise<DetachedProcessExitInfo>;
  resolve(exit: DetachedProcessExitInfo): void;
} {
  let resolveExit: (exit: DetachedProcessExitInfo) => void;
  const promise = new Promise<DetachedProcessExitInfo>((resolve) => {
    resolveExit = resolve;
  });
  return {
    promise,
    resolve: (exit) => resolveExit(exit),
  };
}

export function makeExitGatedDetachedHandle(args: {
  output: DetachedProcessOutputSegment;
  exit: Promise<DetachedProcessExitInfo>;
}): DetachedProcessHandle {
  let exited = false;
  let pending = args.output;
  return {
    drainNewOutput: () => {
      if (!exited) {
        return makeDetachedSegment();
      }
      const output = pending;
      pending = makeDetachedSegment();
      return output;
    },
    exit: args.exit.then((exit) => {
      exited = true;
      return exit;
    }),
    terminate: () => {},
  };
}
