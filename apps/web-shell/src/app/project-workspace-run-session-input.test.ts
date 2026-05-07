import test from 'node:test';
import assert from 'node:assert/strict';

import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { makeApprovalRequiredFixture } from '../test-support/protocol-fixtures.js';
import type { RunSessionViewModel } from './run-session-view-model.js';
import { createProjectWorkspaceRunSessionInput } from './project-workspace-run-session-input.js';

const RUN_ID = brandRunId('run-1');
const THREAD_ID = brandThreadId('00000000-0000-4000-8000-000000000001');

function createRunSessionViewModelStub(): RunSessionViewModel {
  return {
    visibleThreadId: THREAD_ID,
    activeRunId: RUN_ID,
    isRunStarting: true,
    isRunning: true,
    isSettling: true,
    transcriptEntries: [{ kind: 'assistant_text', text: 'commentary' }],
    finalAnswerText: 'done',
    activeArtifact: null,
    pendingApproval: makeApprovalRequiredFixture({
      runId: RUN_ID,
      threadId: THREAD_ID,
    }),
    permissionMode: 'full_access',
    setPermissionMode: () => {},
    streamError: 'stream failed',
    backgroundNotifications: [
      {
        kind: 'subagent_activity',
        childRunId: 'run-child-1',
        subagentType: 'worker',
        state: 'completed',
      },
    ],
    sendPrompt: async () => {},
    startRunRequest: async () => {},
    handleApprove: async () => {},
    handleDeny: async () => {},
    handleCancel: async () => {},
  };
}

void test('createProjectWorkspaceRunSessionInput preserves the run-session surface used by workspace shell', () => {
  const runSession = createRunSessionViewModelStub();
  const input = createProjectWorkspaceRunSessionInput(runSession);

  assert.equal(input.isRunStarting, true);
  assert.equal(input.isRunning, true);
  assert.equal(input.isRunSettling, true);
  assert.equal(input.transcriptEntries, runSession.transcriptEntries);
  assert.equal(input.finalAnswerText, 'done');
  assert.equal(input.activeArtifact, null);
  assert.equal(input.pendingApproval, runSession.pendingApproval);
  assert.equal(input.permissionMode, 'full_access');
  assert.equal(input.setPermissionMode, runSession.setPermissionMode);
  assert.equal(input.streamError, 'stream failed');
  assert.equal(
    input.backgroundNotifications,
    runSession.backgroundNotifications,
  );
  assert.equal(input.sendPrompt, runSession.sendPrompt);
  assert.equal(input.startRunRequest, runSession.startRunRequest);
  assert.equal(input.handleApprove, runSession.handleApprove);
  assert.equal(input.handleDeny, runSession.handleDeny);
  assert.equal(input.handleCancel, runSession.handleCancel);
});
