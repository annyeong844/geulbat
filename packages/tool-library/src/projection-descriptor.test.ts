import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOOL_LIBRARY_PROJECTION_SIDE_EFFECT_LEVELS,
  isToolLibraryProjectionObjectParameters,
  type ToolLibraryProjectionParameters,
} from './projection-descriptor-internal.js';

void test('projection descriptor owns side-effect vocabulary', () => {
  assert.deepEqual(TOOL_LIBRARY_PROJECTION_SIDE_EFFECT_LEVELS, [
    'none',
    'read',
    'write',
    'destructive',
  ]);
});

void test('projection descriptor detects object parameters', () => {
  const objectParameters: ToolLibraryProjectionParameters = {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
    additionalProperties: false,
  };
  const anyOfParameters: ToolLibraryProjectionParameters = {
    anyOf: [objectParameters],
  };

  assert.equal(isToolLibraryProjectionObjectParameters(objectParameters), true);
  assert.equal(isToolLibraryProjectionObjectParameters(anyOfParameters), false);
});
