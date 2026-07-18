import {
  assertThreadId as assertValidThreadId,
  type ThreadId,
} from '@geulbat/protocol/ids';

export interface RunContext {
  threadId: ThreadId;
  stateRoot: string;
  workingDirectory: string;
}

export function createRunContext(context: {
  threadId: string | ThreadId;
  stateRoot: string;
  workingDirectory?: string;
}): RunContext {
  if (!context.stateRoot.trim()) {
    throw new Error('run stateRoot is required');
  }

  return {
    threadId: assertValidThreadId(context.threadId),
    stateRoot: context.stateRoot,
    workingDirectory: context.workingDirectory ?? '',
  };
}
