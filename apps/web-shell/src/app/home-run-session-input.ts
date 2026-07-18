import type { RunSessionViewModel } from './run-session-view-model.js';
import type { createHomeRunSessionView } from './home-run-session-view.js';

export function createHomeRunSessionInput(
  runSession: RunSessionViewModel,
): Parameters<typeof createHomeRunSessionView>[0]['runSession'] {
  return {
    isRunStarting: runSession.isRunStarting,
    isRunning: runSession.isRunning,
    isRunSettling: runSession.isSettling,
    transcriptEntries: runSession.transcriptEntries,
    finalAnswerText: runSession.finalAnswerText,
    activeArtifact: runSession.activeArtifact,
    pendingApproval: runSession.pendingApproval,
    permissionMode: runSession.permissionMode,
    modelId: runSession.modelId,
    reasoningEffort: runSession.reasoningEffort,
    subagentModelRouting: runSession.subagentModelRouting,
    streamError: runSession.streamError,
    backgroundNotifications: runSession.backgroundNotifications,
    usageTotals: runSession.usageTotals,
    contextUsage: runSession.contextUsage,
    setPermissionMode: runSession.setPermissionMode,
    setModelId: runSession.setModelId,
    prepareProviderTransition: runSession.prepareProviderTransition,
    setReasoningEffort: runSession.setReasoningEffort,
    setSubagentModelRouting: runSession.setSubagentModelRouting,
    sendPrompt: runSession.sendPrompt,
    sendWidgetPrompt: runSession.sendWidgetPrompt,
    requestWidgetTool: runSession.requestWidgetTool,
    regeneratePrompt: runSession.regeneratePrompt,
    cancelSteer: runSession.cancelSteer,
    flushSteers: runSession.flushSteers,
    pendingSteers: runSession.pendingSteers,
    pendingSteerFlushRequested: runSession.pendingSteerFlushRequested,
    startRunRequest: runSession.startRunRequest,
    handleApprove: runSession.handleApprove,
    handleDeny: runSession.handleDeny,
    handleCancel: runSession.handleCancel,
  };
}
