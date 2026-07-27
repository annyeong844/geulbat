import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testThreadId } from '../test-support/thread-id.js';
import {
  PTC_EXECUTE_CODE_POLICY_ID,
  PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
  PTC_EXECUTE_CODE_TOOL_NAME,
} from './ptc/runtime/execute-code/execute-code-runtime-contract.js';
import { createPtcExecuteCodeCellTerminalResultStore } from './ptc-execute-code-terminal-result-store.js';

void test('PTC terminal result store reports an unavailable durable read without falling back to missing', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-terminal-result-read-failure-'),
  );
  await writeFile(join(stateRoot, '.geulbat'), 'not a directory', 'utf8');

  try {
    const result = await createPtcExecuteCodeCellTerminalResultStore().read({
      stateRoot,
      threadId: testThreadId(1),
      cellId: 'ptc_cell_unavailable_durable_read',
    });

    assert.deepEqual(result, {
      ok: false,
      message: 'PTC execute_code durable terminal result is unavailable',
    });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

void test('PTC terminal result store round-trips the exact early exec result beside wait output', async () => {
  const stateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-terminal-exec-recovery-'),
  );
  const threadId = testThreadId(2);
  const cellId = 'ptc_cell_terminal_exec_recovery';
  const recoveryResult = {
    ok: true as const,
    value: {
      ok: true as const,
      capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
      policyId: PTC_EXECUTE_CODE_POLICY_ID,
      labPolicyId: PTC_EXECUTE_CODE_POLICY_ID,
      profile: 'lab' as const,
      executionClass: 'lab_execute_code' as const,
      executionSurface: 'node_via_lab_batch_command' as const,
      exitCode: 0,
      stdout: 'completed before initial yield\n',
      stderr: '',
      effectiveTimeoutMs: 60_000,
      durationMs: 17,
      toolCallbacks: { enabled: false, observed: 0 },
      sessionLifecycle: {
        mode: 'runtime_owned_reusable' as const,
        retainedAfterExecution: true,
      },
      callbackHelp: {
        protocolVersion: PTC_EXECUTE_CODE_SDK_PROTOCOL_VERSION,
        helpAvailable: true,
        callbackToolCount: 0,
      },
    },
  };
  const waitOutput = JSON.stringify({
    kind: 'ptc_execute_code_cell_wait',
    ok: true,
    capabilityId: PTC_EXECUTE_CODE_TOOL_NAME,
    policyId: PTC_EXECUTE_CODE_POLICY_ID,
    executionSurface: 'node_via_lab_detached_cell',
    cellId,
    status: 'completed',
    exitCode: 0,
    stdout: recoveryResult.value.stdout,
    stderr: '',
  });
  const store = createPtcExecuteCodeCellTerminalResultStore();

  try {
    await store.persist({
      stateRoot,
      threadId,
      cellId,
      output: waitOutput,
      status: 'completed',
      exitCode: 0,
    });
    await store.persistRecovery?.({
      stateRoot,
      threadId,
      cellId,
      result: recoveryResult,
    });

    const read = await store.readRecovery?.({ stateRoot, threadId, cellId });
    assert.notEqual(read, undefined);
    if (read === undefined) {
      return;
    }
    assert.equal(read.ok, true);
    assert.deepEqual(read.ok ? read.value : undefined, recoveryResult);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
