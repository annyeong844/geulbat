import type { RunChannelClientMessage } from '@geulbat/protocol/run-channel';
import {
  isRunApproveMessage,
  isRunAuthMessage,
  isRunCancelMessage,
  isRunStartMessage,
} from '@geulbat/protocol/run-channel';
import {
  readProjectWorkspaceScope,
  type ProjectScopeRegistry,
} from '#web/request/project-scope.js';

type RunChannelClientMessageReadResult =
  | { ok: true; message: RunChannelClientMessage }
  | { ok: false; message: string };

export function readRunChannelClientMessage(
  value: unknown,
  args: {
    projectRegistry: ProjectScopeRegistry;
  },
): RunChannelClientMessageReadResult {
  if (isRunAuthMessage(value)) {
    return readClientMessageWithRequestId(value);
  }
  if (isRunCancelMessage(value)) {
    return readClientMessageWithRequestId(value);
  }
  if (isRunApproveMessage(value)) {
    return readClientMessageWithRequestId(value);
  }
  if (
    isRunStartMessage(value) &&
    readProjectWorkspaceScope(value.request.projectId, {
      projectRegistry: args.projectRegistry,
    }).ok
  ) {
    return readClientMessageWithRequestId(value);
  }
  return { ok: false, message: 'invalid websocket JSON' };
}

function readClientMessageWithRequestId(
  message: RunChannelClientMessage,
): RunChannelClientMessageReadResult {
  if (!message.requestId.trim()) {
    return { ok: false, message: 'requestId is required' };
  }
  return { ok: true, message };
}
