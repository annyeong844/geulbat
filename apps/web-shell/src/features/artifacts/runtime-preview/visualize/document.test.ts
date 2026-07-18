import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildVisualizeWidgetDocument } from './document.js';

void test('위젯 문서는 코드 조각을 투명 배경 본문에 담는다', () => {
  const document = buildVisualizeWidgetDocument({
    mode: 'svg',
    code: '<svg viewBox="0 0 10 10"><g class="node c-teal"></g></svg>',
    title: '파이프라인',
  });

  // SVG는 점진 렌더 경로 — 코드가 escape된 페이로드로 실려 천천히 주입된다
  assert.match(document, /geulbat-visualize-root/);
  assert.match(document, /\\u003Csvg viewBox=/);
  assert.match(document, /prefers-reduced-motion/);
  assert.match(document, /background: transparent/);
  assert.match(document, /<title>파이프라인<\/title>/);
  // 프리셋 클래스와 #arrow 마커가 미리 깔려 있어야 위젯 코드가 바로 쓴다
  assert.match(document, /\.th \{/);
  assert.match(document, /\.c-teal rect/);
  assert.match(document, /<marker id="arrow"/);
});

void test('스크립트를 품은 HTML 조각은 점진 주입 없이 직접 심는다', () => {
  const document = buildVisualizeWidgetDocument({
    mode: 'html',
    code: '<div id="w"></div><script>document.getElementById("w").textContent = "hi";</script>',
    title: null,
  });

  // innerHTML 주입은 <script>를 실행하지 않으므로 직접 임베드 경로여야 한다
  assert.match(
    document,
    /<div class="geulbat-visualize-root"><div id="w"><\/div>/,
  );
  assert.doesNotMatch(document, /prefers-reduced-motion/);
});

void test('title이 없으면 기본 제목을 escape해서 쓴다', () => {
  const document = buildVisualizeWidgetDocument({
    mode: 'html',
    code: '<p>hi</p>',
    title: null,
  });
  assert.match(document, /<title>visualize widget<\/title>/);
});

void test('title의 마크업 문자는 escape된다', () => {
  const document = buildVisualizeWidgetDocument({
    mode: 'html',
    code: '<p>hi</p>',
    title: '<script>x</script>',
  });
  assert.match(document, /<title>&lt;script&gt;x&lt;\/script&gt;<\/title>/);
});
