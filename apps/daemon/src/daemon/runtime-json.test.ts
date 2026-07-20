import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isJsonValue,
  isPlainRecord,
  isRecord,
  isString,
  tryDecodeJson,
  tryParseJson,
  tryParseJsonRecord,
} from './runtime-json.js';

void test('daemon JSON guards enforce the local runtime shapes', () => {
  class Example {}

  assert.equal(isRecord({ ok: true }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isPlainRecord(Object.create(null)), true);
  assert.equal(isPlainRecord(new Example()), false);
  assert.equal(isString('value'), true);
  assert.equal(isString(1), false);
  assert.equal(isJsonValue({ nested: ['value', 1, false, null] }), true);
  assert.equal(isJsonValue({ invalid: new Date() }), false);
});

void test('daemon JSON parsing reports malformed and non-record values', () => {
  assert.deepEqual(tryParseJson('{'), { ok: false });
  assert.deepEqual(tryParseJsonRecord('[]'), { ok: false });
  assert.deepEqual(tryParseJsonRecord('{"ok":true}'), {
    ok: true,
    value: { ok: true },
  });
});

void test('daemon JSON decoding contains decoder failures', () => {
  assert.deepEqual(
    tryDecodeJson('{"count":2}', (value) => {
      if (!isRecord(value) || typeof value.count !== 'number') {
        throw new TypeError('count must be a number');
      }
      return value.count * 2;
    }),
    { ok: true, value: 4 },
  );
  assert.deepEqual(
    tryDecodeJson('{"count":"bad"}', (value) => {
      if (!isRecord(value) || typeof value.count !== 'number') {
        throw new TypeError('count must be a number');
      }
      return value.count;
    }),
    { ok: false },
  );
});
