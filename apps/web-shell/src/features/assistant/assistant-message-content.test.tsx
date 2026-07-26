import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ARTIFACT_END_MARKER,
  ARTIFACT_START_PREFIX,
} from '@geulbat/protocol/artifacts';

import {
  AssistantMessageContent,
  splitMessageContentSegments,
} from './assistant-message-content.js';

void test('splitMessageContentSegments separates fenced code from prose', () => {
  const segments = splitMessageContentSegments(
    ['설명 첫 줄', '```ts', "const x = 'y';", '```', '마무리 줄'].join('\n'),
  );

  assert.deepEqual(segments, [
    { kind: 'text', text: '설명 첫 줄' },
    { kind: 'code', language: 'ts', code: "const x = 'y';" },
    { kind: 'text', text: '마무리 줄' },
  ]);
});

void test('splitMessageContentSegments treats an unclosed fence as code (streaming tail)', () => {
  const segments = splitMessageContentSegments(
    ['앞 텍스트', '```', 'docs/SSoT.md'].join('\n'),
  );

  assert.deepEqual(segments, [
    { kind: 'text', text: '앞 텍스트' },
    { kind: 'code', language: null, code: 'docs/SSoT.md' },
  ]);
});

void test('splitMessageContentSegments keeps plain prose as a single segment', () => {
  assert.deepEqual(splitMessageContentSegments('그냥 텍스트'), [
    { kind: 'text', text: '그냥 텍스트' },
  ]);
});

void test('AssistantMessageContent renders code blocks with a copy affordance', () => {
  const html = renderToStaticMarkup(
    <AssistantMessageContent
      content={['설명', '```bash', 'npm run dev', '```'].join('\n')}
    />,
  );

  assert.match(html, /message-code-block/);
  assert.match(html, /npm run dev/);
  assert.match(html, /코드 복사/);
  assert.match(html, /bash/);
});

void test('AssistantMessageContent renders assistant prose as semantic GFM', () => {
  const html = renderToStaticMarkup(
    <AssistantMessageContent
      content={[
        '## D. 타입·계약',
        '',
        '**중요한 판정**과 `discipline.totals`',
        '',
        '| 항목 | 판정 | 증거 |',
        '|---|---|---|',
        '| any / ts-ignore | ✅ healthy | `:any=0` |',
      ].join('\n')}
    />,
  );

  assert.match(html, /message-markdown/);
  assert.match(html, /<h2>D\. 타입·계약<\/h2>/);
  assert.match(html, /<strong>중요한 판정<\/strong>/);
  assert.match(html, /rendered-markdown-table-scroll/);
  assert.match(html, /<table class="rendered-markdown-table">/);
  assert.doesNotMatch(html, /코드 복사/);
});

void test('AssistantMessageContent keeps an unclosed streaming fence copyable', () => {
  const html = renderToStaticMarkup(
    <AssistantMessageContent
      content={['앞 텍스트', '```ts', 'const pending = true;'].join('\n')}
    />,
  );

  assert.match(html, /<p>앞 텍스트<\/p>/);
  assert.match(html, /message-code-block/);
  assert.match(html, /const pending = true;/);
  assert.match(html, /코드 복사/);
  assert.match(html, />ts<\/span>/);
});

void test('AssistantMessageContent tolerates partial inline Markdown while streaming', () => {
  const html = renderToStaticMarkup(
    <AssistantMessageContent content="**아직 닫히지 않은 [링크](https://" />,
  );

  assert.match(html, /아직 닫히지 않은/);
  assert.doesNotMatch(html, /<a /);
});

void test('AssistantMessageContent preserves an opening artifact transport fragment as plain text', () => {
  const html = renderToStaticMarkup(
    <AssistantMessageContent
      content={`${ARTIFACT_START_PREFIX}{"renderer":"html5"} -->\n* { box-sizing: border-box; }`}
    />,
  );

  assert.match(html, /<pre/);
  assert.match(html, /&lt;!-- GEULBAT_ARTIFACT/);
  assert.match(html, /\* \{ box-sizing: border-box; \}/);
  assert.doesNotMatch(html, /<ul>/);
});

void test('AssistantMessageContent preserves a closing artifact transport fragment as plain text', () => {
  const html = renderToStaticMarkup(
    <AssistantMessageContent
      content={`<body><section>hello</section></body>\n${ARTIFACT_END_MARKER}`}
    />,
  );

  assert.match(html, /<pre/);
  assert.match(
    html,
    /&lt;body&gt;&lt;section&gt;hello&lt;\/section&gt;&lt;\/body&gt;/,
  );
  assert.match(html, /&lt;!-- \/GEULBAT_ARTIFACT --&gt;/);
  assert.doesNotMatch(html, /<body>/);
});
