import test from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonContext } from '../../context.js';
import {
  PTC_EXECUTE_CODE_TOOL_NAME,
  PTC_EXECUTE_CODE_WAIT_TOOL_NAME,
  PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV,
  resolvePtcExecuteCodeWriteCallbackConfigFromEnv,
} from '../../ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import type { CallbackToolDispatcher } from '../types.js';
import {
  createPtcExecuteCodeCallbackBreakdown,
  createPtcExecuteCodeToolCallbackHandler,
  createPtcExecuteCodeToolCallbackHelp,
} from './execute-code-tool-callback.js';
import {
  isPtcExecuteCodeWriteCallbackToolMetaAllowed,
  resolvePtcExecuteCodeCallbackToolSurface,
} from './ptc-callback-tool-surface.js';

function makeCtx(
  daemonContext: ReturnType<typeof createDaemonContext>,
  overrides: {
    allowedRegistryNames?: readonly string[];
    callbackToolDispatcher?: CallbackToolDispatcher;
  } = {},
) {
  return {
    callId: 'outer-execute-code-call',
    stateRoot: '/workspace/home-state',

    workingDirectory: 'project',
    threadId: testThreadId(930),
    agentSpawnRuntime: daemonContext,
    ...overrides,
  };
}

async function withWriteCallbackEnv<T>(
  value: string | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = process.env[PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV];
  if (value === undefined) {
    delete process.env[PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV];
  } else {
    process.env[PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV] = value;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV];
    } else {
      process.env[PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV] = previous;
    }
  }
}

void test('write callback knob parses strictly and defaults to disabled', () => {
  assert.deepEqual(resolvePtcExecuteCodeWriteCallbackConfigFromEnv({}), {
    enabled: false,
  });
  for (const enabled of ['true', '1']) {
    assert.deepEqual(
      resolvePtcExecuteCodeWriteCallbackConfigFromEnv({
        [PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV]: enabled,
      }),
      { enabled: true },
    );
  }
  for (const disabled of ['false', '0']) {
    assert.deepEqual(
      resolvePtcExecuteCodeWriteCallbackConfigFromEnv({
        [PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV]: disabled,
      }),
      { enabled: false },
    );
  }
  for (const invalid of ['yes', 'on', '', '  ']) {
    assert.throws(
      () =>
        resolvePtcExecuteCodeWriteCallbackConfigFromEnv({
          [PTC_EXECUTE_CODE_WRITE_CALLBACK_ENABLED_ENV]: invalid,
        }),
      /invalid GEULBAT_PTC_WRITE_CALLBACK_ENABLED/u,
    );
  }
});

void test('write tier admits only the allowlist intersected with the meta invariant', () => {
  const daemonContext = createDaemonContext();
  const registry = daemonContext.toolRegistry;
  // A future write tool with the exact write/mutate/approval meta must not
  // join the surface without its own named slice.
  registry.registerTool({
    name: 'synthetic_future_write_tool',
    description: 'Synthetic write tool outside the W1 allowlist.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
    sideEffectLevel: 'write',
    mayMutateComputerFiles: true,
    requiresApproval: true,
    parseArgs: () => ({ ok: true, value: {} }),
    async executeParsed() {
      return { ok: true, output: 'never' };
    },
  });

  const surface = resolvePtcExecuteCodeCallbackToolSurface({
    registry,
    writeCallbackEnabled: true,
  });
  assert.equal(surface.writeTierEnabled, true);
  assert.equal(surface.allows('apply_patch'), true);
  assert.equal(surface.allowsWrite('apply_patch'), true);
  assert.equal(surface.allows('manage_files'), true);
  assert.equal(surface.allowsWrite('manage_files'), true);
  assert.equal(surface.allows('synthetic_future_write_tool'), false);
  assert.equal(surface.allows('write_file'), false);
  assert.equal(surface.allows('exec_command'), false);
  assert.equal(surface.allows(PTC_EXECUTE_CODE_TOOL_NAME), false);
  assert.equal(surface.allows(PTC_EXECUTE_CODE_WAIT_TOOL_NAME), false);
  assert.equal(surface.allowsWrite('read_file'), false);
  assert.equal(surface.allows('read_file'), true);

  const applyPatchHelp = surface.callbackTools.find(
    (tool) => tool.name === 'apply_patch',
  );
  assert.ok(applyPatchHelp);
  assert.equal(applyPatchHelp.requiresApproval, true);
  const readFileHelp = surface.callbackTools.find(
    (tool) => tool.name === 'read_file',
  );
  assert.ok(readFileHelp);
  assert.equal('requiresApproval' in readFileHelp, false);
});

