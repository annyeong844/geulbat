import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readBodyString,
  readRequiredBodyString,
  readRequiredBodyStrings,
  readRequiredQueryString,
} from './string-fields.js';

void test('readRequiredQueryString rejects arrays', () => {
  const result = readRequiredQueryString(['workspace'], 'projectId');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, 'projectId must be a single string');
  }
});

void test('readRequiredQueryString accepts single strings', () => {
  const result = readRequiredQueryString('workspace', 'projectId');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, 'workspace');
  }
});

void test('readRequiredBodyString rejects non-string content', () => {
  const result = readRequiredBodyString({ content: { text: 'hi' } }, 'content');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, 'content must be a string');
  }
});

void test('readBodyString accepts empty strings when the field is present', () => {
  const result = readBodyString({ versionToken: '' }, 'versionToken');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value, '');
  }
});

void test('readBodyString still rejects non-string values', () => {
  const result = readBodyString({ versionToken: 7 }, 'versionToken');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, 'versionToken must be a string');
  }
});

void test('readRequiredBodyStrings returns all required body fields together', () => {
  const result = readRequiredBodyStrings(
    {
      projectId: 'project',
      path: 'notes/todo.md',
      content: 'hello',
      versionToken: 'token-1',
    },
    ['projectId', 'path', 'content', 'versionToken'] as const,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.values, {
      projectId: 'project',
      path: 'notes/todo.md',
      content: 'hello',
      versionToken: 'token-1',
    });
  }
});

void test('readRequiredBodyStrings returns the first missing-field error', () => {
  const result = readRequiredBodyStrings(
    {
      projectId: 'project',
      path: 'notes/todo.md',
      content: '',
      versionToken: 'token-1',
    },
    ['projectId', 'path', 'content', 'versionToken'] as const,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.message, 'content is required');
  }
});
