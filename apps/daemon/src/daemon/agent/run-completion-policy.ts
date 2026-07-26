import type { AgentLoopTerminalCandidateDecision } from '@geulbat/agent-loop/kernel';
import { createLogger } from '@geulbat/structured-logger/logger';

import type { RunExecutionAgentBindings } from '../sessions/run-execution-lifecycle.js';
import type { PlanningWorkflowStore } from '../sessions/planning-workflow-store.js';
import type { GoalStore } from '../sessions/goal-store.js';
import {
  closeInterjectBuffer,
  hasPendingInterject,
} from '../sessions/active-run-interject-buffer.js';
import type { ProviderReplayScopeId } from '../runtime-contracts.js';
import type { HistoryItem, CallModelInput } from '../llm/index.js';
import { normalizeProviderErrorCode } from '../llm/provider/provider-error.js';
import { getErrorCode } from '../utils/error.js';
import {
  describeAgentResultForTextSurface,
  type AgentResult,
} from './agent-result.js';
import type { AgentEventEmitter } from './events.js';
import {
  verifyGoalCompletion,
  type GoalCompletionVerifier,
} from './goal-completion-verifier.js';
import type { CallModelFn } from './loop-types.js';
import type { RunState } from './runtime/run-state.js';
import type { RunId, ThreadId } from './contract.js';

const terminalVerificationLogger = createLogger('agent/terminal-verification');

type TerminalCandidateSource =
  | 'structured_output'
  | 'natural'
  | 'tool_completion';

type TerminalVerificationFailureOperation =
  | 'planning_workflow_read'
  | 'goal_read'
  | 'approved_plan_assessment'
  | 'goal_completion_verifier'
  | 'goal_verification_record';

interface CreateAgentRunCompletionPolicyArgs extends RunExecutionAgentBindings {
  runId: RunId;
  threadId: ThreadId;
  history: readonly HistoryItem[];
  runState?: RunState;
  planningWorkflows: Pick<
    PlanningWorkflowStore,
    'readThread' | 'assessExecutionCompletion'
  >;
  goals: Pick<GoalStore, 'readForRun' | 'recordVerification'>;
  emit: AgentEventEmitter;
  providerAuthRuntime: CallModelInput['providerAuthRuntime'];
  providerWebSocketSessions: CallModelInput['providerWebSocketSessions'];
  providerRequestOptions: CallModelInput['providerRequestOptions'];
  providerReplayScopeId?: ProviderReplayScopeId;
  callModelImpl?: CallModelFn;
  goalCompletionVerifier?: GoalCompletionVerifier;
  signal?: AbortSignal;
}

function safeTerminalVerificationErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'UnknownError';
  }
  switch (error.name) {
    case 'AbortError':
    case 'AggregateError':
    case 'Error':
    case 'RangeError':
    case 'SyntaxError':
    case 'TypeError':
      return error.name;
    default:
      return 'UnknownError';
  }
}

function safeTerminalVerificationErrorCode(
  operation: TerminalVerificationFailureOperation,
  error: unknown,
): string | undefined {
  if (operation === 'goal_completion_verifier') {
    const code = normalizeProviderErrorCode(error);
    switch (code) {
      case 'aborted':
      case 'internal':
      case 'llm_auth_failed':
      case 'llm_connect_timeout':
      case 'llm_context_length_exceeded':
      case 'llm_context_preparation_required':
      case 'llm_idle_timeout':
      case 'llm_overloaded':
      case 'llm_rate_limited':
      case 'provider_transition_required':
        return code;
      default:
        return 'internal';
    }
  }

  const code = getErrorCode(error);
  switch (code) {
    case 'ABORT_ERR':
    case 'EACCES':
    case 'EEXIST':
    case 'EISDIR':
    case 'ELOOP':
    case 'EMFILE':
    case 'ENAMETOOLONG':
    case 'ENOENT':
    case 'ENOSPC':
    case 'ENOTDIR':
    case 'EPERM':
      return code;
    default:
      return undefined;
  }
}

function recordTerminalVerificationFailure(args: {
  operation: TerminalVerificationFailureOperation;
  error: unknown;
  userMessage: string;
  runId: string;
  threadId: string;
  planningWorkflowId?: string;
  approvedPlanWorkflowId?: string;
  approvedPlanId?: string;
  goalId?: string;
}): Extract<
  AgentLoopTerminalCandidateDecision,
  { kind: 'verification_unavailable' }
