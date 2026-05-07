import { isThreadId } from '@geulbat/protocol/ids';
import type { PermissionMode } from '@geulbat/protocol/run-approval';
import type { RunRequest } from '@geulbat/protocol/run-contract';

import { readProjectWorkspaceScope } from '#web/request/project-scope.js';
import type { ProjectScopeRegistry } from '#web/request/project-scope.js';

interface NormalizedRunStartRequest {
  prompt: string;
  transcriptPrompt: string;
  projectId: NonNullable<RunRequest['projectId']>;
  workspaceRoot: string;
  currentFile: RunRequest['currentFile'];
  selection: RunRequest['selection'];
  requestedThreadId: RunRequest['threadId'];
  permissionMode: PermissionMode;
}

type RunStartRequestReadResult =
  | { ok: true; value: NormalizedRunStartRequest }
  | {
      ok: false;
      status: 400 | 404;
      code: 'bad_request' | 'not_found';
      message: string;
    };

export function readRunStartRequest(
  request: RunRequest,
  args: {
    projectRegistry: ProjectScopeRegistry;
  },
): RunStartRequestReadResult {
  const prompt = request.prompt;
  if (!prompt || !prompt.trim()) {
    return {
      ok: false,
      status: 400,
      code: 'bad_request',
      message: 'prompt is required',
    };
  }

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
      prompt,
      transcriptPrompt: readTranscriptPrompt(request),
      projectId: projectScope.projectId,
      workspaceRoot: projectScope.workspaceRoot,
      currentFile: request.currentFile,
      selection: request.selection,
      requestedThreadId,
      permissionMode: request.permissionMode ?? 'basic',
    },
  };
}

function readTranscriptPrompt(request: RunRequest): string {
  return typeof request.displayPrompt === 'string' &&
    request.displayPrompt.trim()
    ? request.displayPrompt.trim()
    : request.prompt;
}
