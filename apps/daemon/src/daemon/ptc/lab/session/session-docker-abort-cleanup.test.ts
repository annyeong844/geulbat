import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPtcSessionDockerManager } from './session-docker.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
  PtcSessionDockerIdentity,
} from './session-docker-contract.js';

const IDENTITY: PtcSessionDockerIdentity = {
  threadId: 'thread-ptc-abort-cleanup',
  workspaceRoot: '/workspace/project-a',
  trustContextId: 'local-default-v1',
};

async function withTempRuntimeRoot<T>(
  fn: (runtimeRoot: string) => Promise<T>,
): Promise<T> {
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-session-abort-cleanup-'),
  );
  try {
    return await fn(runtimeRoot);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

function successfulDockerResult(
  stdout = '',
): Extract<PtcSessionDockerCommandResult, { kind: 'exit' }> {
  return { kind: 'exit', exitCode: 0, stdout, stderr: '' };
}

void test('PtcSessionDockerManager close cleanup removes containers even when caller signal is already aborted', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const controller = new AbortController();
    const removeInvocations: PtcSessionDockerCommandInvocation[] = [];
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      if (invocation.args[0] === '--version') {
        return successfulDockerResult('Docker version 27');
      }
      if (invocation.args[0] === 'image') {
        return successfulDockerResult('[]');
      }
      if (invocation.args[0] === 'create') {
        return successfulDockerResult('container-1\n');
      }
      if (invocation.args[0] === 'start') {
        return successfulDockerResult();
      }
      if (invocation.args[0] === 'inspect') {
        return successfulDockerResult(
          JSON.stringify([{ Id: 'container-1', State: { Running: true } }]),
        );
      }
      if (invocation.args[0] === 'rm') {
        removeInvocations.push(invocation);
        return successfulDockerResult();
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
    });

    const session = await manager.getOrCreate(IDENTITY);
    assert.equal(session.ok, true);
    controller.abort();

    const close = await manager.close(IDENTITY, {
      signal: controller.signal,
    });

    assert.equal(close.ok, true);
    assert.deepEqual(removeInvocations.at(-1)?.args, [
      'rm',
      '-f',
      'container-1',
    ]);
    assert.equal(removeInvocations.at(-1)?.signal, undefined);
  });
});

void test('PtcSessionDockerManager startup failure cleanup removes created containers after caller abort', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const controller = new AbortController();
    const removeInvocations: PtcSessionDockerCommandInvocation[] = [];
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      if (invocation.args[0] === '--version') {
        return successfulDockerResult('Docker version 27');
      }
      if (invocation.args[0] === 'image') {
        return successfulDockerResult('[]');
      }
      if (invocation.args[0] === 'create') {
        controller.abort();
        return successfulDockerResult('container-1\n');
      }
      if (invocation.args[0] === 'start') {
        assert.equal(invocation.signal?.aborted, true);
        return {
          kind: 'cancelled',
          stdout: '',
          stderr: '',
          processTerminated: false,
        };
      }
      if (invocation.args[0] === 'rm') {
        removeInvocations.push(invocation);
        return successfulDockerResult();
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathWorkspaceRoot: async () => '/real/workspace/project-a',
    });

    const result = await manager.getOrCreate(IDENTITY, {
      signal: controller.signal,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reasonCode, 'container_start_failed');
    assert.deepEqual(removeInvocations.at(-1)?.args, [
      'rm',
      '-f',
      'container-1',
    ]);
    assert.equal(removeInvocations.at(-1)?.signal, undefined);
  });
});
