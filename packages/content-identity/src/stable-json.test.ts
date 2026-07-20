import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256StableJson, stableStringify } from './stable-json.js';

void test('stableStringify sorts object keys and renders undefined as null by default', () => {
  assert.equal(
    stableStringify({
      c: null,
      b: undefined,
      a: [undefined],
    }),
    '{"a":[null],"b":null,"c":null}',
  );
});

void test('stableStringify can omit undefined object keys without changing array holes', () => {
  assert.equal(
    stableStringify(
      {
        c: null,
        b: undefined,
        a: [undefined],
      },
      { omitUndefinedObjectKeys: true },
    ),
    '{"a":[null],"c":null}',
  );
});

void test('sha256StableJson hashes the canonical UTF-8 JSON bytes', () => {
  assert.equal(
    sha256StableJson({ a: 1 }),
    '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
  );
  assert.equal(
    sha256StableJson(
      {
        c: null,
        b: undefined,
        a: [undefined],
      },
      { omitUndefinedObjectKeys: true },
    ),
    '969b837877a839359ccc883c280853bd65f5f5a825461ebf029af309dde1488c',
  );
});
