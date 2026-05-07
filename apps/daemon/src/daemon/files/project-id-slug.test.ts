import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveProjectId } from './project-id-slug.js';

void test('deriveProjectId slugifies labels into stable project ids', () => {
  assert.equal(deriveProjectId('My Novel Draft', new Set()), 'my-novel-draft');
  assert.equal(deriveProjectId('   원고 보드   ', new Set()), '원고-보드');
});

void test('deriveProjectId appends deterministic numeric suffixes on collision', () => {
  const existing = new Set(['workspace', 'project', 'project-2']);

  assert.equal(deriveProjectId('Project', existing), 'project-3');
});
