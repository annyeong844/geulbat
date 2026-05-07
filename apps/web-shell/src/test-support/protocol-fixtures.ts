import type { ApprovalRequired } from '@geulbat/protocol/run-approval';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';

export function makeApprovalRequiredFixture(
  overrides: Partial<ApprovalRequired> = {},
): ApprovalRequired {
  return {
    callId: 'call-1',
    runId: brandRunId('run-1'),
    threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    toolName: 'write_file',
    approvalClass: 'write_file',
    permissionMode: 'basic',
    argumentsPreview: {},
    sideEffectLevel: 'write',
    ...overrides,
  };
}
