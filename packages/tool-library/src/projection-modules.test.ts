import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOOL_LIBRARY_PROJECTION_INDEX_MODULE,
  TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE,
  TOOL_LIBRARY_PROJECTION_SEARCH_RUNTIME_MODULE,
  buildToolLibraryProjectionModuleImportSpecifier,
} from './projection-modules.js';

void test('projection modules own import specifier derivation', () => {
  assert.equal(TOOL_LIBRARY_PROJECTION_INDEX_MODULE, 'index.js');
  assert.equal(TOOL_LIBRARY_PROJECTION_MANIFEST_MODULE, 'manifest.js');
  assert.equal(
    TOOL_LIBRARY_PROJECTION_SEARCH_RUNTIME_MODULE,
    'search-runtime.js',
  );

  assert.equal(
    buildToolLibraryProjectionModuleImportSpecifier({
      importSpecifier: '@geulbat/generated-tools',
      module: 'index.js',
    }),
    '@geulbat/generated-tools',
  );
  assert.equal(
    buildToolLibraryProjectionModuleImportSpecifier({
      importSpecifier: '@geulbat/generated-tools',
      module: 'search-runtime.js',
    }),
    '@geulbat/generated-tools/search-runtime',
  );
  assert.equal(
    buildToolLibraryProjectionModuleImportSpecifier({
      importSpecifier: '@geulbat/generated-tools',
      module: 'index.d.ts',
    }),
    '@geulbat/generated-tools/index.d.ts',
  );
});
