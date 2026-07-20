import assert from 'node:assert/strict';
import test from 'node:test';

import {
  toIdentifier,
  toKebabFileStem,
  toPascalCase,
} from './projection-naming.js';

void test('projection naming derives stable kebab file stems', () => {
  assert.equal(toKebabFileStem('fetch_url'), 'fetch-url');
  assert.equal(toKebabFileStem('readHTTPResponse'), 'read-httpresponse');
  assert.equal(toKebabFileStem(' apply patch! '), 'apply-patch');
});

void test('projection naming derives safe identifiers with fallback', () => {
  assert.equal(toIdentifier('fetch_url', 'tool'), 'fetchUrl');
  assert.equal(toIdentifier('123 invalid', 'tool'), 'tool');
  assert.equal(toIdentifier('!!!', 'tool'), 'tool');
});

void test('projection naming derives PascalCase names', () => {
  assert.equal(toPascalCase('fetch_url'), 'FetchUrl');
  assert.equal(toPascalCase('apply-patch'), 'ApplyPatch');
  assert.equal(toPascalCase('!!!'), 'Tool');
});
