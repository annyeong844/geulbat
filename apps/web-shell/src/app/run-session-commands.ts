import type {
  ApprovalGrantScope,
  ApprovalRequired,
  ApprovalRequest,
  PermissionMode,
} from '@geulbat/protocol/run-approval';
import type { CancelRequest } from '@geulbat/protocol/cancel';
import {
  isRunPromptInputRefResponse,
  type RunAttachmentInput,
  type RunModelId,
  type RunReasoningEffort,
  type RunRequest,
  type RunStartRequest,
  type RunSubagentModelRouting,
} from '@geulbat/protocol/run-contract';

import { getErrorMessage } from '../lib/error-message.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import { brandRunId, brandThreadId } from '../lib/id-brand-helpers.js';
import { apiFetch, isApiOkResponse } from '../lib/api/client.js';
import { deleteRunAttachmentBlob } from '../lib/api/files.js';
import { getImageGenerationModelPref } from '../features/assistant/image-model-prefs.js';
import {
  getVideoGenerationPref,
  type VideoGenerationPref,
} from '../features/assistant/video-generation-prefs.js';
import type { RunSessionPhase } from './run-session-state-types.js';

const logger = createLogger('run-session-commands');

export interface StartRunCommandClient {
  start(request: RunStartRequest): Promise<string>;
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
  prepareStartRequest?: (request: RunRequest) => Promise<RunStartRequest>;
  cleanupStartRequest?: (request: RunStartRequest) => Promise<void>;
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
  // 사용자가 명시적으로 고른 명령 시작 위치. 탐색 위치와는 독립적이다.
  workingDirectory?: string;
  modelId: RunModelId;
  selectedThreadId: string | null;
  permissionMode: PermissionMode;
  reasoningEffort: RunReasoningEffort;
  subagentModelRouting: RunSubagentModelRouting;
  // 업로드된 사용자 첨부 — 모델에 이미지/파일 입력 블록으로 전달된다
  attachments?: RunAttachmentInput[];
  // 답변 재생성 — 마지막 사용자 턴을 덮어쓴다 (threadId 필수)
  regenerate?: boolean;
  // 아티팩트 프레임 발 턴 — user metadata.origin으로 각인돼 귀속 렌더된다
  promptOrigin?: 'artifact_frame';
}

