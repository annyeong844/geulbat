import WebSocket from 'ws';
import { tryDecodeJson } from '@geulbat/protocol/runtime-utils';
import type { RunRequest } from '@geulbat/protocol/run-contract';
import type { RunChannelClientMessage } from '@geulbat/protocol/run-channel';

import { closeUnauthorized, sendError } from './run-channel-socket.js';
import type { RunChannelRuntimeContext } from './run-channel-runtime-context.js';
import { handleRunAuth } from './run-channel-auth.js';
import { handleRunApprove, handleRunCancel } from './run-channel-control.js';
import { getSocketState } from './run-channel-socket-runtime.js';
import { claimSocketRunStart } from './run-channel-start-gate.js';
import { normalizeAllowedToolNames } from './run-request-tools.js';
import { executeRunRequest } from './run-channel-start.js';
import { readRunChannelClientMessage } from './validate-run-channel-message.js';
import { createLogger, type LoggerContext } from '@geulbat/shared-utils/logger';
import { getErrorMessage } from '../../../daemon/utils/error.js';

const logger = createLogger('run-channel/dispatch');

export async function handleClientMessage(
  socket: WebSocket,
  raw: string,
  runtimeContext: RunChannelRuntimeContext,
): Promise<void> {
  const decoded = tryDecodeJson(raw, (value) => value);
  if (!decoded.ok) {
    sendError(socket, undefined, 400, 'bad_request', 'invalid websocket JSON');
    return;
  }
  const parsedMessage = readRunChannelClientMessage(decoded.value, {
    projectRegistry: runtimeContext.projectRegistry,
  });
  if (!parsedMessage.ok) {
    sendError(socket, undefined, 400, 'bad_request', parsedMessage.message);
    return;
  }
  const message = parsedMessage.message;
  const requestId = message.requestId;

  const socketState = getSocketState(socket);

  try {
    if (message.type === 'run.auth') {
      handleRunAuth(socket, requestId, message.token);
      return;
    }

    if (!socketState.authenticated) {
      closeUnauthorized(socket, requestId, 'websocket authentication required');
      return;
    }

    switch (message.type) {
      case 'run.start':
        await dispatchRunStart({
          socket,
          requestId,
          request: message.request,
          runtimeContext,
          socketState,
        });
        return;
      case 'run.cancel':
        handleRunCancel(socket, requestId, message.request, runtimeContext);
        return;
      case 'run.approve':
        handleRunApprove(socket, requestId, message.request, runtimeContext);
        return;
    }

    return assertNever(message);
  } catch (error: unknown) {
    logger
      .withContext(buildDispatchLogContext(message))
      .error('unexpected websocket message dispatch error:', {
        message: getErrorMessage(error),
      });
    sendError(socket, requestId, 500, 'internal', 'internal server error');
  }
}

function buildDispatchLogContext(
  message: RunChannelClientMessage,
): LoggerContext {
  switch (message.type) {
    case 'run.auth':
      return {
        messageType: message.type,
        requestId: message.requestId,
      };
    case 'run.start':
      return {
        messageType: message.type,
        projectId: message.request.projectId,
        requestId: message.requestId,
        threadId: message.request.threadId,
      };
    case 'run.cancel':
      return {
        messageType: message.type,
        requestId: message.requestId,
        runId: message.request.runId,
      };
    case 'run.approve':
      return {
        callId: message.request.callId,
        messageType: message.type,
        requestId: message.requestId,
        runId: message.request.runId,
        threadId: message.request.threadId,
      };
  }
}

async function dispatchRunStart(args: {
  socket: WebSocket;
  requestId: string;
  request: RunRequest;
  runtimeContext: RunChannelRuntimeContext;
  socketState: ReturnType<typeof getSocketState>;
}): Promise<void> {
  const { socket, requestId, request, runtimeContext, socketState } = args;
  const allowedToolNames = normalizeAllowedToolNames(request);
  const startClaim = claimSocketRunStart(socketState, requestId);
  if (!startClaim.ok) {
    sendError(
      socket,
      requestId,
      startClaim.status,
      startClaim.code,
      startClaim.message,
    );
    return;
  }

  try {
    await executeRunRequest({
      socket,
      requestId,
      request,
      allowedToolNames,
      runtimeContext,
    });
  } catch (error: unknown) {
    logger
      .withContext({
        messageType: 'run.start',
        projectId: request.projectId,
        requestId,
        threadId: request.threadId,
      })
      .error('unexpected run.start dispatch error:', {
        message: getErrorMessage(error),
      });
    sendError(socket, requestId, 500, 'internal', 'internal server error');
  } finally {
    startClaim.release();
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported message type: ${JSON.stringify(value)}`);
}
