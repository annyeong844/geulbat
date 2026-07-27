import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { PlanDraftV1 } from '@geulbat/protocol/planning-workflow';
import { createDaemonContext } from '../context.js';
import { makeApprovalContext } from '../../test-support/approval-runtime.js';
import { makeRunContext } from '../../test-support/run-context.js';
import { testRunId } from '../../test-support/run-id.js';
import { testThreadId } from '../../test-support/thread-id.js';
import type { GoalSnapshot } from './contract.js';
import type { AgentEvent } from './events.js';
import type { AgentInput } from './loop-types.js';
import { runAgentLoop } from './run-agent-loop.js';

const SENSITIVE_CAUSE = 'token-secret /private/workspace/provider-body';

const approvedPlanDraft: PlanDraftV1 = {
  schemaVersion: 'plan_draft_v1',
  outcome: 'Finish the diagnostic test plan',
  steps: [
    {
      id: 'verify',
      text: 'Verify terminal diagnostics',
      acceptanceCriteria: ['The failure remains diagnosable'],
    },
  ],
  decisions: [],
  assumptions: [],
  openQuestions: [],
};

const failureExpectations = [
  {
    operation: 'planning_workflow_read',
    causeName: 'Error',
    causeCode: 'ENOENT',
    correlation: 'planningWorkflowId="workflow-terminal-diagnostic"',
  },
  {
    operation: 'goal_read',
    causeName: 'SyntaxError',
    causeCode: 'EACCES',
    correlation: 'goalId="goal-terminal-diagnostic"',
  },
  {
    operation: 'approved_plan_assessment',
    causeName: 'TypeError',
    correlation: 'approvedPlanId="plan-terminal-diagnostic"',
  },
  {
    operation: 'goal_completion_admission',
    causeName: 'Error',
    causeCode: 'ENOSPC',
    correlation: 'goalId="goal-terminal-diagnostic"',
  },
] as const;

type FailureOperation = (typeof failureExpectations)[number]['operation'];

void test('runAgentLoop preserves safe owner diagnostics for every terminal planning and Goal failure stage', async () => {
  for (const [index, expectation] of failureExpectations.entries()) {
    const threadId = testThreadId(1300 + index);
    const runId = testRunId(1300 + index);
    const stateRoot = await mkdtemp(
      join(tmpdir(), `geulbat-terminal-verification-${expectation.operation}-`),
    );
    const daemonContext = createDaemonContext({ homeStateRoot: stateRoot });
    const events: AgentEvent[] = [];
    const errorLogs: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errorLogs.push(args);
    };

    try {
      const failureInput = terminalVerificationFailureInput({
        operation: expectation.operation,
        threadId,
        daemonContext,
      });
      const result = await runAgentLoop({
        runId,
        runContext: makeRunContext({ threadId, stateRoot }),
        prompt: 'Do not report success when terminal verification fails.',
        runtimeServices: failureInput.runtimeServices,
        approvalContext: makeApprovalContext({
          computerSessionId: `session-${expectation.operation}`,
        }),
        historyPort: {
          async loadInitialHistory() {
            return [
              {
                kind: 'user',
                text: 'Do not report success when terminal verification fails.',
              },
            ];
          },
        },
        modelRoundPort: {
          async runModelRound() {
            return {
              ok: true,
              value: {
                assistantText: 'premature success',
                terminalResult: {
                  ok: true,
                  finalProse: 'premature success',
                },
                functionCalls: [],
              },
            };
          },
        },
        toolLibraryProjectionPort: {
          async resolveProjection() {
            return {
              ok: true,
              identity: {
                sdkVersion: 'terminal-verification-test',
                sdkProjectionHash:
                  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                policyId: 'terminal-verification-test',
              },
            };
          },
        },
        ...(failureInput.planningWorkflow === undefined
          ? {}
          : { planningWorkflow: failureInput.planningWorkflow }),
        ...(failureInput.approvedPlan === undefined
          ? {}
          : { approvedPlan: failureInput.approvedPlan }),
        ...(failureInput.goal === undefined ? {} : { goal: failureInput.goal }),
        onEvent(event) {
          events.push(event);
        },
      });

      assert.deepEqual(result, { ok: false, finalProse: '' });
    } finally {
      console.error = originalError;
    }

    const terminal = events.at(-1);
    assert.equal(terminal?.type, 'error');
    if (terminal?.type !== 'error') {
      throw new Error('expected a terminal error event');
    }
    const diagnosticCode = `terminal_verification.${expectation.operation}_failed`;
    assert.equal(terminal.payload.code, 'execution_failed');
    assert.match(terminal.payload.message, new RegExp(diagnosticCode));
    assert.match(
      terminal.payload.message,
      /Retry this run after resolving the matching daemon diagnostic\./,
    );
    assert.equal(terminal.payload.message.includes(SENSITIVE_CAUSE), false);
    assert.equal(
      events.some((event) => event.type === 'done'),
      false,
      `${expectation.operation} must not produce false terminal success`,
    );

    const diagnosticLines = errorLogs
      .map(([line]) => String(line))
      .filter((line) =>
        line.includes(
          'error [agent/terminal-verification] terminal verification failed',
        ),
      );
    assert.equal(diagnosticLines.length, 1);
    const diagnosticLine = diagnosticLines[0] ?? '';
    assert.match(diagnosticLine, new RegExp(diagnosticCode));
    assert.match(
      diagnosticLine,
      new RegExp(`operation="${expectation.operation}"`),
    );
    assert.match(diagnosticLine, new RegExp(`runId="${runId}"`));
    assert.match(diagnosticLine, new RegExp(`threadId="${threadId}"`));
    assert.match(diagnosticLine, new RegExp(expectation.correlation));
    assert.match(
      diagnosticLine,
      new RegExp(`causeName="${expectation.causeName}"`),
    );
    if ('causeCode' in expectation) {
      assert.match(
        diagnosticLine,
        new RegExp(`causeCode="${expectation.causeCode}"`),
      );
    } else {
      assert.equal(diagnosticLine.includes('causeCode='), false);
    }
    assert.equal(diagnosticLine.includes(SENSITIVE_CAUSE), false);
    assert.equal(diagnosticLine.includes('token-secret-code'), false);
  }
});

