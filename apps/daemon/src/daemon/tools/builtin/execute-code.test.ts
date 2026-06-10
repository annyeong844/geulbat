import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonContext } from '../../context.js';
import {
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_TOOL_NAME,
  type PtcExecuteCodeRuntime,
} from '../../daemon-runtime-contract.js';
import { testProjectId } from '../../../test-support/project-id.js';
import { testThreadId } from '../../../test-support/thread-id.js';
import { executeCodeTool } from './execute-code.js';
import {
  createPtcExecuteCodeToolCallbackHandler,
  createPtcExecuteCodeToolCallbackHelp,
  isPtcExecuteCodeCallbackToolAllowed,
} from './execute-code-tool-callback.js';

void test('execute_code requires an agent runtime service before executing code', async () => {
  const result = await executeCodeTool.execute(
    { code: 'console.log("hello")' },
    {
      callId: 'call-execute-code-no-runtime',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(911),
      projectId: testProjectId('project'),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.match(result.error ?? '', /runtime is required/u);
});

void test('execute_code returns compact runtime output without session identifiers', async () => {
  const daemonContext = createDaemonContext();
  let observedCode = '';
  let observedSdkToolNames: string[] = [];
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode(args) {
      observedCode = args.request.code;
      assert.equal(typeof args.toolCallbackHandler, 'function');
      observedSdkToolNames = (args.sdkHelp?.callbackTools ?? []).map(
        (tool) => tool.name,
      );
      return {
        ok: true,
        value: {
          ok: true,
          capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
          policyId: PTC_EXECUTE_CODE_POLICY_ID,
          labPolicyId: 'ptc_lab_local_docker_batch_command_v1',
          profile: 'lab',
          executionClass: 'lab_execute_code',
          executionSurface: 'node_via_lab_batch_command',
          exitCode: 0,
          stdout: '{"answer":42}\n',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          effectiveTimeoutMs: 60_000,
          durationMs: 12,
          toolCallbacks: {
            enabled: true,
            observed: 1,
          },
          sessionLifecycle: {
            mode: 'runtime_owned_reusable',
            retainedAfterExecution: true,
          },
          callbackHelp: {
            protocolVersion: 'ptc_execute_code_sdk_v1',
            helpAvailable: true,
            callbackToolCount: args.sdkHelp?.callbackTools.length ?? 0,
          },
        },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await executeCodeTool.execute(
    { code: 'return { answer: 42 }' },
    {
      callId: 'call-execute-code-success',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(912),
      projectId: testProjectId('project'),
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(observedCode, 'return { answer: 42 }');
  assert.equal(observedSdkToolNames.includes('read_file'), true);
  assert.equal(observedSdkToolNames.includes('list_files'), true);
  assert.equal(observedSdkToolNames.includes('search_files'), true);
  assert.equal(observedSdkToolNames.includes('web_fetch'), true);
  assert.equal(observedSdkToolNames.includes('browser_navigate'), false);
  assert.equal(observedSdkToolNames.includes('write_file'), false);
  assert.equal(observedSdkToolNames.includes('execute_code'), false);
  const output = JSON.parse(result.output) as Record<string, unknown>;
  assert.equal(output.kind, 'ptc_execute_code_result');
  assert.equal(output.capabilityId, 'execute_code');
  assert.equal(output.exitCode, 0);
  assert.equal(output.stdout, '{"answer":42}\n');
  assert.deepEqual(output.toolCallbacks, {
    enabled: true,
    observed: 1,
  });
  assert.deepEqual(output.sessionLifecycle, {
    mode: 'runtime_owned_reusable',
    retainedAfterExecution: true,
  });
  const callbackHelp = output.callbackHelp as Record<string, unknown>;
  assert.equal(callbackHelp.protocolVersion, 'ptc_execute_code_sdk_v1');
  assert.equal(callbackHelp.helpAvailable, true);
  assert.equal(typeof callbackHelp.callbackToolCount, 'number');
  assert.equal(Object.hasOwn(output, 'sdk'), false);
  assert.equal(JSON.stringify(output).includes('container'), false);
  assert.equal(JSON.stringify(output).includes('labSessionId'), false);
});

void test('execute_code callback handler runs read-only tools through the canonical executor and rejects mutating tools', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-execute-code-callback-tool-'),
  );
  const daemonContext = createDaemonContext();
  const threadId = testThreadId(915);
  const projectId = testProjectId('project');
  await writeFile(join(workspaceRoot, 'note.txt'), 'callback file\n');

  try {
    const handler = createPtcExecuteCodeToolCallbackHandler({
      callId: 'outer-execute-code-call',
      workspaceRoot,
      threadId,
      projectId,
      agentSpawnRuntime: daemonContext,
    });
    assert.ok(handler);
    const help = createPtcExecuteCodeToolCallbackHelp({
      callId: 'outer-execute-code-call',
      workspaceRoot,
      threadId,
      projectId,
      agentSpawnRuntime: daemonContext,
    });
    assert.ok(help);
    const callbackToolNames = help.callbackTools.map((tool) => tool.name);
    assert.equal(callbackToolNames.includes('read_file'), true);
    assert.equal(callbackToolNames.includes('browser_navigate'), false);
    assert.equal(callbackToolNames.includes('write_file'), false);
    assert.equal(callbackToolNames.includes('execute_code'), false);
    assert.equal(
      help.callbackTools.find((tool) => tool.name === 'read_file')?.parameters
        .additionalProperties,
      false,
    );

    const readResult = await handler({
      requestId: 'read-1',
      toolName: 'read_file',
      args: { path: 'note.txt' },
      signal: new AbortController().signal,
    });
    assert.equal(readResult.ok, true);
    if (readResult.ok) {
      const executeResult = assertExecuteResult(readResult.result);
      assert.equal(executeResult.ok, true);
      const output = JSON.parse(executeResult.output) as Record<
        string,
        unknown
      >;
      assert.equal(output.content, 'callback file\n');
    }

    const writeResult = await handler({
      requestId: 'write-1',
      toolName: 'write_file',
      args: { path: 'created.txt', content: 'nope' },
      signal: new AbortController().signal,
    });
    assert.deepEqual(writeResult, {
      ok: false,
      errorCode: 'ptc_tool_not_callable',
      message:
        'PTC execute_code callback can only call read-only no-approval tools',
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('execute_code callback predicate fails closed for incomplete or contradictory metadata', () => {
  assert.equal(
    isPtcExecuteCodeCallbackToolAllowed('read_file', {
      sideEffectLevel: 'read',
      requiresApproval: false,
      mayMutateWorkspaceFiles: false,
    }),
    true,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolAllowed('read_file', {
      sideEffectLevel: 'read',
      requiresApproval: false,
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolAllowed('read_file', {
      sideEffectLevel: 'read',
      requiresApproval: true,
      mayMutateWorkspaceFiles: false,
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolAllowed('read_file', {
      sideEffectLevel: 'read',
      requiresApproval: false,
      mayMutateWorkspaceFiles: true,
    }),
    false,
  );
  assert.equal(
    isPtcExecuteCodeCallbackToolAllowed('execute_code', {
      sideEffectLevel: 'read',
      requiresApproval: false,
      mayMutateWorkspaceFiles: false,
    }),
    false,
  );
});

void test('execute_code strips unstable failure diagnostics from tool output', async () => {
  const daemonContext = createDaemonContext();
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode() {
      return {
        ok: false,
        reasonCode: 'ptc_lab_session_unavailable',
        message: 'PTC lab session container is unavailable',
        diagnostics: {
          sessionReasonCode: 'container_create_failed',
          rawPath: '/tmp/geulbat-private/.geulbat/ptc/private',
        },
      };
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await executeCodeTool.execute(
    { code: 'console.log("nope")' },
    {
      callId: 'call-execute-code-failure',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(913),
      projectId: testProjectId('project'),
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'execution_failed');
  assert.doesNotMatch(result.output, /geulbat-private|\.geulbat|private/u);
  assert.deepEqual(JSON.parse(result.output), {
    kind: 'ptc_execute_code_error',
    reasonCode: 'ptc_lab_session_unavailable',
    message: 'PTC lab session container is unavailable',
    diagnostics: {
      sessionReasonCode: 'container_create_failed',
    },
  });
});

function assertExecuteResult(value: unknown): {
  ok: boolean;
  output: string;
} {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  const record = value as Record<string, unknown>;
  const ok = record.ok;
  const output = record.output;
  if (typeof ok !== 'boolean' || typeof output !== 'string') {
    throw new Error('execute result shape is invalid');
  }
  return {
    ok,
    output,
  };
}

void test('execute_code rejects extra URL-shaped arguments before runtime invocation', async () => {
  const daemonContext = createDaemonContext();
  let invoked = false;
  const ptcExecuteCode: PtcExecuteCodeRuntime = {
    async executeCode() {
      invoked = true;
      throw new Error('runtime should not be invoked');
    },
    async closeAll() {
      return { ok: true };
    },
  };

  const result = await executeCodeTool.execute(
    { code: 'console.log("hello")', url: 'https://example.test' },
    {
      callId: 'call-execute-code-extra-field',
      workspaceRoot: '/workspace/project',
      threadId: testThreadId(914),
      projectId: testProjectId('project'),
      agentSpawnRuntime: { ...daemonContext, ptcExecuteCode },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'invalid_args');
  assert.equal(invoked, false);
});
