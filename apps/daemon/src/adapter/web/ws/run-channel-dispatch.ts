import type WebSocket from 'ws';
import { tryDecodeJson } from '../../../daemon/runtime-json.js';
import type { RunChannelClientMessage } from '@geulbat/protocol/run-channel';

import {
  closeUnauthorized,
  sendError,
  sendMessage,
} from './run-channel-socket.js';
import type { RunChannelRuntimeContext } from './run-channel-runtime-context.js';
import {
  abortRunSocketAuthentication,
  authenticateRunSocket,
  completeRunSocketAuthentication,
} from './run-channel-auth.js';
import {
  handleRunApprove,
  handleRunCancel,
  handleRunChildCancel,
  handleRunInterject,
  handleRunInterjectCancel,
  handleRunInterjectFlush,
  handleRunProviderRequestRecovery,
} from './run-channel-control.js';
import { handleRunTool } from './run-channel-tool.js';
import {
  bindSocketRuns,
  ensureThreadBackgroundSubscription,
  getSocketState,
} from './run-channel-socket-runtime.js';
import {
  dispatchRunStart,
  recoverDurableRunsForSocket,
} from './run-channel-start.js';
import {
  handleGoalCommand,
  handlePlanWorkflowCommand,
  synchronizeRunWorkflowState,
} from './run-channel-workflow.js';
import { readRunChannelClientMessage } from './validate-run-channel-message.js';
import {
  createLogger,
  type LoggerContext,
} from '@geulbat/structured-logger/logger';
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
      if (!authenticateRunSocket(socket, requestId, message.token)) {
        return;
      }
      try {
        socketState.computerSessionId = runtimeContext.computerSessionId;
        await recoverDurableRunsForSocket(
          socket,
          runtimeContext,
          message.runEventCursors,
        );
        await bindSocketRuns(socket, runtimeContext, message.runEventCursors);
        for (const threadId of message.threadSubscriptions ?? []) {
          ensureThreadBackgroundSubscription(socket, threadId, runtimeContext);
        }
        if (!completeRunSocketAuthentication(socket)) {
          return;
        }
        sendMessage(socket, {
          type: 'run.auth.ok',
          requestId,
          ok: true,
          computerSessionId: runtimeContext.computerSessionId,
        });
        for (const threadId of message.threadSubscriptions ?? []) {
          await synchronizeRunWorkflowState(
            socket,
            `${requestId}:resume-plan:${threadId}`,
            threadId,
            runtimeContext,
          );
        }
      } catch (error: unknown) {
        abortRunSocketAuthentication(socket);
        throw error;
      }
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
      case 'run.child.cancel':
        handleRunChildCancel(
          socket,
          requestId,
          message.request,
          runtimeContext,
        );
        return;
      case 'run.thread.subscribe':
        ensureThreadBackgroundSubscription(
          socket,
          message.request.threadId,
          runtimeContext,
        );
        await synchronizeRunWorkflowState(
          socket,
          `${requestId}:resume-plan`,
          message.request.threadId,
          runtimeContext,
        );
        return;
      case 'plan.command':
        await handlePlanWorkflowCommand(
          socket,
          requestId,
          message.request,
          runtimeContext,
        );
        return;
      case 'goal.command':
        await handleGoalCommand(
          socket,
          requestId,
          message.request,
          runtimeContext,
        );
        return;
      case 'run.approve':
        await handleRunApprove(
          socket,
          requestId,
          message.request,
          runtimeContext,
        );
        return;
      case 'run.provider_request.recover':
        await handleRunProviderRequestRecovery(
          socket,
          requestId,
          message.request,
          runtimeContext,
          socketState.computerSessionId,
        );
        return;
      case 'run.interject':
        await handleRunInterject(
          socket,
          requestId,
          message.request,
          runtimeContext,
        );
        return;
      case 'run.interject.cancel':
        await handleRunInterjectCancel(
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
      case 'run.event.ack': {
        const acknowledged =
          await runtimeContext.runCheckpoints.acknowledgeTerminalEvent({
            threadId: message.request.threadId,
            runId: message.request.runId,
            eventCursor: message.request.seq,
          });
        if (!acknowledged.ok) {
          const notFound = acknowledged.code === 'not_found';
          sendError(
            socket,
            requestId,
            notFound ? 404 : 409,
            notFound ? 'not_found' : 'conflict',
            `run event acknowledgement rejected: ${acknowledged.code}`,
          );
          return;
        }
        sendMessage(socket, {
          type: 'run.control',
          requestId,
          action: 'run.event.ack',
          ok: true,
          seq: message.request.seq,
        });
        return;
      }
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
    case 'run.child.cancel':
      return {
        messageType: message.type,
        requestId: message.requestId,
        runId: message.request.childRunId,
      };
    case 'run.thread.subscribe':
      return {
        messageType: message.type,
        requestId: message.requestId,
        threadId: message.request.threadId,
      };
    case 'plan.command':
      return {
        messageType: message.type,
        requestId: message.requestId,
        threadId: message.request.threadId,
      };
    case 'goal.command':
      return {
        messageType: message.type,
        requestId: message.requestId,
        threadId: message.request.threadId,
      };
    case 'run.approve':
      return {
        callId: message.request.callId,
        messageType: message.type,
        requestId: message.requestId,
        runId: message.request.runId,
        threadId: message.request.threadId,
      };
    case 'run.provider_request.recover':
      return {
        messageType: message.type,
        requestId: message.requestId,
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
    case 'run.event.ack':
      return {
        messageType: message.type,
        requestId: message.requestId,
        runId: message.request.runId,
        threadId: message.request.threadId,
      };
    case 'run.tool':
      return {
        messageType: message.type,
        requestId: message.requestId,
      };
  }

  return assertNever(message);
}

function assertNever(value: never): never {
  throw new Error(`unsupported message type: ${JSON.stringify(value)}`);
}