void test('write tier meta invariant is fail-closed even for allowlisted names', () => {
  const invariantMeta = {
    sideEffectLevel: 'write' as const,
    mayMutateComputerFiles: true,
    requiresApproval: true,
  };
  assert.equal(
    isPtcExecuteCodeWriteCallbackToolMetaAllowed('apply_patch', invariantMeta),
    true,
  );
  assert.equal(
    isPtcExecuteCodeWriteCallbackToolMetaAllowed('write_file', invariantMeta),
    false,
  );
  assert.equal(
    isPtcExecuteCodeWriteCallbackToolMetaAllowed('apply_patch', {
      ...invariantMeta,
      requiresApproval: false,
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeWriteCallbackToolMetaAllowed('apply_patch', {
      ...invariantMeta,
      sideEffectLevel: 'destructive',
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeWriteCallbackToolMetaAllowed('apply_patch', {
      ...invariantMeta,
      mayMutateComputerFiles: false,
    }),
    false,
  );
});

void test('write tier stays absent without the knob and out of run scope with it', () => {
  const daemonContext = createDaemonContext();
  const registry = daemonContext.toolRegistry;

  const disabledSurface = resolvePtcExecuteCodeCallbackToolSurface({
    registry,
  });
  assert.equal(disabledSurface.writeTierEnabled, false);
  assert.equal(disabledSurface.allows('apply_patch'), false);
  assert.equal(disabledSurface.allowsWrite('apply_patch'), false);
  assert.equal(
    disabledSurface.callbackTools.some((tool) => tool.name === 'apply_patch'),
    false,
  );
  assert.equal(
    disabledSurface.callbackTools.some(
      (tool) => tool.requiresApproval === true,
    ),
    false,
  );

  const scopedSurface = resolvePtcExecuteCodeCallbackToolSurface({
    registry,
    allowedRegistryNames: ['read_file', 'manage_files'],
    writeCallbackEnabled: true,
  });
  assert.equal(scopedSurface.allows('manage_files'), true);
  assert.equal(scopedSurface.allows('apply_patch'), false);
});

void test('manage_files stays discoverable while delete is refused before dispatch', async () => {
  const daemonContext = createDaemonContext();
  const dispatched: string[] = [];
  const callbackToolDispatcher: CallbackToolDispatcher = {
    async dispatch({ toolName }) {
      dispatched.push(toolName);
      return { ok: true, output: '{}' };
    },
  };

  await withWriteCallbackEnv('1', async () => {
    const ctx = makeCtx(daemonContext, { callbackToolDispatcher });
    const help = createPtcExecuteCodeToolCallbackHelp(ctx);
    assert.ok(help);
    assert.equal(
      help.callbackTools.some((tool) => tool.name === 'manage_files'),
      true,
    );

    const handler = createPtcExecuteCodeToolCallbackHandler(ctx);
    assert.ok(handler);
    const deleteResult = await handler({
      requestId: 'delete-1',
      toolName: 'manage_files',
      args: { operation: 'delete', path: 'note.txt' },
      signal: new AbortController().signal,
      enterLongWait: () => {
        assert.fail('destructive callback must not enter long wait');
      },
    });
    assert.deepEqual(deleteResult, {
      ok: false,
      errorCode: 'ptc_tool_not_callable',
      message: 'PTC execute_code callback cannot run destructive operations',
    });
    assert.deepEqual(dispatched, []);
  });
});

void test('write callbacks dispatch with breakdown counts when the tier is enabled', async () => {
  const daemonContext = createDaemonContext();
  const callbackToolDispatcher: CallbackToolDispatcher = {
    async dispatch({ toolName }) {
      if (toolName === 'apply_patch') {
        return {
          ok: false,
          output: '',
          errorCode: 'approval_denied',
          error: 'approval denied',
        };
      }
      return { ok: true, output: '{}' };
    },
  };

  await withWriteCallbackEnv('true', async () => {
    const ctx = makeCtx(daemonContext, { callbackToolDispatcher });
    const breakdown = createPtcExecuteCodeCallbackBreakdown();
    const handler = createPtcExecuteCodeToolCallbackHandler(
      ctx,
      undefined,
      breakdown,
    );
    assert.ok(handler);

    const writeOk = await handler({
      requestId: 'write-ok-1',
      toolName: 'manage_files',
      args: { operation: 'create', path: 'new.txt' },
      signal: new AbortController().signal,
      enterLongWait: () => true,
    });
    assert.equal(writeOk.ok, true);

    const writeDenied = await handler({
      requestId: 'write-denied-1',
      toolName: 'apply_patch',
      args: { path: 'note.txt' },
      signal: new AbortController().signal,
      enterLongWait: () => true,
    });
    assert.equal(writeDenied.ok, true);

    const readOk = await handler({
      requestId: 'read-1',
      toolName: 'read_file',
      args: { path: 'note.txt' },
      signal: new AbortController().signal,
      enterLongWait: () => true,
    });
    assert.equal(readOk.ok, true);

    assert.deepEqual(breakdown, {
      readCalls: 1,
      writeCalls: 2,
      writeGranted: 1,
      writeDenied: 1,
    });

    const outsideAllowlist = await handler({
      requestId: 'write-file-1',
      toolName: 'write_file',
      args: { path: 'other.txt', content: 'nope' },
      signal: new AbortController().signal,
      enterLongWait: () => {
        assert.fail('non-admitted callback must not enter long wait');
      },
    });
    assert.deepEqual(outsideAllowlist, {
      ok: false,
      errorCode: 'ptc_tool_not_callable',
      message:
        'PTC execute_code callback can only call tools admitted by the callback tool surface',
    });
    assert.deepEqual(breakdown, {
      readCalls: 1,
      writeCalls: 2,
      writeGranted: 1,
      writeDenied: 1,
    });
  });
});
