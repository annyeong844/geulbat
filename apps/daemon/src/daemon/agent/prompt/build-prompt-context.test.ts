import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPromptContext } from './build-prompt-context.js';

void test('buildPromptContext emits deterministic empty sentinels', () => {
  assert.equal(
    buildPromptContext({
      currentFile: undefined,
      selection: undefined,
    }),
    [
      '<file-context>',
      'Current file: none',
      'Selection: none',
      '</file-context>',
    ].join('\n'),
  );
});

void test('buildPromptContext includes current file and selection metadata', () => {
  const promptContext = buildPromptContext({
    currentFile: '.\\drafts\\draft.md',
    selection: { startLine: 3, endLine: 4, text: 'hello' },
  });

  assert.equal(
    promptContext,
    [
      '<file-context>',
      'Current file: drafts/draft.md',
      'Selection: lines 3-4',
      '</file-context>',
    ].join('\n'),
  );
});
