import type {
  ApprovalGrantScope,
  ApprovalRequired,
  ApprovalRequest,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { getErrorMessage } from '@geulbat/shared-utils/error';
import {
  brandProjectId,
  brandRunId,
  brandThreadId,
} from '../lib/id-brand-helpers.js';
import type { RunSessionPhase } from './run-session-state-types.js';

export interface StartRunCommandClient {
  start(request: RunRequest): Promise<string>;
}

export interface ApprovalDecisionClient {
  approve(request: ApprovalRequest): Promise<string>;
}

export interface CancelRunSessionClient {
  cancel(request: CancelRequest): Promise<string>;
  close(): void;
  connect(): Promise<unknown>;
}

interface StartRunRequestCommandArgs {
  client: StartRunCommandClient;
  request: RunRequest;
}

interface SubmitApprovalDecisionArgs {
  client: ApprovalDecisionClient;
  pending: ApprovalRequired;
  approved: boolean;
  grantScope: ApprovalGrantScope;
}

interface CancelRunSessionArgs {
  client: CancelRunSessionClient;
  activeRunId: string | null;
  phase: RunSessionPhase;
}

interface BuildPromptRunRequestArgs {
  prompt: string;
  projectId: string;
  selectedThreadId: string | null;
  selectedFile: string | null;
  permissionMode: PermissionMode;
}

interface BuildRunStartRequestArgs {
  request: RunRequest;
  permissionMode: PermissionMode;
}

interface BuildApprovalDecisionRequestArgs {
  pending: ApprovalRequired;
  approved: boolean;
  grantScope: ApprovalGrantScope;
}

type StartRunRequestCommandResult =
  | {
      kind: 'started';
      threadId: RunRequest['threadId'] | null;
    }
  | {
      kind: 'failed';
      message: string;
    };

type SubmitApprovalDecisionResult =
  | { kind: 'approved' }
  | { kind: 'denied' }
  | {
      kind: 'failed';
      message: string;
    };

type CancelRunSessionResult =
  | { kind: 'cancel_requested' }
  | { kind: 'start_cancelled' }
  | {
      kind: 'cancel_failed';
      message: string;
    }
  | {
      kind: 'reconnect_failed';
      message: string;
    }
  | { kind: 'noop' };

export function buildPromptRunRequest({
  prompt,
  projectId,
  selectedThreadId,
  selectedFile,
  permissionMode,
}: BuildPromptRunRequestArgs): RunRequest {
  return {
    prompt,
    projectId: brandProjectId(projectId),
    permissionMode,
    ...(selectedThreadId ? { threadId: brandThreadId(selectedThreadId) } : {}),
    ...(selectedFile ? { currentFile: selectedFile } : {}),
  };
}

export function buildRunStartRequest({
  request,
  permissionMode,
}: BuildRunStartRequestArgs): RunRequest {
  return {
    ...request,
    permissionMode: request.permissionMode ?? permissionMode,
  };
}

export function resolveOptimisticRunPrompt(
  request: RunRequest,
  optimisticPrompt?: string,
): string {
  return request.displayPrompt ?? optimisticPrompt ?? request.prompt;
}

export function buildApprovalDecisionRequest({
  pending,
  approved,
  grantScope,
}: BuildApprovalDecisionRequestArgs): ApprovalRequest {
  return {
    callId: pending.callId,
    runId: pending.runId,
    threadId: pending.threadId,
    approved,
    grantScope,
  };
}

export async function startRunRequestCommand({
  client,
  request,
}: StartRunRequestCommandArgs): Promise<StartRunRequestCommandResult> {
  try {
    await client.start(request);
    return {
      kind: 'started',
      threadId: request.threadId ?? null,
    };
  } catch (err: unknown) {
    return {
      kind: 'failed',
      message: getErrorMessage(err),
    };
  }
}

export async function submitApprovalDecision({
  client,
  pending,
  approved,
  grantScope,
}: SubmitApprovalDecisionArgs): Promise<SubmitApprovalDecisionResult> {
  try {
    await client.approve(
      buildApprovalDecisionRequest({
        pending,
        approved,
        grantScope,
      }),
    );
    return approved ? { kind: 'approved' } : { kind: 'denied' };
  } catch (err: unknown) {
    return {
      kind: 'failed',
      message: getErrorMessage(err),
    };
  }
}

export async function cancelRunSession({
  client,
  activeRunId,
  phase,
}: CancelRunSessionArgs): Promise<CancelRunSessionResult> {
  if (activeRunId) {
    try {
      await client.cancel({ runId: brandRunId(activeRunId) });
      return { kind: 'cancel_requested' };
    } catch (err: unknown) {
      return {
        kind: 'cancel_failed',
        message: getErrorMessage(err),
      };
    }
  }

  if (phase === 'starting') {
    client.close();
    try {
      await client.connect();
      return { kind: 'start_cancelled' };
    } catch (err: unknown) {
      return {
        kind: 'reconnect_failed',
        message: getErrorMessage(err),
      };
    }
  }

  return { kind: 'noop' };
}
