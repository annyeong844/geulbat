import assert from 'node:assert/strict';
import test from 'node:test';

import { defineParsedTool } from './parsed-tool.js';
import type { ToolExecutionContext, ToolParameters } from './types.js';

const emptyParameters: ToolParameters = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

const context: ToolExecutionContext = {
  callId: 'call-parsed-tool-test',
  workspaceRoot: '/tmp',
};

void test('defineParsedTool raw execute returns invalid_args for parser failures', async () => {
  let executed = false;
  const tool = defineParsedTool({
    name: 'manual_parse_failure_tool',
    description: 'test manual parse failure',
    parameters: emptyParameters,
    strict: true,
    sideEffectLevel: 'none',
    timeoutMs: 1_000,
    requiresApproval: false,
    parseArgs() {
      return { ok: false, message: 'path is required.' };
    },
    async executeParsed() {
      executed = true;
      return { ok: true, output: 'should not run' };
    },
  });

  const result = await tool.execute({}, context);

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'invalid_args',
    error: 'path is required.',
  });
  assert.equal(executed, false);
});

void test('defineParsedTool raw execute does not mask parser throws', async () => {
  const cause = new Error('private parser failure');
  const tool = defineParsedTool({
    name: 'manual_parse_throw_tool',
    description: 'test manual parse throw',
    parameters: emptyParameters,
    strict: true,
    sideEffectLevel: 'none',
    timeoutMs: 1_000,
    requiresApproval: false,
    parseArgs() {
      throw cause;
    },
    async executeParsed() {
      return { ok: true, output: 'should not run' };
    },
  });

  await assert.rejects(
    () => tool.execute({}, context),
    (error) => {
      assert.equal(error, cause);
      return true;
    },
  );
});

void test('defineParsedTool raw execute does not mask executeParsed throws', async () => {
  const cause = new Error('private execution failure');
  const tool = defineParsedTool({
    name: 'manual_execute_throw_tool',
    description: 'test manual execute throw',
    parameters: emptyParameters,
    strict: true,
    sideEffectLevel: 'none',
    timeoutMs: 1_000,
    requiresApproval: false,
    parseArgs() {
      return { ok: true, value: {} };
    },
    async executeParsed() {
      throw cause;
    },
  });

  await assert.rejects(
    () => tool.execute({}, context),
    (error) => {
      assert.equal(error, cause);
      return true;
    },
  );
});
