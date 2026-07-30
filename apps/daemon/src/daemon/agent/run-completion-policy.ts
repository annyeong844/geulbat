import type { AgentLoopTerminalCandidateDecision } from '@geulbat/agent-loop/kernel';
import { sha256Digest } from '@geulbat/content-identity/sha256';
import { stableStringify } from '@geulbat/content-identity/stable-json';
import { createLogger } from '@geulbat/structured-logger/logger';

import type { RunExecutionAgentBindings } from '../sessions/run-execution-lifecycle.js';
import type { PlanningWorkflowStore } from '../sessions/planning-workflow-store.js';
import type { GoalStore } from '../sessions/goal-store.js';
import type { AgentRuntimeServices } from '../daemon-runtime-contract.js';
import type {
  BackgroundChildResult,
  ChildRunTerminalSnapshot,
} from '../subagent-runtime-contracts.js';
import { isAgentChildTerminalState } from '../subagent-runtime-contracts.js';
import {
  closeInterjectBuffer,
  hasPendingInterject,
} from '../sessions/active-run-interject-buffer.js';
import { getErrorCode } from '../utils/error.js';
import {
  describeAgentResultForTextSurface,
  type AgentResult,
} from './agent-result.js';
import type { AgentEventEmitter } from './events.js';
import type { AgentLoopCompletionGapObservation } from './observer/agent-loop-observer.js';
import {
  shouldStopForNoProgress,
  type AgentNoProgressPolicy,
} from './no-progress-policy.js';
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
  | 'goal_completion_admission'
  | 'subagent_terminal_read';

