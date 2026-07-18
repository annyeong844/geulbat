import test from 'node:test';
import assert from 'node:assert/strict';

import { richMarkdownToHtml } from './rich-text-codec.js';

void test('richMarkdownToHtml renders the four supported formats', () => {
  assert.equal(richMarkdownToHtml('**굵게**'), '<strong>굵게</strong>');
  assert.equal(richMarkdownToHtml('*기울임*'), '<em>기울임</em>');
  assert.equal(richMarkdownToHtml('<u>밑줄</u>'), '<u>밑줄</u>');
  assert.equal(
    richMarkdownToHtml('<span style="color:#b14a3a">빨강</span>'),
    '<span style="color:#b14a3a">빨강</span>',
  );
});

void test('richMarkdownToHtml nests formats and keeps newlines', () => {
  assert.equal(
    richMarkdownToHtml('**굵고 <u>밑줄</u>**\n다음 줄'),
    '<strong>굵고 <u>밑줄</u></strong><br>다음 줄',
  );
});

void test('richMarkdownToHtml escapes everything else (no HTML injection)', () => {
  assert.equal(
    richMarkdownToHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;',
  );
  // 지원 외 스타일이 붙은 span도 리터럴로 보존
  assert.equal(
    richMarkdownToHtml('<span style="background:red">x</span>'),
    '&lt;span style="background:red"&gt;x&lt;/span&gt;',
  );
});

void test('richMarkdownToHtml renders selection font-size spans', () => {
  assert.equal(
    richMarkdownToHtml('<span style="font-size:24px">큰 글자</span>'),
    '<span style="font-size:24px">큰 글자</span>',
  );
});

void test('richMarkdownToHtml renders text-align blocks', () => {
  assert.equal(
    richMarkdownToHtml(
      '첫 줄\n<div style="text-align:center">가운데</div>\n다음 줄',
    ),
    '첫 줄<div style="text-align:center">가운데</div>다음 줄',
  );
});