interface BuildRunStartRequestArgs {
  request: RunRequest;
  modelId: RunModelId;
  permissionMode: PermissionMode;
  subagentModelRouting: RunSubagentModelRouting;
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

// 일반 대화는 컴퓨터 탐색기의 현재 위치를 cwd로 승격하지 않는다. 사용자가
// 별도로 고른 시작 위치만 RunRequest.workingDirectory로 전달한다.
export function buildPromptRunRequest({
  prompt,
  workingDirectory,
  modelId,
  selectedThreadId,
  permissionMode,
  reasoningEffort,
  subagentModelRouting,
  attachments,
  regenerate,
  promptOrigin,
}: BuildPromptRunRequestArgs): RunRequest {
  const imageGenerationModel = getImageGenerationModelPref();
  const videoGenerationPref = getVideoGenerationPref();
  return {
    prompt,
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    modelId,
    permissionMode,
    reasoningEffort,
    subagentModelRouting,
    ...(selectedThreadId ? { threadId: brandThreadId(selectedThreadId) } : {}),
    ...(attachments !== undefined && attachments.length > 0
      ? { attachments }
      : {}),
    ...(regenerate === true ? { regenerate: true } : {}),
    ...(promptOrigin !== undefined ? { promptOrigin } : {}),
    // 기본 이미지 모델 선택 — 미연결이어도 그대로 싣는다(생략=조용한 타사
    // 폴백이므로 금지, §4.2). 판정과 오류는 데몬이 낸다.
    ...(imageGenerationModel !== null ? { imageGenerationModel } : {}),
    // 동영상 설정도 동일 규범(video-generation-open §4.3)
    ...(videoGenerationPref !== null
      ? {
          videoGenerationModel: videoGenerationPref.model,
          ...buildVideoGenerationSettingsField(videoGenerationPref),
        }
      : {}),
  };
}

// pref의 상세 옵션(길이·화면비·해상도)을 RunRequest.videoGenerationSettings
// 로 조립한다 — 아무것도 없으면 필드 자체를 만들지 않는다.
function buildVideoGenerationSettingsField(
  pref: VideoGenerationPref,
): Pick<RunRequest, 'videoGenerationSettings'> | Record<string, never> {
  const settings = {
    ...(pref.durationSeconds !== undefined
      ? { durationSeconds: pref.durationSeconds }
      : {}),
    ...(pref.aspectRatio !== undefined
      ? { aspectRatio: pref.aspectRatio }
      : {}),
    ...(pref.resolution !== undefined ? { resolution: pref.resolution } : {}),
  };
  return Object.keys(settings).length > 0
    ? { videoGenerationSettings: settings }
    : {};
}

export function buildRunStartRequest({
  request,
  modelId,
  permissionMode,
  subagentModelRouting,
}: BuildRunStartRequestArgs): RunRequest {
  const imageGenerationModel =
    request.imageGenerationModel ?? getImageGenerationModelPref();
  const videoGenerationPref = getVideoGenerationPref();
  const videoGenerationModel =
    request.videoGenerationModel ?? videoGenerationPref?.model;
  const videoGenerationSettings =
    request.videoGenerationSettings ??
    (videoGenerationPref !== null
      ? buildVideoGenerationSettingsField(videoGenerationPref)
          .videoGenerationSettings
      : undefined);
  return {
    ...request,
    modelId: request.modelId ?? modelId,
    permissionMode: request.permissionMode ?? permissionMode,
    subagentModelRouting: request.subagentModelRouting ?? subagentModelRouting,
    ...(imageGenerationModel !== null && imageGenerationModel !== undefined
      ? { imageGenerationModel }
      : {}),
    ...(videoGenerationModel !== undefined ? { videoGenerationModel } : {}),
    ...(videoGenerationSettings !== undefined
      ? { videoGenerationSettings }
      : {}),
  };
}

export async function prepareRunStartRequest(
  request: RunRequest,
): Promise<RunStartRequest> {
  const promptInput = await apiFetch(
    '/api/run/prompt-inputs',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: request.prompt,
    },
    isRunPromptInputRefResponse,
  );
  return {
    ...(request.displayPrompt !== undefined
      ? { displayPrompt: request.displayPrompt }
      : {}),
    ...(request.threadId !== undefined ? { threadId: request.threadId } : {}),
    ...(request.workingDirectory !== undefined
      ? { workingDirectory: request.workingDirectory }
      : {}),
    ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
    ...(request.currentFile !== undefined
      ? { currentFile: request.currentFile }
      : {}),
    ...(request.selection !== undefined
      ? { selection: request.selection }
      : {}),
    ...(request.allowedPublicToolNames !== undefined
      ? { allowedPublicToolNames: request.allowedPublicToolNames }
      : {}),
    ...(request.permissionMode !== undefined
      ? { permissionMode: request.permissionMode }
      : {}),
    ...(request.reasoningEffort !== undefined
      ? { reasoningEffort: request.reasoningEffort }
      : {}),
    ...(request.subagentModelRouting !== undefined
      ? { subagentModelRouting: request.subagentModelRouting }
      : {}),
    ...(request.attachments !== undefined
      ? { attachments: request.attachments }
      : {}),
    ...(request.regenerate !== undefined
      ? { regenerate: request.regenerate }
      : {}),
    ...(request.imageGenerationModel !== undefined
      ? { imageGenerationModel: request.imageGenerationModel }
      : {}),
    // 동영상 모델·설정(video-generation-open §4.3) — 화이트리스트 누락 시
    // prefs가 조용히 탈락하는 함정이 있어 S1에서 미리 등록해 둔다
    ...(request.videoGenerationModel !== undefined
      ? { videoGenerationModel: request.videoGenerationModel }
      : {}),
    ...(request.videoGenerationSettings !== undefined
      ? { videoGenerationSettings: request.videoGenerationSettings }
      : {}),
    promptRef: promptInput.promptRef,
  };
}

// 전송이 실패하면 업로드해 둔 ref들(프롬프트·첨부 blob)은 소비될 길이
// 없다 — 여기서 지워 데몬 디스크에 고아로 남지 않게 한다.
async function cleanupRunStartRequest(request: RunStartRequest): Promise<void> {
  const cleanups: Promise<unknown>[] = [];
  if ('promptRef' in request) {
    cleanups.push(
      apiFetch(
        `/api/run/prompt-inputs?promptRef=${encodeURIComponent(request.promptRef)}`,
        { method: 'DELETE' },
        isApiOkResponse,
      ),
    );
  }
  for (const attachment of request.attachments ?? []) {
    cleanups.push(deleteRunAttachmentBlob(attachment.contentRef));
  }
  const results = await Promise.allSettled(cleanups);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected) {
    throw rejected.reason;
  }
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
  prepareStartRequest = prepareRunStartRequest,
  cleanupStartRequest = cleanupRunStartRequest,
}: StartRunRequestCommandArgs): Promise<StartRunRequestCommandResult> {
  try {
    const preparedRequest = await prepareStartRequest(request);
    try {
      await client.start(preparedRequest);
    } catch (err: unknown) {
      try {
        await cleanupStartRequest(preparedRequest);
      } catch (cleanupError: unknown) {
        logger.warn('failed to delete uploaded run prompt ref after failure:', {
          originalError: getErrorMessage(err),
          cleanupError: getErrorMessage(cleanupError),
        });
      }
      return {
        kind: 'failed',
        message: getErrorMessage(err),
      };
    }
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
