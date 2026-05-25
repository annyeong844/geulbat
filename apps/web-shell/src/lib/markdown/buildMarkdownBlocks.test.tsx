import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { buildMarkdownBlocks } from './buildMarkdownBlocks.js';

void test('buildMarkdownBlocks closes language-tagged code fences on bare closing fences', () => {
  const blocks = buildMarkdownBlocks(
    ['```ts', 'const value = 1;', '```', 'after fence'].join('\n'),
  );

  assert.equal(blocks.length, 2);
  assert.equal(React.isValidElement(blocks[0]), true);
  assert.equal(React.isValidElement(blocks[1]), true);
  if (
    !React.isValidElement<{ children: React.ReactNode }>(blocks[0]) ||
    !React.isValidElement<{ children: React.ReactNode }>(blocks[1])
  ) {
    return;
  }

  assert.equal(blocks[0].type, 'pre');
  assert.equal(blocks[1].type, 'p');
  assert.equal(blocks[0].props.children, 'const value = 1;');
  assert.equal(blocks[1].props.children, 'after fence');
});

void test('buildMarkdownBlocks preserves mixed block order and children', () => {
  const blocks = buildMarkdownBlocks(
    [
      'intro line',
      'continued',
      '',
      '## Heading',
      '> quote A',
      '> quote B',
      '- one',
      '* two',
    ].join('\n'),
  );

  assert.equal(blocks.length, 4);
  const paragraph = getBlockElement(blocks, 0);
  const heading = getBlockElement(blocks, 1);
  const quote = getBlockElement(blocks, 2);
  const list = getBlockElement(blocks, 3);

  assert.equal(paragraph.type, 'p');
  assert.equal(paragraph.props.children, 'intro line continued');
  assert.equal(heading.type, 'div');
  assert.equal(heading.props.children, 'Heading');
  assert.equal(quote.type, 'blockquote');
  assert.equal(quote.props.children, 'quote A\nquote B');
  assert.equal(list.type, 'ul');
  assert.equal(Array.isArray(list.props.children), true);
});

function getBlockElement(blocks: readonly React.ReactNode[], index: number) {
  const block = blocks[index];
  assert.equal(
    React.isValidElement<{ children: React.ReactNode }>(block),
    true,
  );
  if (!React.isValidElement<{ children: React.ReactNode }>(block)) {
    throw new Error(`expected React element at index ${index}`);
  }
  return block;
}
