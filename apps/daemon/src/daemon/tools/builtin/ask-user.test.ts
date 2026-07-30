import assert from 'node:assert/strict';
import test from 'node:test';

import { askUserTool } from './ask-user.js';
import { createBuiltinToolRegistryStore } from './catalog.js';

void test('ask_user는 question과 options 스키마를 노출한다', () => {
  const parameters = askUserTool.parameters;
  assert.equal(askUserTool.name, 'ask_user');
  assert.ok('type' in parameters);
  assert.deepEqual(parameters.required, ['question', 'options']);
  assert.equal(askUserTool.sideEffectLevel, 'none');
  assert.equal(askUserTool.requiresApproval, false);
  assert.equal(askUserTool.endsTurnAfterSuccess, true);
  assert.equal(askUserTool.recoveryStrategy, 'replay_safe');
});

void test('builtin registry가 ask_user를 노출한다', () => {
  const registry = createBuiltinToolRegistryStore();
  assert.ok(registry.getTool('ask_user'));
  assert.equal(registry.getToolMeta('ask_user')?.endsTurnAfterSuccess, true);
});

void test('질문과 옵션 수를 확인 응답으로 돌려준다', async () => {
  const result = await askUserTool.execute(
    {
      question: '어느 저장소에 돌릴까요?',
      options: [
        { label: '각 도구를 자기 레포에', description: '기본 제안' },
        { label: '둘 다 같은 샘플 레포에' },
      ],
    },
    { callId: 'call_1' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output), {
    asked: true,
    purpose: 'decision',
    optionCount: 2,
  });
});

void test('심층 계획의 목표 이해 확인 목적을 보존한다', async () => {
  const result = await askUserTool.execute(
    {
      purpose: 'understanding_confirmation',
      question: '제가 이해한 목표가 맞나요?',
      options: [{ label: '맞아요' }, { label: '수정할게요' }],
    },
    { callId: 'call_understanding' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.output), {
    asked: true,
    purpose: 'understanding_confirmation',
    optionCount: 2,
  });
});

void test('공백 질문은 실패한다', async () => {
  const result = await askUserTool.execute(
    { question: '   ', options: [{ label: 'x' }] },
    { callId: 'call_2' },
  );
  assert.equal(result.ok, false);
});