> {
  const diagnosticCode = `terminal_verification.${args.operation}_failed`;
  terminalVerificationLogger
    .withContext({
      diagnosticCode,
      operation: args.operation,
      runId: args.runId,
      threadId: args.threadId,
      planningWorkflowId: args.planningWorkflowId,
      approvedPlanWorkflowId: args.approvedPlanWorkflowId,
      approvedPlanId: args.approvedPlanId,
      goalId: args.goalId,
      causeName: safeTerminalVerificationErrorName(args.error),
      causeCode: safeTerminalVerificationErrorCode(args.operation, args.error),
    })
    .error('terminal verification failed');
  return {
    kind: 'verification_unavailable',
    message: `${args.userMessage} Diagnostic: ${diagnosticCode}. Retry this run after resolving the matching daemon diagnostic.`,
  };
}

function formatIncompleteApprovedPlanAssessment(
  items: ReadonlyArray<{
    id: string;
    text: string;
    status: 'pending' | 'in_progress';
  }>,
): string {
  return JSON.stringify({
    kind: 'completion_assessment',
    verdict: 'not_achieved',
    obligation: 'approved_plan_execution',
    unmetRequirements: items.map((item) => ({
      id: item.id,
      requirement: item.text,
      status: item.status,
    })),
  });
}

