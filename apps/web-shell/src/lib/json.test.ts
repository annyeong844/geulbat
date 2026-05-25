import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRecord,
  tryDecodeJson,
  tryParseJson,
  tryParseJsonRecord,
  tryParseJsonWithGuard,
} from '@geulbat/protocol/runtime-utils';

void test('isRecord rejects arrays', () => {
  assert.equal(isRecord([]), false);
});

void test('tryParseJson returns parsed unknown value', () => {
  const parsed = tryParseJson('{"ok":true}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.deepEqual(parsed.value, { ok: true });
});

void test('tryParseJsonRecord rejects arrays and malformed text', () => {
  assert.deepEqual(tryParseJsonRecord('[]'), { ok: false });
  assert.deepEqual(tryParseJsonRecord('{'), { ok: false });
});

void test('tryParseJsonWithGuard narrows parsed values with a guard', () => {
  const parsed = tryParseJsonWithGuard(
    '{"message":"ok"}',
    (value): value is { message: string } =>
      isRecord(value) && typeof value.message === 'string',
  );
  assert.deepEqual(parsed, { ok: true, value: { message: 'ok' } });
});

void test('tryDecodeJson returns decoded values and catches decoder failures', () => {
  const parsed = tryDecodeJson('{"count":2}', (value) => {
    if (!isRecord(value) || typeof value.count !== 'number') {
      throw new Error('bad');
    }
    return { doubled: value.count * 2 };
  });
  assert.deepEqual(parsed, { ok: true, value: { doubled: 4 } });
  assert.deepEqual(
    tryDecodeJson('{"count":"x"}', (value) => {
      if (!isRecord(value) || typeof value.count !== 'number') {
        throw new Error('bad');
      }
      return value.count;
    }),
    { ok: false },
  );
});
