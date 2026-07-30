import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertRunId, assertThreadId } from '@geulbat/protocol/ids';
import type { AgentEvent } from '../../runtime-contracts.js';
import { createDaemonContext } from '../../context.js';
import type { ToolExecutionContext } from '../types.js';
import { createBuiltinToolRegistryStore } from './catalog.js';
import { visualizeTool } from './visualize.js';

void test('visualize는 code 필수 스키마를 노출한다', () => {
  const parameters = visualizeTool.parameters;
  assert.equal(visualizeTool.name, 'visualize');
  assert.ok('type' in parameters);
  assert.equal(parameters.type, 'object');
  assert.deepEqual(parameters.required, ['code']);
  assert.deepEqual(Object.keys(parameters.properties), [
    'code',
    'title',
    'planStamp',
    'planStepIds',
  ]);
  assert.equal(visualizeTool.sideEffectLevel, 'none');
  assert.equal(visualizeTool.requiresApproval, false);
  assert.equal(visualizeTool.mayMutateComputerFiles, false);
  assert.equal(visualizeTool.recoveryStrategy, 'replay_safe');
});

void test('builtin registry가 visualize를 노출한다', () => {
  const registry = createBuiltinToolRegistryStore();
  assert.ok(registry.getTool('visualize'));
  assert.equal(
    registry.getAllRegisteredToolNames().includes('visualize'),
    true,
  );
});

void test('svg 코드는 svg 모드 확인 응답을 돌려준다', async () => {
  const result = await visualizeTool.execute(
    {
      code: '<svg viewBox="0 0 10 10"><rect class="box" /></svg>',
      title: '파이프라인',
    },
    { callId: 'call_1' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output), {
    rendered: true,
    mode: 'svg',
    title: '파이프라인',
  });
});

void test('html 조각은 html 모드로 감지되고 코드가 결과에 되풀이되지 않는다', async () => {
  const result = await visualizeTool.execute(
    { code: '<div class="th">헤더</div>' },
    { callId: 'call_2' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output), {
    rendered: true,
    mode: 'html',
  });
  assert.equal(result.output.includes('헤더'), false);
});

void test('공백뿐인 code는 실패한다', async () => {
  const result = await visualizeTool.execute(
    { code: '   ' },
    { callId: 'call_3' },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errorCode, 'execution_failed');
  }
});

void test('승인 대기 계획의 시각화는 현재 daemon stamp와 정확히 일치해야 한다', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'visualize-plan-stamp-'));
  const runtimeServices = createDaemonContext({ homeStateRoot: stateRoot });
  const threadId = assertThreadId('123e4567-e89b-42d3-a456-426614174029');
  const runId = assertRunId('run-visualize-plan');
  const collecting = await runtimeServices.planningWorkflows.enterOrResume({
    threadId,
    requested: true,
    intensity: 'visual',
    depth: 'standard',
    executionTemplate: {
      workingDirectory: '/workspace',
      permissionMode: 'basic',
    },
  });
  if (collecting?.state !== 'collecting') {
    throw new Error('expected collecting planning workflow');
  }
  const proposed = await runtimeServices.planningWorkflows.propose({
    threadId,
    proposalRunId: runId,
    draft: {
      schemaVersion: 'plan_draft_v1',
      outcome: 'Stamp the visual explanation',
      steps: [
        {
          id: 'diagram',
          text: 'Render the current draft',
          acceptanceCriteria: ['The exact digest is visible'],
        },
      ],
      decisions: [],
      assumptions: [],
      openQuestions: [],
    },
  });
  const context = {
    kind: 'agent',
    callId: 'call-visualize-plan',
    signal: undefined,
    runSignal: undefined,
    currentFile: undefined,
    selection: undefined,
    approvalGranted: false,
    computerSessionId: 'session-visualize-plan',
    permissionMode: 'basic',
    stateRoot,
    threadId,
    runId,
    runOwnerKind: 'root_main',
    workingDirectory: '/workspace',
    runState: undefined,
    memoryIndex: runtimeServices.memoryIndex,
    runtimeServices,
    planningWorkflow: { workflowId: proposed.workflowId },
    emitAgentEvent: (_event: AgentEvent) => {},
  } satisfies ToolExecutionContext;

  const missing = await visualizeTool.execute({ code: '<svg></svg>' }, context);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.match(missing.error, /PLAN_APPROVAL_REQUIRED/u);
  }

  const missingStepBinding = await visualizeTool.execute(
    {
      code: '<svg></svg>',
      planStamp: {
        workflowId: proposed.workflowId,
        planId: proposed.planId,
        revision: proposed.revision,
        digest: proposed.digest,
      },
    },
    context,
  );
  assert.equal(missingStepBinding.ok, false);
  if (!missingStepBinding.ok) {
    assert.match(missingStepBinding.error, /PLAN_APPROVAL_REQUIRED/u);
  }

  const mismatchedStepBinding = await visualizeTool.execute(
    {
      code: '<svg><g data-plan-step-id="other"></g></svg>',
      planStamp: {
        workflowId: proposed.workflowId,
        planId: proposed.planId,
        revision: proposed.revision,
        digest: proposed.digest,
      },
      planStepIds: ['other'],
    },
    context,
  );
  assert.equal(mismatchedStepBinding.ok, false);
  if (!mismatchedStepBinding.ok) {
    assert.match(
      mismatchedStepBinding.error,
      /PLAN_REVISION_APPROVAL_REQUIRED/u,
    );
  }

  const rendered = await visualizeTool.execute(
    {
      code: '<svg><g data-plan-step-id="diagram"></g></svg>',
      planStamp: {
        workflowId: proposed.workflowId,
        planId: proposed.planId,
        revision: proposed.revision,
        digest: proposed.digest,
      },
      planStepIds: ['diagram'],
    },
    context,
  );
  assert.equal(rendered.ok, true);
  assert.deepEqual(JSON.parse(rendered.output).planStamp, {
    workflowId: proposed.workflowId,
    planId: proposed.planId,
    revision: proposed.revision,
    digest: proposed.digest,
  });
  assert.deepEqual(JSON.parse(rendered.output).planStepIds, ['diagram']);
});
