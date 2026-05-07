import type { RunSessionViewModel } from './run-session-view-model.js';
import { createProjectWorkspaceRunSessionView } from './project-workspace-run-session-view.js';

export function createProjectWorkspaceRunSessionInput(
  runSession: RunSessionViewModel,
): Parameters<typeof createProjectWorkspaceRunSessionView>[0]['runSession'] {
  return {
    isRunStarting: runSession.isRunStarting,
    isRunning: runSession.isRunning,
    isRunSettling: runSession.isSettling,
    transcriptEntries: runSession.transcriptEntries,
    finalAnswerText: runSession.finalAnswerText,
    activeArtifact: runSession.activeArtifact,
    pendingApproval: runSession.pendingApproval,
    permissionMode: runSession.permissionMode,
    streamError: runSession.streamError,
    backgroundNotifications: runSession.backgroundNotifications,
    setPermissionMode: runSession.setPermissionMode,
    sendPrompt: runSession.sendPrompt,
    startRunRequest: runSession.startRunRequest,
    handleApprove: runSession.handleApprove,
    handleDeny: runSession.handleDeny,
    handleCancel: runSession.handleCancel,
  };
}
