import type WebSocket from 'ws';
import { tryDecodeJson } from '@geulbat/protocol/runtime-utils';
import type { RunStartRequest } from '@geulbat/protocol/run-contract';
import type { RunChannelClientMessage } from '@geulbat/protocol/run-channel';

import { closeUnauthorized, sendError } from './run-channel-socket.js';
import type { RunChannelRuntimeContext } from './run-channel-runtime-context.js';
import { handleRunAuth } from './run-channel-auth.js';
import {
  handleRunApprove,
  handleRunCancel,
  handleRunInterject,
  handleRunInterjectCancel,
  handleRunInterjectFlush,
} from './run-channel-control.js';
import { handleRunTool } from './run-channel-tool.js';
import { getSocketState } from './run-channel-socket-runtime.js';
import { claimSocketRunStart } from './run-channel-start-gate.js';
import { normalizeAllowedPublicToolNames } from './run-request-tools.js';
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
  const parsedMessage = readRunChannelClientMessage(decoded.value);
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
      case 'run.interject':
        handleRunInterject(socket, requestId, message.request, runtimeContext);
        return;
      case 'run.interject.cancel':
        handleRunInterjectCancel(
          socket,
          requestId,
          message.request,
          runtimeContext,
        );
        return;
      case 'run.interject.flush':
        handleRunInterjectFlush(
          socket,
          requestId,
          message.request,
          runtimeContext,
        );
        return;
      case 'run.tool':
        await handleRunTool(socket, requestId, message.request, runtimeContext);
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
    case 'run.interject':
      return {
        messageType: message.type,
        requestId: message.requestId,
      };
    case 'run.interject.cancel':
      return {
        messageType: message.type,
        requestId: message.requestId,
      };
    case 'run.interject.flush':
      return {
        messageType: message.type,
        requestId: message.requestId,
      };
    case 'run.tool':
      return {
        messageType: message.type,
        requestId: message.requestId,
      };
  }
}

async function dispatchRunStart(args: {
  socket: WebSocket;
  requestId: string;
  request: RunStartRequest;
  runtimeContext: RunChannelRuntimeContext;
  socketState: ReturnType<typeof getSocketState>;
}): Promise<void> {
  const { socket, requestId, request, runtimeContext, socketState } = args;
  const allowedPublicToolNames = normalizeAllowedPublicToolNames(request);
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
      allowedPublicToolNames,
      runtimeContext,
    });
  } catch (error: unknown) {
    logger
      .withContext({
        messageType: 'run.start',
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
