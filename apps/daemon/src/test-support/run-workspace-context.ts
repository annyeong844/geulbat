import type { RunWorkspaceContext } from '../daemon/run-workspace-context.js';
import { testProjectId } from './project-id.js';
import { testThreadId } from './thread-id.js';

export function makeRunWorkspaceContext(
  overrides: Partial<RunWorkspaceContext> = {},
): RunWorkspaceContext {
  return {
    threadId: testThreadId(900),
    projectId: testProjectId(),
    workspaceRoot: '/tmp/workspace',
    ...overrides,
  };
}
