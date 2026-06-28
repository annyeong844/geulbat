import { isThreadId } from '@geulbat/protocol/ids';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { RunStartRequest } from '@geulbat/protocol/run-contract';

import { readRunPromptInputRef } from '../../../daemon/sessions/prompt-input-ref-store.js';
import { readProjectWorkspaceScope } from '#web/request/project-scope.js';
import type { ProjectScopeRegistry } from '#web/request/project-scope.js';

interface NormalizedRunStartRequest {
  prompt: string;
  transcriptPrompt: string;
  projectId: NonNullable<RunStartRequest['projectId']>;
  workspaceRoot: string;
  currentFile: RunStartRequest['currentFile'];
  selection: RunStartRequest['selection'];
  requestedThreadId: RunStartRequest['threadId'];
  permissionMode: PermissionMode;
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
    projectRegistry: ProjectScopeRegistry;
  },
): Promise<RunStartRequestReadResult> {
  const projectId = request.projectId;
  if (!projectId) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'projectId is required',
    };
  }

  const projectScope = readProjectWorkspaceScope(projectId, {
    projectRegistry: args.projectRegistry,
  });
  if (!projectScope.ok) {
    return {
      ok: false,
      status: projectScope.code === 'bad_request' ? 400 : 404,
      code: projectScope.code,
      message: projectScope.message,
    };
  }

  const promptInput = await readPromptInput(request, {
    workspaceRoot: projectScope.workspaceRoot,
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

  return {
    ok: true,
    value: {
      prompt: promptInput.prompt,
      transcriptPrompt: readTranscriptPrompt(request, promptInput.prompt),
      projectId: projectScope.projectId,
      workspaceRoot: projectScope.workspaceRoot,
      currentFile: request.currentFile,
      selection: request.selection,
      requestedThreadId,
      permissionMode: request.permissionMode ?? 'basic',
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
  args: { workspaceRoot: string },
): Promise<PromptInputReadResult> {
  if ('promptRef' in request) {
    const resolved = await readRunPromptInputRef({
      workspaceRoot: args.workspaceRoot,
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
