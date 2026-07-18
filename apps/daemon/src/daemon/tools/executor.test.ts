import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { executeTool } from './executor.js';
import { createToolRegistryStore } from './registry.js';
import type {
  AnyTool,
  ExecuteResult,
  ToolExecutionContext,
  ToolParseResult,
} from './types.js';

function makeTool<TArgs extends object>(options: {
  name: string;
  parseArgs?: (raw: unknown) => ToolParseResult<TArgs>;
  executeParsed?: (
    args: TArgs,
    ctx: ToolExecutionContext,
  ) => Promise<ExecuteResult>;
  sideEffectLevel?: AnyTool['sideEffectLevel'];
  mayMutateComputerFiles?: boolean;
  timeoutMs?: number;
  omitTimeout?: boolean;
  requiresApproval?: boolean;
}): AnyTool {
  return {
    name: options.name,
    description: 'test',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: options.sideEffectLevel ?? 'none',
    mayMutateComputerFiles: options.mayMutateComputerFiles ?? false,
    ...(options.omitTimeout ? {} : { timeoutMs: options.timeoutMs ?? 1_000 }),
    requiresApproval: options.requiresApproval ?? false,
    parseArgs: options.parseArgs ?? (() => ({ ok: true, value: {} as TArgs })),
    executeParsed:
      options.executeParsed ??
      (async () => ({
        ok: true,
        output: 'ok',
      })),
  };
}

void test('executeTool supports tools without a watchdog timeout', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool(
    makeTool({
      name: 'no_timeout_executor_tool',
      omitTimeout: true,
      async executeParsed(_args, ctx) {
        assert.equal(ctx.signal, undefined);
        return {
          ok: true,
          output: 'ok',
        };
      },
    }),
  );

  const result = await executeTool(
    'no_timeout_executor_tool',
    {},
    {
      callId: 'call_no_timeout',
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: true,
    output: 'ok',
  });
});

void test('executeTool preserves tool-level failure results without wrapping them as success', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool(
    makeTool({
      name: 'failing_tool_for_executor_test',
      async executeParsed() {
        return {
          ok: false,
          output: '',
          errorCode: 'conflict_stale_write',
          error: 'stale write',
        };
      },
    }),
  );

  const result = await executeTool(
    'failing_tool_for_executor_test',
    {},
    {
      callId: 'call_1',
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'conflict_stale_write',
    error: 'stale write',
  });
});

void test('executeTool preserves curated image-generation failure messages', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool(
    makeTool({
      name: 'image_failure_tool_for_executor_test',
      async executeParsed() {
        return {
          ok: false,
          output:
            '{"ok":false,"error":"provider_auth/provider_not_connected: image provider grok_oauth is not connected"}',
          errorCode: 'image_provider_unavailable',
          error:
            'provider_auth/provider_not_connected: image provider grok_oauth is not connected',
        };
      },
    }),
  );

  const result = await executeTool(
    'image_failure_tool_for_executor_test',
    {},
    {
      callId: 'call_image_failure',
    },
    { toolRegistry: store },
  );

  // §4.4: 분류 코드는 안전 목록이라 큐레이션 메시지가 삼켜지지 않는다
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'image_provider_unavailable');
  assert.equal(
    result.error,
    'provider_auth/provider_not_connected: image provider grok_oauth is not connected',
  );
});

void test('executeTool sanitizes unsafe tool-level failure result messages', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool(
    makeTool({
      name: 'unsafe_result_tool_for_executor_test',
      async executeParsed() {
        return {
          ok: false,
          output: '',
          errorCode: 'execution_failed',
          error:
            "EACCES: permission denied, open '/tmp/private/workspace/file.txt'",
        };
      },
    }),
  );

  const result = await executeTool(
    'unsafe_result_tool_for_executor_test',
    {},
    {
      callId: 'call_unsafe_result',
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'execution_failed',
    error: 'tool "unsafe_result_tool_for_executor_test" execution failed',
  });
});

void test('executeTool preserves safe not_found tool-level failure messages', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool(
    makeTool({
      name: 'not_found_result_tool_for_executor_test',
      async executeParsed() {
        return {
          ok: false,
          output: '',
          errorCode: 'not_found',
          error: 'Task missing-id not found.',
        };
      },
    }),
  );

  const result = await executeTool(
    'not_found_result_tool_for_executor_test',
    {},
    {
      callId: 'call_not_found_result',
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'not_found',
    error: 'Task missing-id not found.',
  });
});

