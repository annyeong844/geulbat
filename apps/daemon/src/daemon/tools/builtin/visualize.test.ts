import assert from 'node:assert/strict';
import test from 'node:test';

import { createBuiltinToolRegistryStore } from './catalog.js';
import { visualizeTool } from './visualize.js';

void test('visualize는 code 필수 스키마를 노출한다', () => {
  const parameters = visualizeTool.parameters;
  assert.equal(visualizeTool.name, 'visualize');
  assert.ok('type' in parameters);
  assert.equal(parameters.type, 'object');
  assert.deepEqual(parameters.required, ['code']);
  assert.deepEqual(Object.keys(parameters.properties), ['code', 'title']);
  assert.equal(visualizeTool.sideEffectLevel, 'none');
  assert.equal(visualizeTool.requiresApproval, false);
  assert.equal(visualizeTool.mayMutateComputerFiles, false);
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
