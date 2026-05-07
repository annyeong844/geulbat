import type { ApprovalContext } from '../daemon/agent/loop-types.js';

export function makeApprovalContext(
  overrides: Partial<ApprovalContext> = {},
): ApprovalContext {
  return {
    sessionId: 'session-1',
    permissionMode: 'basic',
    ...overrides,
  };
}