void test('executeTool returns invalid_args when parseArgs rejects user input', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool(
    makeTool({
      name: 'parse_failure_executor_tool',
      parseArgs() {
        return { ok: false, message: 'path is required.' };
      },
      async executeParsed() {
        throw new Error('should not run');
      },
    }),
  );

  const result = await executeTool(
    'parse_failure_executor_tool',
    {},
    {
      callId: 'call_parse_failure',
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'invalid_args',
    error: 'path is required.',
  });
});

void test('executeTool treats parseArgs throws as implementation bugs instead of invalid_args', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  store.registerTool(
    makeTool({
      name: 'parse_throw_executor_tool',
      parseArgs() {
        throw new Error('/private/trace');
      },
    }),
  );

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  let result: ExecuteResult;
  try {
    result = await executeTool(
      'parse_throw_executor_tool',
      {},
      {
        callId: 'call_parse_throw',
      },
      { toolRegistry: store },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'execution_failed',
    error: 'tool "parse_throw_executor_tool" execution failed',
  });
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0]), /unexpected tool failure/);
  assert.deepEqual(warnings[0]?.[1], {
    tool: 'parse_throw_executor_tool',
    callId: 'call_parse_throw',
    errorCode: 'execution_failed',
    cause: '/private/trace',
  });
});

void test('executeTool preserves safe app error codes thrown from parseArgs', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool(
    makeTool({
      name: 'parse_throw_invalid_args_executor_tool',
      parseArgs() {
        throw Object.assign(new Error('path is required.'), {
          code: 'invalid_args',
        });
      },
    }),
  );

  const result = await executeTool(
    'parse_throw_invalid_args_executor_tool',
    {},
    {
      callId: 'call_parse_throw_invalid_args',
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'invalid_args',
    error: 'path is required.',
  });
});

void test('executeTool fails closed when approval is required but not granted', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool(
    makeTool({
      name: 'approval_tool_for_executor_test',
      sideEffectLevel: 'write',
      requiresApproval: true,
      async executeParsed() {
        return {
          ok: true,
          output: 'should not run',
        };
      },
    }),
  );

  const result = await executeTool(
    'approval_tool_for_executor_test',
    {},
    {
      callId: 'call_2',
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'approval_required',
    error: 'tool "approval_tool_for_executor_test" requires approval',
  });
});

void test('executeTool sanitizes unknown internal tool errors', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  store.registerTool(
    makeTool({
      name: 'throwing_tool_for_executor_test',
      async executeParsed() {
        throw new Error('/absolute/private/path leaked');
      },
    }),
  );

  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  let result: ExecuteResult;
  try {
    result = await executeTool(
      'throwing_tool_for_executor_test',
      {},
      {
        callId: 'call_3',
      },
      { toolRegistry: store },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'execution_failed',
    error: 'tool "throwing_tool_for_executor_test" execution failed',
  });
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0]), /unexpected tool failure/);
  assert.deepEqual(warnings[0]?.[1], {
    tool: 'throwing_tool_for_executor_test',
    callId: 'call_3',
    errorCode: 'execution_failed',
    cause: '/absolute/private/path leaked',
  });
});

void test('executeTool rejects invalid runtime result shapes from tools', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool(
    makeTool({
      name: 'invalid_shape_tool_for_executor_test',
      async executeParsed() {
        return { ok: true, output: 123 } as unknown as ExecuteResult;
      },
    }),
  );

  const result = await executeTool(
    'invalid_shape_tool_for_executor_test',
    {},
    {
      callId: 'call_4',
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'execution_failed',
    error:
      'tool "invalid_shape_tool_for_executor_test" returned an invalid result',
  });
});

void test('executeTool can resolve tools from an injected registry without touching the default registry', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  store.registerTool(
    makeTool({
      name: 'local_registry_only_executor_tool',
      async executeParsed() {
        return {
          ok: true,
          output: 'from local registry',
        };
      },
    }),
  );

  const result = await executeTool(
    'local_registry_only_executor_tool',
    {},
    {
      callId: 'call_5',
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: true,
    output: 'from local registry',
  });
});

