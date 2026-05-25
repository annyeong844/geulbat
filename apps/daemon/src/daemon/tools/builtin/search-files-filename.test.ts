import test from 'node:test';
import assert from 'node:assert/strict';

import { filenameSearch } from './search-files-filename.js';

void test('filenameSearch skips missing directories during traversal churn', async () => {
  const result = await filenameSearch(
    '/workspace',
    '/workspace',
    null,
    null,
    10,
    {
      readdir: async () => {
        const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
        throw error;
      },
    },
  );

  assert.equal(result.total, 0);
  assert.deepEqual(result.results, []);
  assert.equal(result.truncated, false);
});

void test('filenameSearch surfaces unexpected directory I/O failures', async () => {
  await assert.rejects(
    () =>
      filenameSearch('/workspace', '/workspace', null, null, 10, {
        readdir: async () => {
          const error = Object.assign(new Error('denied'), { code: 'EACCES' });
          throw error;
        },
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'EACCES');
      return true;
    },
  );
});
