import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProjectId } from '@geulbat/protocol/ids';
import type { ProjectListItem } from '@geulbat/protocol/projects';
import {
  getDefaultProjectDeleteConflictMessage,
  getDefaultProjectRenameConflictMessage,
} from '@geulbat/protocol/projects';
import {
  assertProjectCanBeMutated,
  findProjectIndexOrThrow,
  normalizeProjectLabel,
} from './project-mutation-policy.js';
import { DEFAULT_PROJECT_ID } from './project-registry-state.js';

const CUSTOM_PROJECT_ID = 'manuscript' as ProjectId;

function assertCodedError(
  error: unknown,
  code: string,
  message: string,
): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.message, message);
  assert.equal((error as { code?: unknown }).code, code);
  return true;
}

void test('normalizeProjectLabel trims labels and rejects blank input before persistence', () => {
  assert.equal(normalizeProjectLabel('  Alpha Route  '), 'Alpha Route');
  assert.throws(
    () => normalizeProjectLabel(' \t\n '),
    (error: unknown) =>
      assertCodedError(error, 'bad_request', 'label is required'),
  );
});

void test('assertProjectCanBeMutated blocks default project rename and delete', () => {
  assert.throws(
    () => assertProjectCanBeMutated(DEFAULT_PROJECT_ID, 'rename'),
    (error: unknown) =>
      assertCodedError(
        error,
        'conflict',
        getDefaultProjectRenameConflictMessage(),
      ),
  );
  assert.throws(
    () => assertProjectCanBeMutated(DEFAULT_PROJECT_ID, 'delete'),
    (error: unknown) =>
      assertCodedError(
        error,
        'conflict',
        getDefaultProjectDeleteConflictMessage(),
      ),
  );

  assert.doesNotThrow(() =>
    assertProjectCanBeMutated(CUSTOM_PROJECT_ID, 'rename'),
  );
  assert.doesNotThrow(() =>
    assertProjectCanBeMutated(CUSTOM_PROJECT_ID, 'delete'),
  );
});

void test('findProjectIndexOrThrow keeps unknown project failures on the mutation policy owner', () => {
  const projects: ProjectListItem[] = [
    { projectId: DEFAULT_PROJECT_ID, label: 'Workspace' },
    { projectId: CUSTOM_PROJECT_ID, label: 'Manuscript' },
  ];

  assert.equal(findProjectIndexOrThrow(projects, CUSTOM_PROJECT_ID), 1);
  assert.throws(
    () => findProjectIndexOrThrow(projects, 'missing-project' as ProjectId),
    (error: unknown) =>
      assertCodedError(
        error,
        'not_found',
        'unknown projectId: missing-project',
      ),
  );
});