export function createAgentRunCompletionPolicy(
  args: CreateAgentRunCompletionPolicyArgs,
): {
  resolveTerminalCandidate(input: {
    source: TerminalCandidateSource;
    result: AgentResult;
  }): Promise<AgentLoopTerminalCandidateDecision>;
} {
  return {
    async resolveTerminalCandidate({ source, result }) {
      if (
        args.runState !== undefined &&
        hasPendingInterject(args.runState.interject)
      ) {
        return source === 'structured_output'
          ? {
              kind: 'continue',
              historyText: describeAgentResultForTextSurface(result),
            }
          : { kind: 'continue' };
      }
      if (
        args.planningWorkflow !== undefined &&
        args.approvedPlan === undefined &&
        source !== 'tool_completion'
      ) {
        try {
          const snapshot = await args.planningWorkflows.readThread(
            args.threadId,
          );
          if (
            snapshot === null ||
            snapshot.workflowId !== args.planningWorkflow.workflowId
          ) {
            return {
              kind: 'verification_unavailable',
              message: 'planning workflow completion verification is stale',
            };
          }
          if (snapshot.state === 'collecting') {
            const incomplete = JSON.stringify({
              kind: 'planning_workflow_incomplete',
              requiredNextAction:
                'call ask_user for one consequential user decision, or call propose_plan with the canonical draft',
              finalProseDoesNotCompletePlanning: true,
            });
            return {
              kind: 'continue',
              historyText:
                source === 'structured_output'
                  ? `${describeAgentResultForTextSurface(result)}\n${incomplete}`
                  : incomplete,
            };
          }
        } catch (error: unknown) {
          return recordTerminalVerificationFailure({
            operation: 'planning_workflow_read',
            error,
            userMessage:
              'planning workflow completion verification is unavailable.',
            runId: args.runId,
            threadId: args.threadId,
            planningWorkflowId: args.planningWorkflow.workflowId,
          });
        }
      }
      let goalSnapshot;
      if (args.goal !== undefined) {
        try {
          const snapshot = await args.goals.readForRun({
            threadId: args.threadId,
            ref: { goalId: args.goal.goalId },
          });
          if (snapshot === null) {
            return {
              kind: 'verification_unavailable',
              message: 'Goal completion verification is stale',
            };
          }
          goalSnapshot = snapshot;
        } catch (error: unknown) {
          return recordTerminalVerificationFailure({
            operation: 'goal_read',
            error,
            userMessage: 'Goal completion verification is unavailable.',
            runId: args.runId,
            threadId: args.threadId,
            goalId: args.goal.goalId,
          });
        }
      }
      if (
        args.approvedPlan !== undefined &&
        (source !== 'tool_completion' || goalSnapshot?.state === 'verifying')
      ) {
        try {
          const assessment =
            await args.planningWorkflows.assessExecutionCompletion({
              ref: args.approvedPlan.ref,
              threadId: args.threadId,
              executionRunId: args.runId,
            });
          if (assessment.kind === 'incomplete') {
            const assessmentText = formatIncompleteApprovedPlanAssessment(
              assessment.items,
            );
            return {
              kind: 'continue',
              historyText:
                source === 'structured_output'
                  ? `${describeAgentResultForTextSurface(result)}\n${assessmentText}`
                  : assessmentText,
            };
          }
        } catch (error: unknown) {
          return recordTerminalVerificationFailure({
            operation: 'approved_plan_assessment',
            error,
            userMessage:
              'approved plan completion verification is unavailable.',
            runId: args.runId,
            threadId: args.threadId,
            approvedPlanWorkflowId: args.approvedPlan.ref.workflowId,
            approvedPlanId: args.approvedPlan.ref.planId,
          });
        }
      }
      if (args.goal !== undefined && goalSnapshot !== undefined) {
        const snapshot = goalSnapshot;
        if (snapshot.state === 'verifying') {
          let panel: Awaited<ReturnType<GoalCompletionVerifier['verify']>>;
          try {
            panel =
              args.goalCompletionVerifier === undefined
                ? await verifyGoalCompletion({
                    goal: snapshot,
                    history: args.history,
                    runId: args.runId,
                    providerAuthRuntime: args.providerAuthRuntime,
                    providerWebSocketSessions: args.providerWebSocketSessions,
                    providerRequestOptions: args.providerRequestOptions,
                    ...(args.providerReplayScopeId === undefined
                      ? {}
                      : {
                          providerReplayScopeId: args.providerReplayScopeId,
                        }),
                    ...(args.callModelImpl === undefined
                      ? {}
                      : { callModelImpl: args.callModelImpl }),
                    ...(args.signal === undefined
                      ? {}
                      : { signal: args.signal }),
                  })
                : await args.goalCompletionVerifier.verify({
                    goal: snapshot,
                    history: args.history,
                    runId: args.runId,
                    ...(args.signal === undefined
                      ? {}
                      : { signal: args.signal }),
                  });
          } catch (error: unknown) {
            return recordTerminalVerificationFailure({
              operation: 'goal_completion_verifier',
              error,
              userMessage: 'Goal completion verification is unavailable.',
              runId: args.runId,
              threadId: args.threadId,
              goalId: args.goal.goalId,
            });
          }
          let verified;
          try {
            verified = await args.goals.recordVerification({
              threadId: args.threadId,
              goalId: args.goal.goalId,
              runId: args.runId,
              outcome: panel.outcome,
              votes: panel.votes,
            });
          } catch (error: unknown) {
            return recordTerminalVerificationFailure({
              operation: 'goal_verification_record',
              error,
              userMessage: 'Goal completion verification is unavailable.',
              runId: args.runId,
              threadId: args.threadId,
              goalId: args.goal.goalId,
            });
          }
          args.emit('goal_updated', verified);
          if (panel.outcome.kind === 'achieved') {
            return {
              kind: 'continue',
              historyText: JSON.stringify({
                kind: 'goal_completion_verified',
                instruction:
                  'Give the user the concise final answer now. Do not call update_goal again.',
              }),
            };
          }
          if (panel.outcome.kind === 'incomplete') {
            return {
              kind: 'continue',
              historyText: JSON.stringify({
                kind: 'goal_completion_assessment',
                verdict: 'not_achieved',
                unmetRequirements: panel.outcome.unmetRequirements,
                instruction:
                  'Continue the Goal and address these requirements before requesting verification again.',
              }),
            };
          }
          return {
            kind: 'verification_unavailable',
            message: panel.outcome.message,
          };
        }
        if (snapshot.state === 'completed') {
          if (args.runState !== undefined) {
            closeInterjectBuffer(args.runState.interject);
          }
          return { kind: 'terminal' };
        }
        if (snapshot.state === 'verification_unavailable') {
          return {
            kind: 'verification_unavailable',
            message: 'Goal completion verification is unavailable',
          };
        }
        if (snapshot.state === 'paused' || source === 'tool_completion') {
          if (args.runState !== undefined) {
            closeInterjectBuffer(args.runState.interject);
          }
          return { kind: 'terminal' };
        }
        const continuation = JSON.stringify({
          kind: 'goal_incomplete',
          objective: snapshot.objective,
          instruction:
            'Continue working. Call update_goal only after concrete evidence shows the Goal is complete.',
        });
        return {
          kind: 'continue',
          historyText:
            source === 'structured_output'
              ? `${describeAgentResultForTextSurface(result)}\n${continuation}`
              : continuation,
        };
      }
      if (args.runState !== undefined) {
        closeInterjectBuffer(args.runState.interject);
      }
      return { kind: 'terminal' };
    },
  };
}
