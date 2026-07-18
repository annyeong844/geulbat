import { stat } from 'node:fs/promises';

import { isThreadId } from '@geulbat/protocol/ids';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { RunStartRequest } from '@geulbat/protocol/run-contract';

import { readRunPromptInputRef } from '../../../daemon/sessions/prompt-input-ref-store.js';
import type { ResolvedRunAttachment } from '../../../daemon/agent/run-attachments.js';
import {
  type ComputerFileScope,
  normalizeComputerBrowseRelativePath,
} from '../../../daemon/files/computer-file-scope.js';
import { FileAccessError } from '../../../daemon/files/file-domain-error.js';
import { resolveSourceDirectoryTarget } from '../../../daemon/files/file-platform.js';
import {
  normalizePath,
  PathEscapeError,
} from '../../../daemon/files/normalize-path.js';
import { resolveRunAttachments } from './run-attachment-input.js';

interface NormalizedRunStartRequest {
  prompt: string;
  transcriptPrompt: string;
  workingDirectory: string;
  modelId: RunStartRequest['modelId'];
  currentFile: RunStartRequest['currentFile'];
  selection: RunStartRequest['selection'];
  requestedThreadId: RunStartRequest['threadId'];
  permissionMode: PermissionMode;
  reasoningEffort: RunStartRequest['reasoningEffort'];
  subagentModelRouting?: RunStartRequest['subagentModelRouting'];
  attachments: ResolvedRunAttachment[];
  regenerate: boolean;
  silentPrompt: boolean;
  promptOrigin: RunStartRequest['promptOrigin'];
  imageGenerationModel: RunStartRequest['imageGenerationModel'];
  videoGenerationModel: RunStartRequest['videoGenerationModel'];
  videoGenerationSettings: RunStartRequest['videoGenerationSettings'];
  promptRef?: { promptRef: string; path: string };
}

type RunStartRequestReadResult =
  | { ok: true; value: NormalizedRunStartRequest }
  | {
      ok: false;
      status: 400 | 404 | 409;
      code: 'bad_request' | 'conflict' | 'not_found';
      message: string;
    };

export async function readRunStartRequest(
  request: RunStartRequest,
  args: {
    homeStateRoot: string;
    computerFileScope?: ComputerFileScope;
  },
): Promise<RunStartRequestReadResult> {
  if (args.computerFileScope === undefined) {
    return {
      ok: false,
      status: 404,
      code: 'not_found',
      message: 'computer file root is unavailable',
    };
  }

  const workingDirectory = await readWorkingDirectory(request, {
    computerFileScope: args.computerFileScope,
  });
  if (!workingDirectory.ok) {
    return workingDirectory;
  }

  const currentFile = readCurrentFile(request.currentFile, {
    computerFileScope: args.computerFileScope,
  });
  if (!currentFile.ok) {
    return currentFile;
  }

  const promptInput = await readPromptInput(request, {
    stateRoot: args.homeStateRoot,
  });
  if (!promptInput.ok) {
    return promptInput;
  }

  const requestedThreadId = request.threadId;
  if (requestedThreadId && !isThreadId(requestedThreadId)) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'invalid threadId',
    };
  }

  const attachments = await resolveRunAttachments(request.attachments, {
    workspaceRoot: args.computerFileScope.root,
  });
  if (!attachments.ok) {
    return attachments;
  }

  // 재생성은 기존 스레드의 마지막 턴을 대체한다 — 대상 스레드가 필수.
  const regenerate = request.regenerate === true;
  if (regenerate && !requestedThreadId) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'regenerate requires threadId',
    };
  }

  return {
    ok: true,
    value: {
      prompt: promptInput.prompt,
      transcriptPrompt: readTranscriptPrompt(request, promptInput.prompt),
      workingDirectory: workingDirectory.workingDirectory,
      modelId: request.modelId,
      currentFile: currentFile.value,
      selection: request.selection,
      requestedThreadId,
      permissionMode: request.permissionMode ?? 'basic',
      reasoningEffort: request.reasoningEffort,
      ...(request.subagentModelRouting === undefined
        ? {}
        : { subagentModelRouting: request.subagentModelRouting }),
      attachments: attachments.attachments,
      regenerate,
      silentPrompt: request.silentPrompt === true,
      promptOrigin: request.promptOrigin,
      imageGenerationModel: request.imageGenerationModel,
      videoGenerationModel: request.videoGenerationModel,
      videoGenerationSettings: request.videoGenerationSettings,
      ...(promptInput.kind === 'ref'
        ? {
            promptRef: {
              promptRef: promptInput.promptRef,
              path: promptInput.path,
            },
          }
        : {}),
    },
  };
}

