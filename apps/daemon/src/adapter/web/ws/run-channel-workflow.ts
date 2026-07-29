import type WebSocket from 'ws';
import type { RunStartRequest } from '@geulbat/protocol/run-contract';
import type { PlanWorkflowCommand } from '@geulbat/protocol/planning-workflow';
import type { GoalCommand } from '@geulbat/protocol/goal';
import { createLogger } from '@geulbat/structured-logger/logger';

import { getErrorMessage } from '../../../daemon/utils/error.js';
import { runDetached } from '../../../daemon/utils/run-detached.js';
import { sendError, sendMessage } from './run-channel-socket.js';
import type { RunChannelRuntimeContext } from './run-channel-runtime-context.js';
import { getSocketState } from './run-channel-socket-runtime.js';
import { dispatchRunStart } from './run-channel-start.js';

const logger = createLogger('run-channel/dispatch');

export async function synchronizeRunWorkflowState(
  socket: WebSocket,
  requestId: string,
  threadId: PlanWorkflowCommand['threadId'],
  runtimeContext: RunChannelRuntimeContext,
): Promise<void> {
  await sendPlanningWorkflowSnapshot(socket, threadId, runtimeContext);
  await sendGoalSnapshot(socket, threadId, runtimeContext);
  await resumePendingPlanExecution(socket, requestId, threadId, runtimeContext);
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

export async function handleGoalCommand(
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

export async function handlePlanWorkflowCommand(
  socket: WebSocket,
  requestId: string,
  command: PlanWorkflowCommand,
  runtimeContext: RunChannelRuntimeContext,
): Promise<void> {
  const replacedActiveRun =
    command.kind === 'cancel' || command.kind === 'request_revision'
      ? runtimeContext.activeRuns.getRunByThreadId(command.threadId)
      : undefined;
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
  if (replacedActiveRun !== undefined) {
    runtimeContext.activeRuns.abortRunSubtree(
      replacedActiveRun.runId,
      'planning_workflow_replaced',
    );
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
            // 이 continuation은 기존 workflow만 이어야 한다. 사용자가 그사이
            // 취소했다면 새 계획 workflow를 조용히 만들지 않는다.
            planModeRequested: false,
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
                "Use the user's language for the title and visible labels. Lead with the decision, work flow, and expected outcome. Keep raw ids, digests, internal state names, and file-level evidence in the adjacent searchable text instead of making them the diagram's main story.",
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
              // 그림은 현재 승인 revision의 projection이다. 취소 뒤 새
              // workflow를 만드는 요청으로 승격하지 않는다.
              planModeRequested: false,
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
    async () => {
      if (
        command.kind === 'request_revision' &&
        replacedActiveRun !== undefined
      ) {
        await runtimeContext.activeRuns.waitForThreadIdle(command.threadId);
      }
      if (
        command.kind === 'request_revision' ||
        command.kind === 'explain_visual'
      ) {
        const current = await runtimeContext.planningWorkflows.readThread(
          command.threadId,
        );
        const stillCurrent =
          command.kind === 'request_revision'
            ? current?.state === 'collecting' &&
              current.workflowId === command.workflowId &&
              current.planId === command.planId &&
              current.revision === command.revision
            : current?.state === 'awaiting_approval' &&
              current.workflowId === command.workflowId &&
              current.planId === command.planId &&
              current.revision === command.revision &&
              current.digest === command.digest;
        if (!stillCurrent) {
          return;
        }
      }
      await dispatchRunStart({
        socket,
        requestId: generatedRequestId,
        request: generatedRequest,
        runtimeContext,
        socketState: getSocketState(socket),
      });
    },
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
