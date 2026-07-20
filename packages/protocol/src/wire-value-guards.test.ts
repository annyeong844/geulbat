import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isBoolean,
  isNumber,
  isPlainRecord,
  isRecord,
  isString,
} from './wire-value-guards.js';

void test('wire record guards distinguish records from arrays and class instances', () => {
  class Example {}

  assert.equal(isRecord({ ok: true }), true);
  assert.equal(isRecord(Object.create(null)), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);

  assert.equal(isPlainRecord({ ok: true }), true);
  assert.equal(isPlainRecord(Object.create(null)), true);
  assert.equal(isPlainRecord(new Example()), false);
  assert.equal(isPlainRecord([]), false);
});

void test('wire scalar guards accept only their finite runtime shapes', () => {
  assert.equal(isString('value'), true);
  assert.equal(isString(1), false);
  assert.equal(isNumber(1), true);
  assert.equal(isNumber(Number.NaN), false);
  assert.equal(isNumber(Number.POSITIVE_INFINITY), false);
  assert.equal(isBoolean(false), true);
  assert.equal(isBoolean('false'), false);
});
