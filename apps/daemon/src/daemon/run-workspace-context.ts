import {
  assertProjectId as assertValidProjectId,
  assertThreadId as assertValidThreadId,
  type ProjectId,
  type ThreadId,
} from '@geulbat/protocol/ids';

export interface RunWorkspaceContext {
  threadId: ThreadId;
  projectId: ProjectId;
  workspaceRoot: string;
}

export function createRunWorkspaceContext(context: {
  threadId: string | ThreadId;
  projectId: string | ProjectId;
  workspaceRoot: string;
}): RunWorkspaceContext {
  return {
    threadId: assertValidThreadId(context.threadId),
    projectId: assertValidProjectId(context.projectId),
    workspaceRoot: context.workspaceRoot,
  };
}