void test('executeTool preserves the raw runSignal while wrapping signal with the per-tool watchdog', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  const controller = new AbortController();
  let capturedContext: ToolExecutionContext | undefined;
  store.registerTool(
    makeTool({
      name: 'signal_contract_executor_tool',
      async executeParsed(_args, ctx) {
        capturedContext = ctx;
        return {
          ok: true,
          output: 'signal-contract-ok',
        };
      },
    }),
  );

  const result = await executeTool(
    'signal_contract_executor_tool',
    {},
    {
      callId: 'call_signal_contract',
      signal: controller.signal,
      runSignal: controller.signal,
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: true,
    output: 'signal-contract-ok',
  });
  assert.ok(capturedContext);
  assert.notEqual(capturedContext.signal, controller.signal);
  assert.equal(capturedContext.runSignal, controller.signal);
  assert.equal(capturedContext.signal?.aborted, false);
  assert.equal(capturedContext.runSignal?.aborted, false);
});

void test('executeTool timeout aborts the per-tool signal without mutating the raw runSignal', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  const controller = new AbortController();
  let capturedContext: ToolExecutionContext | undefined;
  store.registerTool(
    makeTool({
      name: 'timeout_signal_contract_executor_tool',
      timeoutMs: 10,
      async executeParsed(_args, ctx) {
        capturedContext = ctx;
        await delay(50);
        return {
          ok: true,
          output: 'should-timeout',
        };
      },
    }),
  );

  const result = await executeTool(
    'timeout_signal_contract_executor_tool',
    {},
    {
      callId: 'call_timeout_signal_contract',
      signal: controller.signal,
      runSignal: controller.signal,
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'timeout',
    error: 'tool "timeout_signal_contract_executor_tool" timed out (10ms)',
  });
  assert.ok(capturedContext);
  assert.equal(capturedContext.signal?.aborted, true);
  assert.equal(capturedContext.runSignal, controller.signal);
  assert.equal(capturedContext.runSignal?.aborted, false);
});

void test('executeTool does not enter a tool when the caller signal is already aborted', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  const controller = new AbortController();
  let executionCount = 0;
  store.registerTool(
    makeTool({
      name: 'caller_pre_aborted_executor_tool',
      omitTimeout: true,
      async executeParsed() {
        executionCount += 1;
        return { ok: true, output: 'unexpected execution' };
      },
    }),
  );
  controller.abort();

  const result = await executeTool(
    'caller_pre_aborted_executor_tool',
    {},
    {
      callId: 'call_caller_pre_aborted',
      signal: controller.signal,
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'aborted',
    error: 'tool execution cancelled',
  });
  assert.equal(executionCount, 0);
});

void test('executeTool classifies caller aborts before tool completion as cancellation', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  const controller = new AbortController();
  store.registerTool(
    makeTool({
      name: 'caller_abort_pending_executor_tool',
      omitTimeout: true,
      async executeParsed() {
        await delay(50);
        return {
          ok: true,
          output: 'should-not-complete',
        };
      },
    }),
  );

  const waiting = executeTool(
    'caller_abort_pending_executor_tool',
    {},
    {
      callId: 'call_caller_abort_pending',
      signal: controller.signal,
    },
    { toolRegistry: store },
  );

  await delay(0);
  controller.abort();

  assert.deepEqual(await waiting, {
    ok: false,
    output: '',
    errorCode: 'aborted',
    error: 'tool execution cancelled',
  });
});

void test('executeTool classifies thrown-after-caller-abort as cancellation', async () => {
  const store = createToolRegistryStore({ builtins: [] });
  const controller = new AbortController();
  store.registerTool(
    makeTool({
      name: 'caller_abort_throw_executor_tool',
      omitTimeout: true,
      async executeParsed() {
        controller.abort();
        throw new Error('throw after abort');
      },
    }),
  );

  const result = await executeTool(
    'caller_abort_throw_executor_tool',
    {},
    {
      callId: 'call_caller_abort_throw',
      signal: controller.signal,
    },
    { toolRegistry: store },
  );

  assert.deepEqual(result, {
    ok: false,
    output: '',
    errorCode: 'aborted',
    error: 'tool execution cancelled',
  });
});