interface CreateAgentRunCompletionPolicyArgs extends RunExecutionAgentBindings {
  runId: RunId;
  threadId: ThreadId;
  runState?: RunState;
  planningWorkflows: Pick<
    PlanningWorkflowStore,
    'readThread' | 'assessExecutionCompletion'
  >;
  goals: Pick<GoalStore, 'readForRun' | 'admitCompletion'>;
  backgroundNotifications: Pick<
    AgentRuntimeServices['backgroundNotifications'],
    'readThreadBackgroundResults'
  >;
  childRuns: Pick<
    AgentRuntimeServices['childRuns'],
    'getRetainedChildRunsByOwnerThread'
  >;
  emit: AgentEventEmitter;
  observeCompletionGap?: (
    observation: AgentLoopCompletionGapObservation,
  ) => void;
  /**
   * Operator-owned no-progress policy. Absent means observation only, which
   * keeps the shipped behaviour of the fingerprinting step.
   */
  noProgressPolicy?: AgentNoProgressPolicy | undefined;
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

function safeTerminalVerificationErrorCode(error: unknown): string | undefined {
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
      causeCode: safeTerminalVerificationErrorCode(args.error),
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
  let previousCompletionGap:
    | Pick<
        AgentLoopCompletionGapObservation,
        'evidenceRevision' | 'gapFingerprint' | 'repeatCount'
      >
    | undefined;

  function observeCompletionGap(input: {
    source: TerminalCandidateSource;
    obligation: AgentLoopCompletionGapObservation['obligation'];
    gapIdentity: unknown;
    evidenceIdentity: unknown;
  }):
    | Extract<AgentLoopTerminalCandidateDecision, { kind: 'no_progress' }>
    | undefined {
    // 같은 내용이면 같은 지문이어야 repeatCount가 "같은 격차의 반복"을 뜻한다.
    // 키 순서에 흔들리지 않는 판정은 content-identity가 소유한다 — JSON.stringify는
    // 삽입 순서를 따르므로 동일 내용에 다른 지문을 낼 수 있다.
    const gapFingerprint = sha256Digest(
      stableStringify(['agent-completion-gap-v1', input.gapIdentity]),
    );
    const evidenceRevision = sha256Digest(
      stableStringify(['agent-completion-evidence-v1', input.evidenceIdentity]),
    );
    const previous = previousCompletionGap;
    const sameGapAndEvidenceAsPrevious =
      previous?.gapFingerprint === gapFingerprint &&
      previous.evidenceRevision === evidenceRevision;
    const repeatCount =
      previous !== undefined && sameGapAndEvidenceAsPrevious
        ? previous.repeatCount + 1
        : 1;
    previousCompletionGap = {
      gapFingerprint,
      evidenceRevision,
      repeatCount,
    };
    const stopForNoProgress = shouldStopForNoProgress({
      policy: args.noProgressPolicy,
      repeatCount,
      sameGapAndEvidenceAsPrevious,
    });
    terminalVerificationLogger
      .withContext({
        diagnosticCode: 'terminal_verification.completion_gap_observed',
        runId: args.runId,
        threadId: args.threadId,
        source: input.source,
        obligation: input.obligation,
        gapFingerprint,
        evidenceRevision,
        repeatCount,
        sameGapAndEvidenceAsPrevious,
        noProgressAction: args.noProgressPolicy?.action ?? 'unconfigured',
        stopForNoProgress,
      })
      .info('completion gap observed');
    args.observeCompletionGap?.({
      schemaVersion: 1,
      runId: args.runId,
      threadId: args.threadId,
      source: input.source,
      obligation: input.obligation,
      gapFingerprint,
      evidenceRevision,
      repeatCount,
      sameGapAndEvidenceAsPrevious,
    });
    if (!stopForNoProgress) {
      return undefined;
    }
    // 사용자에게 남기는 이유는 무엇이 막혔는지와 무엇이 바뀌어야 풀리는지다.
    // gap/evidence identity는 hash로만 남기므로 objective나 plan 본문을 노출하지
    // 않는다.
    return {
      kind: 'no_progress',
      message:
        `Stopped after ${repeatCount} identical ${input.obligation} completion gaps with unchanged evidence. ` +
        'The same requirement stayed unmet and nothing the run did changed it. ' +
        'Revise the objective, supply the missing authority or input, or resume after changing the underlying state.',
    };
  }

  // 유저 스티어가 이미 들어 있으면 모델/검증이 "끝"이라고 말해도 루프를 연다.
  // await 전 검사만으로는 plan/goal I/O yield 중 도착한 스티어가 terminal 닫힘에
  // 먹히므로, 모든 hard-stop 직전에도 같은 판정을 다시 쓴다 (CL-05 TOCTOU).
  function continueForPendingInterject(
    source: TerminalCandidateSource,
    result: AgentResult,
  ):
    | Extract<AgentLoopTerminalCandidateDecision, { kind: 'continue' }>
    | undefined {
    if (
      args.runState === undefined ||
      !hasPendingInterject(args.runState.interject)
    ) {
      return undefined;
    }
    previousCompletionGap = undefined;
    return source === 'structured_output'
      ? {
          kind: 'continue',
          historyText: describeAgentResultForTextSurface(result),
        }
      : { kind: 'continue' };
  }

  function continueForPendingChildTerminal(
    source: TerminalCandidateSource,
    result: AgentResult,
  ): AgentLoopTerminalCandidateDecision | undefined {
    let notificationReadFailure:
      | Extract<
          AgentLoopTerminalCandidateDecision,
          { kind: 'verification_unavailable' }
        >
      | undefined;
    let pendingResults: BackgroundChildResult[] = [];
    try {
      pendingResults = args.backgroundNotifications
        .readThreadBackgroundResults(args.threadId)
        .filter((entry) => entry.parentRunId === args.runId);
    } catch (error: unknown) {
      notificationReadFailure = recordTerminalVerificationFailure({
        operation: 'subagent_terminal_read',
        error,
        userMessage:
          'Subagent terminal completion verification is unavailable.',
        runId: args.runId,
        threadId: args.threadId,
      });
    }

    const retainedTerminalChildren = args.childRuns
      .getRetainedChildRunsByOwnerThread(args.threadId)
      .filter(
        (child): child is ChildRunTerminalSnapshot =>
          child.parentRunId === args.runId &&
          isAgentChildTerminalState(child.status),
      );
    if (pendingResults.length === 0 && retainedTerminalChildren.length === 0) {
      return notificationReadFailure;
    }

    previousCompletionGap = undefined;
    const outcomeByChildRunId = new Map<
      RunId,
      {
        childRunId: RunId;
        terminalState: ChildRunTerminalSnapshot['status'];
        reason: ChildRunTerminalSnapshot['reason'];
        sources: string[];
      }
    >();
    for (const notification of pendingResults) {
      outcomeByChildRunId.set(notification.childRunId, {
        childRunId: notification.childRunId,
        terminalState: notification.terminalState,
        reason: notification.reason ?? null,
        sources: ['addressed_notification'],
      });
    }
    for (const registryChild of retainedTerminalChildren) {
      const notificationOutcome = outcomeByChildRunId.get(
        registryChild.childRunId,
      );
      outcomeByChildRunId.set(registryChild.childRunId, {
        childRunId: registryChild.childRunId,
        terminalState:
          notificationOutcome?.terminalState ?? registryChild.status,
        reason: notificationOutcome?.reason ?? registryChild.reason,
        sources: [...(notificationOutcome?.sources ?? []), 'child_registry'],
      });
    }
    const outcomes = [...outcomeByChildRunId.values()];
    const continuation = JSON.stringify({
      kind: 'pending_child_terminal_updates',
      childRunIds: outcomes.map((entry) => entry.childRunId),
      outcomes,
      notificationReadUnavailable: notificationReadFailure !== undefined,
      requiredNextAction:
        'Call agent_wait with these childRunIds before finalizing, inspect every terminal outcome, and decide whether the promised work is still complete.',
      continuationOptions: {
        daemonInterrupted:
          'Use agent_retry only when the same interrupted task is still required.',
        preservedChildContext:
          'Use agent_send_input when continuing the same terminal child thread is useful.',
        newIndependentWork:
          'A terminal child does not disable agent_spawn; launch a fresh child when new independent work remains.',
        noLongerNeeded:
          'If no further child work is needed, continue locally after accounting for the terminal result.',
      },
    });
    return {
      kind: 'continue',
      historyText:
        source === 'structured_output'
          ? `${describeAgentResultForTextSurface(result)}\n${continuation}`
          : continuation,
    };
  }

  function continueForPendingRuntimeWork(
    source: TerminalCandidateSource,
    result: AgentResult,
  ): AgentLoopTerminalCandidateDecision | undefined {
    return (
      continueForPendingInterject(source, result) ??
      continueForPendingChildTerminal(source, result)
    );
  }

  function finalizeTerminal(
    source: TerminalCandidateSource,
    result: AgentResult,
  ): AgentLoopTerminalCandidateDecision {
    const pending = continueForPendingRuntimeWork(source, result);
    if (pending !== undefined) {
      return pending;
    }
    if (args.runState !== undefined) {
      closeInterjectBuffer(args.runState.interject);
    }
    return { kind: 'terminal' };
  }

  function preferPendingRuntimeWorkOverHardStop(
    source: TerminalCandidateSource,
    result: AgentResult,
    decision: Extract<
      AgentLoopTerminalCandidateDecision,
      { kind: 'no_progress' | 'verification_unavailable' }
    >,
  ): AgentLoopTerminalCandidateDecision {
    return continueForPendingRuntimeWork(source, result) ?? decision;
  }

  return {
    async resolveTerminalCandidate({ source, result }) {
      const earlyContinue = continueForPendingRuntimeWork(source, result);
      if (earlyContinue !== undefined) {
        return earlyContinue;
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
            return preferPendingRuntimeWorkOverHardStop(source, result, {
              kind: 'verification_unavailable',
              message: 'planning workflow completion verification is stale',
            });
          }
          if (snapshot.state === 'collecting') {
            const noProgress = observeCompletionGap({
              source,
              obligation: 'planning_workflow',
              gapIdentity: {
                kind: 'planning_workflow_incomplete',
                workflowId: snapshot.workflowId,
              },
              evidenceIdentity: {
                state: snapshot.state,
                revision: snapshot.revision ?? null,
                updatedAt: snapshot.updatedAt,
              },
            });
            if (noProgress !== undefined) {
              return preferPendingRuntimeWorkOverHardStop(
                source,
                result,
                noProgress,
              );
            }
            const incomplete = JSON.stringify({
              kind: 'planning_workflow_incomplete',
              requiredNextAction:
                snapshot.depth === 'deep'
                  ? 'call ask_user for the next consequential decision or the final understanding_confirmation checkpoint; call propose_plan only after the user confirms that checkpoint'
                  : 'call ask_user for one consequential user decision, or call propose_plan with the canonical draft',
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
          return preferPendingRuntimeWorkOverHardStop(
            source,
            result,
            recordTerminalVerificationFailure({
              operation: 'planning_workflow_read',
              error,
              userMessage:
                'planning workflow completion verification is unavailable.',
              runId: args.runId,
              threadId: args.threadId,
              planningWorkflowId: args.planningWorkflow.workflowId,
            }),
          );
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
            return preferPendingRuntimeWorkOverHardStop(source, result, {
              kind: 'verification_unavailable',
              message: 'Goal completion admission is stale',
            });
          }
          goalSnapshot = snapshot;
        } catch (error: unknown) {
          return preferPendingRuntimeWorkOverHardStop(
            source,
            result,
            recordTerminalVerificationFailure({
              operation: 'goal_read',
              error,
              userMessage: 'Goal completion admission is unavailable.',
              runId: args.runId,
              threadId: args.threadId,
              goalId: args.goal.goalId,
            }),
          );
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
            const noProgress = observeCompletionGap({
              source,
              obligation: 'approved_plan_execution',
              gapIdentity: {
                kind: 'approved_plan_execution',
                ref: {
                  workflowId: args.approvedPlan.ref.workflowId,
                  planId: args.approvedPlan.ref.planId,
                  revision: args.approvedPlan.ref.revision,
                  digest: args.approvedPlan.ref.digest,
                },
                requirementIds: assessment.items.map((item) => item.id).sort(),
              },
              evidenceIdentity: {
                requirements: assessment.items
                  .map(({ id, status }) => ({ id, status }))
                  .sort((left, right) =>
                    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
                  ),
              },
            });
            if (noProgress !== undefined) {
              return preferPendingRuntimeWorkOverHardStop(
                source,
                result,
                noProgress,
              );
            }
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
          return preferPendingRuntimeWorkOverHardStop(
            source,
            result,
            recordTerminalVerificationFailure({
              operation: 'approved_plan_assessment',
              error,
              userMessage:
                'approved plan completion verification is unavailable.',
              runId: args.runId,
              threadId: args.threadId,
              approvedPlanWorkflowId: args.approvedPlan.ref.workflowId,
              approvedPlanId: args.approvedPlan.ref.planId,
            }),
          );
        }
      }
      if (args.goal !== undefined && goalSnapshot !== undefined) {
        const snapshot = goalSnapshot;
        if (snapshot.state === 'verifying') {
          try {
            const completed = await args.goals.admitCompletion({
              threadId: args.threadId,
              goalId: args.goal.goalId,
              runId: args.runId,
            });
            args.emit('goal_updated', completed);
          } catch (error: unknown) {
            return preferPendingRuntimeWorkOverHardStop(
              source,
              result,
              recordTerminalVerificationFailure({
                operation: 'goal_completion_admission',
                error,
                userMessage: 'Goal completion admission is unavailable.',
                runId: args.runId,
                threadId: args.threadId,
                goalId: args.goal.goalId,
              }),
            );
          }
          return {
            kind: 'continue',
            historyText: JSON.stringify({
              kind: 'goal_completion_admitted',
              basis: 'deterministic_host_obligations_satisfied',
              instruction:
                'Give the user the concise final answer now. Do not call update_goal again.',
            }),
          };
        }
        if (snapshot.state === 'completed') {
          return finalizeTerminal(source, result);
        }
        if (snapshot.state === 'verification_unavailable') {
          return preferPendingRuntimeWorkOverHardStop(source, result, {
            kind: 'verification_unavailable',
            message: 'Goal completion admission is unavailable',
          });
        }
        if (snapshot.state === 'paused' || source === 'tool_completion') {
          return finalizeTerminal(source, result);
        }
        const continuation = JSON.stringify({
          kind: 'goal_incomplete',
          objective: snapshot.objective,
          instruction:
            'Continue working. Call update_goal only after concrete evidence shows the Goal is complete.',
        });
        const goalNoProgress = observeCompletionGap({
          source,
          obligation: 'goal_completion',
          gapIdentity: {
            kind: 'goal_incomplete',
            goalId: snapshot.goalId,
          },
          evidenceIdentity: {
            state: snapshot.state,
            updatedAt: snapshot.updatedAt,
          },
        });
        if (goalNoProgress !== undefined) {
          return preferPendingRuntimeWorkOverHardStop(
            source,
            result,
            goalNoProgress,
          );
        }
        return {
          kind: 'continue',
          historyText:
            source === 'structured_output'
              ? `${describeAgentResultForTextSurface(result)}\n${continuation}`
              : continuation,
        };
      }
      return finalizeTerminal(source, result);
    },
  };
}
