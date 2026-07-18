import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectVisualizeWidgetMode,
  readVisualizeStreamViewFromArgsText,
  readVisualizeWidgetViewFromToolArgs,
  readVisualizeWidgetViewFromToolCallContent,
} from './visualize-widget-view.js';

void test('svg 코드는 svg 모드로, 그 외는 html 모드로 감지한다', () => {
  assert.equal(
    detectVisualizeWidgetMode('<svg viewBox="0 0 10 10"></svg>'),
    'svg',
  );
  assert.equal(detectVisualizeWidgetMode('  \n<SVG></SVG>'), 'svg');
  assert.equal(detectVisualizeWidgetMode('<div>hi</div>'), 'html');
});

void test('tool args에서 위젯 뷰를 읽는다', () => {
  assert.deepEqual(
    readVisualizeWidgetViewFromToolArgs({
      code: '<svg viewBox="0 0 10 10"></svg>',
      title: '파이프라인',
    }),
    {
      mode: 'svg',
      code: '<svg viewBox="0 0 10 10"></svg>',
      title: '파이프라인',
    },
  );
  assert.deepEqual(readVisualizeWidgetViewFromToolArgs({ code: '<p>x</p>' }), {
    mode: 'html',
    code: '<p>x</p>',
    title: null,
  });
});

void test('빈 코드나 비정형 args는 거부한다', () => {
  assert.equal(readVisualizeWidgetViewFromToolArgs({ code: '   ' }), null);
  assert.equal(readVisualizeWidgetViewFromToolArgs({ code: 7 }), null);
  assert.equal(readVisualizeWidgetViewFromToolArgs('not-a-record'), null);
  assert.equal(readVisualizeWidgetViewFromToolArgs(null), null);
});

void test('settled tool_call 메시지 content에서 위젯 뷰를 복원한다', () => {
  const content = JSON.stringify({
    id: 'entry-1',
    callId: 'call-1',
    tool: 'visualize',
    args: { code: '<svg viewBox="0 0 1 1"></svg>' },
  });

  assert.deepEqual(readVisualizeWidgetViewFromToolCallContent(content), {
    mode: 'svg',
    code: '<svg viewBox="0 0 1 1"></svg>',
    title: null,
  });
});

void test('다른 도구의 tool_call과 비 JSON content는 거부한다', () => {
  assert.equal(
    readVisualizeWidgetViewFromToolCallContent(
      JSON.stringify({ tool: 'read_file', args: { code: '<p>x</p>' } }),
    ),
    null,
  );
  assert.equal(readVisualizeWidgetViewFromToolCallContent('not json'), null);
});

void test('스트리밍 인자 프리픽스에서 code를 관용적으로 추출한다', () => {
  // 아직 닫히지 않은 code 문자열 — 이스케이프 포함 프리픽스 디코드
  assert.deepEqual(
    readVisualizeStreamViewFromArgsText(
      '{"title":"펠리컨","code":"<svg viewBox=\\"0 0 1 1\\">\\n<rect',
    ),
    {
      mode: 'svg',
      code: '<svg viewBox="0 0 1 1">\n<rect',
      title: '펠리컨',
    },
  );
  // 닫힌 값은 그대로
  assert.deepEqual(
    readVisualizeStreamViewFromArgsText('{"code":"<p>done</p>"}'),
    { mode: 'html', code: '<p>done</p>', title: null },
  );
  // 유니코드 이스케이프 프리픽스
  assert.deepEqual(readVisualizeStreamViewFromArgsText('{"code":"\\u003csvg'), {
    mode: 'svg',
    code: '<svg',
    title: null,
  });
});

void test('스트리밍 인자에 code가 아직 없으면 null', () => {
  assert.equal(readVisualizeStreamViewFromArgsText('{"title":"펠리'), null);
  assert.equal(readVisualizeStreamViewFromArgsText('{"code":'), null);
  assert.equal(readVisualizeStreamViewFromArgsText(''), null);
  // 미완성 title은 뷰에 싣지 않는다 (completeOnly)
  assert.deepEqual(
    readVisualizeStreamViewFromArgsText('{"code":"<p>x","title":"펠리'),
    { mode: 'html', code: '<p>x', title: null },
  );
});
