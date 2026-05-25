import test from 'node:test';
import assert from 'node:assert/strict';
import { isProjectId } from '@geulbat/protocol/ids';
import { deriveProjectId } from './project-id-slug.js';

void test('deriveProjectId slugifies labels into stable project ids', () => {
  assert.equal(deriveProjectId('My Novel Draft', new Set()), 'my-novel-draft');
  assert.equal(deriveProjectId('   원고 보드   ', new Set()), '원고-보드');
});

void test('deriveProjectId appends deterministic numeric suffixes on collision', () => {
  const existing = new Set(['workspace', 'project', 'project-2']);

  assert.equal(deriveProjectId('Project', existing), 'project-3');
});

void test('deriveProjectId keeps long generated ids inside the ProjectId contract', () => {
  const projectId = deriveProjectId('Chapter '.repeat(40), new Set());

  assert.equal(isProjectId(projectId), true);
});

void test('deriveProjectId reserves suffix room when a long generated id collides', () => {
  const firstProjectId = deriveProjectId('Archive '.repeat(40), new Set());
  const secondProjectId = deriveProjectId(
    'Archive '.repeat(40),
    new Set([firstProjectId]),
  );

  assert.equal(isProjectId(secondProjectId), true);
  assert.equal(secondProjectId.endsWith('-2'), true);
});
