import assert from 'node:assert/strict';
import test from 'node:test';

import { suggestFollowupTool } from './suggest-followup.js';

void test('suggest_followup neither mutates nor requires approval', () => {
  assert.equal(suggestFollowupTool.name, 'suggest_followup');
  assert.equal(suggestFollowupTool.sideEffectLevel, 'none');
  assert.equal(suggestFollowupTool.mayMutateComputerFiles, false);
  assert.equal(suggestFollowupTool.requiresApproval, false);
  assert.equal(suggestFollowupTool.recoveryStrategy, 'replay_safe');
});

void test('suggest_followup takes exactly one prompt and rejects an empty one', () => {
  const parameters = suggestFollowupTool.parameters as {
    properties: Record<string, unknown>;
    required?: string[];
  };
  assert.deepEqual(Object.keys(parameters.properties), ['prompt']);
  assert.deepEqual(parameters.required, ['prompt']);
});
