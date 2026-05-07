import type {
  ApprovalGrantScope,
  ApprovalRequired,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';
import type { ThreadMessage } from '@geulbat/protocol/threads';

import type { RunTranscriptEntry } from '../lib/run-transcript-entry.js';

const PROJECT_SWITCH_HELPER_TEXT =
  'Finish or cancel the current run before switching projects.';
const PROJECT_MANAGEMENT_HELPER_TEXT =
  'Finish or cancel the current run before managing projects.';

interface ProjectWorkspaceAssistantView {
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  backgroundNotifications: Extract<
    RunTranscriptEntry,
    { kind: 'subagent_activity' }
  >[];
  transcriptEntries: RunTranscriptEntry[];
  finalAnswerText: string;
  activeArtifact: ThreadArtifactVersion | null;
  streamError: string | null;
  isRunning: boolean;
  isSettling?: boolean;
  onOpenSource: (path: string) => Promise<void>;
  onSend: (prompt: string) => Promise<void>;
  onStartArtifactRun: (
    request: RunRequest,
    optimisticPrompt?: string,
  ) => Promise<void>;
  onCancel: () => Promise<void>;
}

interface ProjectWorkspaceApprovalPanelView {
  pending: ApprovalRequired | null;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onApprove: (
    pending: ApprovalRequired,
    grantScope?: ApprovalGrantScope,
  ) => Promise<void>;
  onDeny: (pending: ApprovalRequired) => Promise<void>;
}

interface ProjectWorkspaceRunSessionInput {
  isRunStarting: boolean;
  isRunning: boolean;
  isRunSettling?: boolean;
  transcriptEntries: RunTranscriptEntry[];
  finalAnswerText: string;
  activeArtifact: ThreadArtifactVersion | null;
  pendingApproval: ApprovalRequired | null;
  permissionMode: PermissionMode;
  streamError: string | null;
  backgroundNotifications: Extract<
    RunTranscriptEntry,
    { kind: 'subagent_activity' }
  >[];
  setPermissionMode: (mode: PermissionMode) => void;
  sendPrompt: (prompt: string) => Promise<void>;
  startRunRequest: (
    request: RunRequest,
    optimisticPrompt?: string,
  ) => Promise<void>;
  handleApprove: (
    pending: ApprovalRequired,
    grantScope?: ApprovalGrantScope,
  ) => Promise<void>;
  handleDeny: (pending: ApprovalRequired) => Promise<void>;
  handleCancel: () => Promise<void>;
}

interface ProjectWorkspaceRunSessionView {
  isProjectSwitchBlocked: boolean;
  projectSelectorHelperText: string | null;
  projectRegistryHelperText: string | null;
  assistant: ProjectWorkspaceAssistantView;
  approvalPanel: ProjectWorkspaceApprovalPanelView;
}

interface CreateProjectWorkspaceRunSessionViewArgs {
  messages: ThreadMessage[];
  artifacts: ThreadArtifactVersion[];
  openFile: (path: string) => Promise<void>;
  runSession: ProjectWorkspaceRunSessionInput;
}

export function createProjectWorkspaceRunSessionView({
  messages,
  artifacts,
  openFile,
  runSession,
}: CreateProjectWorkspaceRunSessionViewArgs): ProjectWorkspaceRunSessionView {
  const isRunSettling = runSession.isRunSettling ?? false;
  const isProjectSwitchBlocked =
    runSession.isRunStarting || runSession.isRunning || isRunSettling;

  return {
    isProjectSwitchBlocked,
    projectSelectorHelperText: isProjectSwitchBlocked
      ? PROJECT_SWITCH_HELPER_TEXT
      : null,
    projectRegistryHelperText: isProjectSwitchBlocked
      ? PROJECT_MANAGEMENT_HELPER_TEXT
      : null,
    assistant: {
      messages,
      artifacts,
      backgroundNotifications: runSession.backgroundNotifications,
      transcriptEntries: runSession.transcriptEntries,
      finalAnswerText: runSession.finalAnswerText,
      activeArtifact: runSession.activeArtifact,
      streamError: runSession.streamError,
      isRunning: runSession.isRunning,
      isSettling: isRunSettling,
      onOpenSource: openFile,
      onSend: runSession.sendPrompt,
      onStartArtifactRun: runSession.startRunRequest,
      onCancel: runSession.handleCancel,
    },
    approvalPanel: {
      pending: runSession.pendingApproval,
      permissionMode: runSession.permissionMode,
      onPermissionModeChange: runSession.setPermissionMode,
      onApprove: runSession.handleApprove,
      onDeny: runSession.handleDeny,
    },
  };
}