function readCurrentFile(
  value: RunStartRequest['currentFile'],
  args: { computerFileScope: ComputerFileScope },
):
  | { ok: true; value: RunStartRequest['currentFile'] }
  | {
      ok: false;
      status: 400;
      code: 'bad_request';
      message: string;
    } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  const portablePath = normalizeComputerBrowseRelativePath(value);
  if (portablePath === undefined || portablePath.trim() === '') {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'invalid currentFile',
    };
  }
  try {
    const normalizedPath = normalizePath(
      args.computerFileScope.root,
      portablePath,
    );
    if (normalizedPath === '') {
      return {
        ok: false,
        status: 400,
        code: 'bad_request',
        message: 'invalid currentFile',
      };
    }
    return { ok: true, value: normalizedPath };
  } catch (error: unknown) {
    if (error instanceof PathEscapeError) {
      return {
        ok: false,
        status: 400,
        code: 'bad_request',
        message: 'invalid currentFile',
      };
    }
    throw error;
  }
}

// run.start와 run.tool(artifact frame)이 같은 경계로 workingDirectory를
// 검증한다 — 포크 금지.
export async function readWorkingDirectory(
  request: Pick<RunStartRequest, 'workingDirectory'>,
  args: { computerFileScope: ComputerFileScope },
): Promise<
  | { ok: true; workingDirectory: string }
  | {
      ok: false;
      status: 400 | 404;
      code: 'bad_request' | 'not_found';
      message: string;
    }
> {
  const requestedPath =
    request.workingDirectory ?? args.computerFileScope.browseStartPath ?? '';
  try {
    const target = await resolveSourceDirectoryTarget(
      args.computerFileScope.root,
      requestedPath,
    );
    if (!target.exists) {
      return {
        ok: false,
        status: 404,
        code: 'not_found',
        message: 'working directory not found',
      };
    }
    if (!(await stat(target.canonicalAbsolutePath)).isDirectory()) {
      return {
        ok: false,
        status: 400,
        code: 'bad_request',
        message: 'workingDirectory must name a directory',
      };
    }
    return {
      ok: true,
      workingDirectory: target.relativePath,
    };
  } catch (error: unknown) {
    if (error instanceof PathEscapeError || error instanceof FileAccessError) {
      return {
        ok: false,
        status: 400,
        code: 'bad_request',
        message: 'invalid workingDirectory',
      };
    }
    throw error;
  }
}

type PromptInputReadResult =
  | { ok: true; kind: 'body'; prompt: string }
  | {
      ok: true;
      kind: 'ref';
      prompt: string;
      promptRef: string;
      path: string;
    }
  | {
      ok: false;
      status: 400 | 404 | 409;
      code: 'bad_request' | 'conflict' | 'not_found';
      message: string;
    };

async function readPromptInput(
  request: RunStartRequest,
  args: { stateRoot: string },
): Promise<PromptInputReadResult> {
  if ('promptRef' in request) {
    const resolved = await readRunPromptInputRef({
      workspaceRoot: args.stateRoot,
      promptRef: request.promptRef,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        status:
          resolved.code === 'bad_request'
            ? 400
            : resolved.code === 'conflict'
              ? 409
              : 404,
        code: resolved.code,
        message: resolved.message,
      };
    }
    if (!resolved.prompt.trim()) {
      return {
        ok: false,
        status: 400,
        code: 'bad_request',
        message: 'prompt is required',
      };
    }
    return {
      ok: true,
      kind: 'ref',
      prompt: resolved.prompt,
      promptRef: request.promptRef,
      path: resolved.path,
    };
  }

  const prompt = request.prompt;
  if (!prompt || !prompt.trim()) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'prompt is required',
    };
  }
  return { ok: true, kind: 'body', prompt };
}

function readTranscriptPrompt(
  request: RunStartRequest,
  prompt: string,
): string {
  return typeof request.displayPrompt === 'string' &&
    request.displayPrompt.trim()
    ? request.displayPrompt.trim()
    : prompt;
}
