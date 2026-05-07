import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getConfiguredDevToken,
  isValidDevToken,
  MIN_DEV_TOKEN_LENGTH,
} from './token.js';

void test('getConfiguredDevToken requires env', () => {
  const previous = process.env['GEULBAT_DEV_TOKEN'];
  delete process.env['GEULBAT_DEV_TOKEN'];
  try {
    assert.throws(
      () => getConfiguredDevToken(),
      /GEULBAT_DEV_TOKEN is required/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env['GEULBAT_DEV_TOKEN'];
    } else {
      process.env['GEULBAT_DEV_TOKEN'] = previous;
    }
  }
});

void test('getConfiguredDevToken rejects short tokens', () => {
  const previous = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = 'too-short-token';
  try {
    assert.throws(
      () => getConfiguredDevToken(),
      new RegExp(
        `GEULBAT_DEV_TOKEN must be at least ${MIN_DEV_TOKEN_LENGTH} characters`,
      ),
    );
  } finally {
    if (previous === undefined) {
      delete process.env['GEULBAT_DEV_TOKEN'];
    } else {
      process.env['GEULBAT_DEV_TOKEN'] = previous;
    }
  }
});

void test('isValidDevToken only accepts exact configured token', () => {
  const previous = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = 'test-token-123456';
  try {
    assert.equal(isValidDevToken('test-token-123456'), true);
    assert.equal(isValidDevToken('wrong-token'), false);
    assert.equal(isValidDevToken(['test-token-123456']), false);
  } finally {
    if (previous === undefined) {
      delete process.env['GEULBAT_DEV_TOKEN'];
    } else {
      process.env['GEULBAT_DEV_TOKEN'] = previous;
    }
  }
});