function terminalVerificationFailureInput(args: {
  operation: FailureOperation;
  threadId: ReturnType<typeof testThreadId>;
  daemonContext: ReturnType<typeof createDaemonContext>;
}): Pick<
  AgentInput,
  'runtimeServices' | 'planningWorkflow' | 'approvedPlan' | 'goal'
> {
  const goal = {
    goalId: 'goal-terminal-diagnostic',
    objective: 'Preserve terminal verification diagnostics',
  };
  const verifyingGoal: GoalSnapshot = {
    ...goal,
    threadId: args.threadId,
    state: 'verifying',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
  };

  switch (args.operation) {
    case 'planning_workflow_read': {
      const error = Object.assign(new Error(SENSITIVE_CAUSE), {
        code: 'ENOENT',
      });
      return {
        runtimeServices: {
          ...args.daemonContext,
          planningWorkflows: {
            ...args.daemonContext.planningWorkflows,
            async readThread() {
              throw error;
            },
          },
        },
        planningWorkflow: {
          workflowId: 'workflow-terminal-diagnostic',
          intensity: 'quiet',
          depth: 'standard',
        },
      };
    }
    case 'goal_read': {
      const error = Object.assign(new SyntaxError(SENSITIVE_CAUSE), {
        code: 'EACCES',
      });
      return {
        runtimeServices: {
          ...args.daemonContext,
          goals: {
            ...args.daemonContext.goals,
            async readForRun() {
              throw error;
            },
          },
        },
        goal,
      };
    }
    case 'approved_plan_assessment': {
      const error = Object.assign(new TypeError(SENSITIVE_CAUSE), {
        code: 'token-secret-code',
      });
      return {
        runtimeServices: {
          ...args.daemonContext,
          planningWorkflows: {
            ...args.daemonContext.planningWorkflows,
            async assessExecutionCompletion() {
              throw error;
            },
          },
        },
        approvedPlan: {
          ref: {
            workflowId: 'workflow-terminal-diagnostic',
            planId: 'plan-terminal-diagnostic',
            revision: 1,
            digest: 'sha256:terminal-verification-diagnostic',
          },
          draft: approvedPlanDraft,
        },
      };
    }
    case 'goal_completion_admission': {
      const error = Object.assign(new Error(SENSITIVE_CAUSE), {
        code: 'ENOSPC',
      });
      return {
        runtimeServices: {
          ...args.daemonContext,
          goals: {
            ...args.daemonContext.goals,
            async readForRun() {
              return verifyingGoal;
            },
            async admitCompletion() {
              throw error;
            },
          },
        },
        goal,
      };
    }
  }
}
