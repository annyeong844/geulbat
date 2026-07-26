import type WebSocket from 'ws';
import { tryDecodeJson } from '../../../daemon/runtime-json.js';
import type { RunStartRequest } from '@geulbat/protocol/run-contract';
import type { RunChannelClientMessage } from '@geulbat/protocol/run-channel';
import type { PlanWorkflowCommand } from '@geulbat/protocol/planning-workflow';
import type { GoalCommand } from '@geulbat/protocol/goal';

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
} from './run-channel-control.js';
import { handleRunTool } from './run-channel-tool.js';
import {
  bindSocketRuns,
  ensureThreadBackgroundSubscription,
  getSocketState,
} from './run-channel-socket-runtime.js';
import { claimSocketRunStart } from './run-channel-start-gate.js';
import { normalizeAllowedPublicToolNames } from './run-request-tools.js';
import {
  executeRunRequest,
  recoverDurableRunsForSocket,
} from './run-channel-start.js';
import { readRunChannelClientMessage } from './validate-run-channel-message.js';
import {
  createLogger,
  type LoggerContext,
} from '@geulbat/structured-logger/logger';
import { getErrorMessage } from '../../../daemon/utils/error.js';
import { runDetached } from '../../../daemon/utils/run-detached.js';

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
          await sendPlanningWorkflowSnapshot(socket, threadId, runtimeContext);
          await sendGoalSnapshot(socket, threadId, runtimeContext);
          await resumePendingPlanExecution(
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
        await sendPlanningWorkflowSnapshot(
          socket,
          message.request.threadId,
          runtimeContext,
        );
        await sendGoalSnapshot(
          socket,
          message.request.threadId,
          runtimeContext,
        );
        await resumePendingPlanExecution(
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

async function sendPlanningWorkflowSnapshot(
  socket: WebSocket,
  threadId: PlanWorkflowCommand['threadId'],
  runtimeContext: RunChannelRuntimeContext,
): Promise<void> {
  sendMessage(socket, {
    type: 'plan.workflow',
    threadId,
    snapshot: await runtimeContext.planningWorkflows.readThread(threadId),
  });
}

async function sendGoalSnapshot(
  socket: WebSocket,
  threadId: GoalCommand['threadId'],
  runtimeContext: RunChannelRuntimeContext,
): Promise<void> {
  sendMessage(socket, {
    type: 'goal.state',
    threadId,
    snapshot: await runtimeContext.goals.readThread(threadId),
  });
}

async function handleGoalCommand(
  socket: WebSocket,
  requestId: string,
  command: GoalCommand,
  runtimeContext: RunChannelRuntimeContext,
): Promise<void> {
  let result;
  try {
    result = await runtimeContext.goals.applyCommand(command);
  } catch (error: unknown) {
    await sendGoalSnapshot(socket, command.threadId, runtimeContext);
    const conflict =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'conflict';
    sendError(
      socket,
      requestId,
      conflict ? 409 : 500,
      conflict ? 'conflict' : 'internal',
      getErrorMessage(error),
    );
    return;
  }
  sendMessage(socket, {
    type: 'goal.state',
    threadId: command.threadId,
    snapshot: result.snapshot,
  });
  sendMessage(socket, {
    type: 'run.control',
    requestId,
    action: 'goal.command',
    ok: true,
    commandKind: command.kind,
    snapshot: result.snapshot,
  });
  if (command.kind !== 'resume' || result.executionTemplate === undefined) {
    return;
  }
  const generatedRequest: RunStartRequest = {
    ...result.executionTemplate,
    prompt: 'Continue pursuing the active Goal from its durable state.',
    threadId: command.threadId,
    goalRef: { goalId: command.goalId },
    silentPrompt: true,
  };
  const generatedRequestId = `${requestId}:goal-resume`;
  runDetached(
    'run-channel/generated-goal-resume',
    () =>
      dispatchRunStart({
        socket,
        requestId: generatedRequestId,
        request: generatedRequest,
        runtimeContext,
        socketState: getSocketState(socket),
      }),
    {
      logger: logger.withContext({
        messageType: 'goal.command',
        requestId: generatedRequestId,
        threadId: command.threadId,
      }),
    },
  );
}

async function handlePlanWorkflowCommand(
  socket: WebSocket,
  requestId: string,
  command: PlanWorkflowCommand,
  runtimeContext: RunChannelRuntimeContext,
): Promise<void> {
  let result;
  try {
    result = await runtimeContext.planningWorkflows.applyCommand(command);
  } catch (error: unknown) {
    await sendPlanningWorkflowSnapshot(
      socket,
      command.threadId,
      runtimeContext,
    );
    const conflict =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'conflict';
    sendError(
      socket,
      requestId,
      conflict ? 409 : 500,
      conflict ? 'conflict' : 'internal',
      getErrorMessage(error),
    );
    return;
  }
  sendMessage(socket, {
    type: 'plan.workflow',
    threadId: command.threadId,
    snapshot: result.snapshot,
  });
  sendMessage(socket, {
    type: 'run.control',
    requestId,
    action: 'plan.command',
    ok: true,
    commandKind: command.kind,
    snapshot: result.snapshot,
    ...(result.approvedPlanRef === undefined
      ? {}
      : { approvedPlanRef: result.approvedPlanRef }),
  });
  if (result.executionTemplate === undefined) {
    return;
  }
  const generatedRequest: RunStartRequest | undefined =
    (command.kind === 'approve' || command.kind === 'retry_execution') &&
    result.approvedPlanRef !== undefined
      ? {
          ...result.executionTemplate,
          prompt:
            command.kind === 'retry_execution'
              ? 'Resume the exact daemon-approved plan after its previous execution failed. Reuse durable progress and finish the remaining work without asking for the same approval again.'
              : 'Execute the exact daemon-approved plan revision supplied by the trusted host.',
          threadId: command.threadId,
          approvedPlanRef: result.approvedPlanRef,
          silentPrompt: true,
        }
      : command.kind === 'request_revision' && result.snapshot !== null
        ? {
            ...result.executionTemplate,
            prompt:
              command.feedback === undefined
                ? 'Revise the proposed plan using the current conversation and submit a new canonical revision.'
                : `Revise the proposed plan with this trusted host feedback, then submit a new canonical revision:\n\n${command.feedback}`,
            threadId: command.threadId,
            planModeRequested: true,
            planModeIntensity: result.snapshot.intensity,
            planModeDepth: result.snapshot.depth,
            silentPrompt: true,
          }
        : command.kind === 'explain_visual' &&
            result.snapshot?.state === 'awaiting_approval'
          ? {
              ...result.executionTemplate,
              prompt: [
                'Explain the current proposed plan visually and in searchable text.',
                'Do not alter or resubmit the proposal. End after the explanation so the same trusted approval card remains current.',
                `Rendering stamp: ${JSON.stringify({
                  workflowId: result.snapshot.workflowId,
                  planId: result.snapshot.planId,
                  revision: result.snapshot.revision,
                  digest: result.snapshot.digest,
                })}`,
                `Canonical plan: ${JSON.stringify(result.snapshot.draft)}`,
              ].join('\n\n'),
              threadId: command.threadId,
              planModeRequested: true,
              planModeIntensity: result.snapshot.intensity,
              planModeDepth: result.snapshot.depth,
              silentPrompt: true,
            }
          : undefined;
  if (generatedRequest === undefined) {
    return;
  }
  const generatedRequestId = `${requestId}:plan-${command.kind}`;
  runDetached(
    'run-channel/generated-planning-workflow',
    () =>
      dispatchRunStart({
        socket,
        requestId: generatedRequestId,
        request: generatedRequest,
        runtimeContext,
        socketState: getSocketState(socket),
      }),
    {
      logger: logger.withContext({
        messageType: 'plan.command',
        requestId: generatedRequestId,
        threadId: command.threadId,
      }),
    },
  );
}

async function resumePendingPlanExecution(
  socket: WebSocket,
  requestId: string,
  threadId: PlanWorkflowCommand['threadId'],
  runtimeContext: RunChannelRuntimeContext,
): Promise<void> {
  const pending =
    await runtimeContext.planningWorkflows.readPendingExecution(threadId);
  if (pending === null) {
    return;
  }
  const request: RunStartRequest = {
    ...pending.executionTemplate,
    prompt:
      'Resume the exact daemon-approved plan through its trusted execution handoff.',
    threadId,
    approvedPlanRef: pending.ref,
    silentPrompt: true,
  };
  runDetached(
    'run-channel/pending-approved-plan-execution',
    () =>
      dispatchRunStart({
        socket,
        requestId,
        request,
        runtimeContext,
        socketState: getSocketState(socket),
      }),
    {
      logger: logger.withContext({
        messageType: 'plan.command',
        requestId,
        threadId,
      }),
    },
  );
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
