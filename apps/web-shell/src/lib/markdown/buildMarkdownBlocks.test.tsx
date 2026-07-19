import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  buildMarkdownBlocks,
  prepareMarkdownBlocks,
} from './buildMarkdownBlocks.js';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

void test('buildMarkdownBlocks renders CommonMark prose and GFM tables semantically', () => {
  const html = renderMarkdown(
    [
      '# 계약 점검',
      '',
      '**굵게**, *기울임*, ~~삭제~~, `inline()`',
      '',
      '> 실제 경계를 확인합니다.',
      '',
      '1. 첫 단계',
      '2. 둘째 단계',
      '',
      '- 안전',
      '- 진단 가능',
      '',
      '| 항목 | 판정 | 증거 |',
      '|:---|:---:|---:|',
      '| any / ts-ignore | ✅ healthy | `:any=0` |',
      '| type escape | ⚠ watch | 29 |',
    ].join('\n'),
  );

  assert.match(html, /<h1>계약 점검<\/h1>/);
  assert.match(html, /<strong>굵게<\/strong>/);
  assert.match(html, /<em>기울임<\/em>/);
  assert.match(html, /<del>삭제<\/del>/);
  assert.match(html, /rendered-markdown-code/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<ul>/);
  assert.match(html, /rendered-markdown-table-scroll/);
  assert.match(html, /<table class="rendered-markdown-table">/);
  assert.match(html, /<thead>/);
  assert.match(html, /<th style="text-align:center">판정<\/th>/);
  assert.match(html, /<td style="text-align:right">29<\/td>/);
});

void test('buildMarkdownBlocks keeps fenced code and incomplete Markdown renderable', () => {
  const html = renderMarkdown(
    ['```ts', 'const value = 1;', '```', '', '**아직 닫히지 않음'].join('\n'),
  );

  assert.match(html, /rendered-markdown-code-block/);
  assert.match(html, /language-ts/);
  assert.match(html, /const value = 1;/);
  assert.match(html, /\*\*아직 닫히지 않음/);
});

void test('buildMarkdownBlocks allows explicit safe links without activating unsafe content', () => {
  const html = renderMarkdown(
    [
      '[공식 문서](https://example.com/docs)',
      '[메일](mailto:hello@example.com)',
      '[이 섹션](#section)',
      '[상대 경로](./admin)',
      '[스크립트](javascript:alert(1))',
      '[데이터](data:text/html,bad)',
      `[파일](${['file:', '///etc/passwd'].join('')})`,
      '[에디터](vscode://file/tmp/a)',
      '![원격 이미지](https://example.com/tracker.png)',
      '<script>alert(1)</script>',
      '<img src="https://example.com/tracker.png" onerror="alert(1)">',
    ].join('\n\n'),
  );

  assert.match(html, /href="https:\/\/example.com\/docs"/);
  assert.match(html, /href="mailto:hello@example.com"/);
  assert.match(html, /href="#section"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /href="\.\/admin"/);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /data:text/i);
  assert.doesNotMatch(html, /file:\/\//i);
  assert.doesNotMatch(html, /vscode:/i);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /rendered-markdown-image-alt/);
  assert.match(html, />원격 이미지<\/span>/);
});

void test('buildMarkdownBlocks preserves references across top-level blocks', () => {
  const html = renderMarkdown(
    [
      '[공식 문서][docs]에서 계약을 확인합니다.',
      '',
      '> 다음 블록도 같은 문서의 일부입니다.',
      '',
      '[docs]: https://example.com/docs "공식"',
    ].join('\n'),
  );

  assert.match(html, /href="https:\/\/example.com\/docs"/);
  assert.match(html, /title="공식"/);
  assert.match(html, /<blockquote>/);
  assert.doesNotMatch(html, /\[docs\]:/);
});

void test('prepared settled Markdown preserves semantic output across remounts', () => {
  const renderCacheOwner = {};
  const markdown = '**미리 준비한 답변**과 `cache()`';
  prepareMarkdownBlocks(renderCacheOwner, markdown);

  const first = renderToStaticMarkup(
    <>{buildMarkdownBlocks(markdown, renderCacheOwner)}</>,
  );
  const second = renderToStaticMarkup(
    <>{buildMarkdownBlocks(markdown, renderCacheOwner)}</>,
  );

  assert.equal(second, first);
  assert.match(first, /<strong>미리 준비한 답변<\/strong>/);
  assert.match(first, /rendered-markdown-code/);
});

void test('buildMarkdownBlocks preserves Markdown semantics across appended updates', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <>{buildMarkdownBlocks('첫 문단입니다.')}</>,
    );
  });
  await act(async () => {
    renderer.update(
      <>
        {buildMarkdownBlocks(
          ['첫 문단입니다.', '', '> 이어지는 인용문입니다.'].join('\n'),
        )}
      </>,
    );
  });
  await act(async () => {
    renderer.update(
      <>
        {buildMarkdownBlocks(
          [
            '첫 문단입니다.',
            '',
            '> 이어지는 인용문입니다.',
            '',
            '[공식 문서][docs]',
            '',
            '[docs]: https://example.com/docs',
          ].join('\n'),
        )}
      </>,
    );
  });

  const rendered = JSON.stringify(renderer.toJSON());
  assert.match(rendered, /첫 문단입니다/);
  assert.match(rendered, /이어지는 인용문입니다/);
  assert.match(rendered, /https:\/\/example\.com\/docs/);
  assert.doesNotMatch(rendered, /\[docs\]:/);

  await act(async () => {
    renderer.unmount();
  });
});

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(<>{buildMarkdownBlocks(markdown)}</>);
}
