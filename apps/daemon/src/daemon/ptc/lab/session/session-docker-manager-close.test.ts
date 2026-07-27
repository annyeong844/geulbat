import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PTC_TEST_SESSION_DOCKER_IDENTITY as IDENTITY,
  withTempPtcSessionDockerRuntimeRoot as withTempRuntimeRoot,
} from '../../../../test-support/ptc-session-docker.js';
import { createPtcSessionDockerManager } from './session-docker.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
} from './session-docker-contract.js';

void test('PtcSessionDockerManager close during startup removes the created container', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    let markCreateStarted!: () => void;
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const invocations: string[][] = [];
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      invocations.push(invocation.args);
      if (invocation.args[0] === '--version') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'Docker version 27',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'image') {
        return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (invocation.args[0] === 'create') {
        markCreateStarted();
        await createReleased;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'container-1\n',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'start') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.args[0] === 'inspect') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: 'container-1', State: { Running: true } },
          ]),
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const start = manager.getOrCreate(IDENTITY);
    await createStarted;
    const close = manager.close(IDENTITY);
    releaseCreate();
    assert.equal((await start).ok, true);
    assert.equal((await close).ok, true);
    assert.deepEqual(invocations.at(-1), ['rm', '-f', 'container-1']);
  });
});

void test('PtcSessionDockerManager closeAll during startup removes the created container', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    let markCreateStarted!: () => void;
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const invocations: string[][] = [];
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      invocations.push(invocation.args);
      if (invocation.args[0] === '--version') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'Docker version 27',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'image') {
        return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (invocation.args[0] === 'create') {
        markCreateStarted();
        await createReleased;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'container-1\n',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'start') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.args[0] === 'inspect') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: 'container-1', State: { Running: true } },
          ]),
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const start = manager.getOrCreate(IDENTITY);
    await createStarted;
    const closeAll = manager.closeAll();
    releaseCreate();
    assert.equal((await start).ok, true);
    assert.equal((await closeAll).ok, true);
    assert.deepEqual(invocations.at(-1), ['rm', '-f', 'container-1']);
  });
});

void test('PtcSessionDockerManager getOrCreate works again after closeAll cleanup', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const invocations: string[][] = [];
    let createCount = 0;
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      invocations.push(invocation.args);
      if (invocation.args[0] === '--version') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'Docker version 27',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'image') {
        return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (invocation.args[0] === 'create') {
        createCount += 1;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `container-${createCount}\n`,
          stderr: '',
        };
      }
      if (invocation.args[0] === 'start') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.args[0] === 'inspect') {
        const containerId = invocation.args[1] ?? '';
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: containerId, State: { Running: true } },
          ]),
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const first = await manager.getOrCreate(IDENTITY);
    const closeAll = await manager.closeAll();
    const second = await manager.getOrCreate(IDENTITY);

    assert.equal(first.ok ? first.value.containerId : '', 'container-1');
    assert.equal(closeAll.ok, true);
    assert.equal(second.ok ? second.value.containerId : '', 'container-2');
    assert.equal(invocations.filter((args) => args[0] === 'create').length, 2);
    assert.deepEqual(invocations.filter((args) => args[0] === 'rm').at(0), [
      'rm',
      '-f',
      'container-1',
    ]);
  });
});

void test('PtcSessionDockerManager rejects getOrCreate requested during closeAll cleanup', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    let createCount = 0;
    let markRemoveStarted!: () => void;
    let releaseRemove!: () => void;
    const removeStarted = new Promise<void>((resolve) => {
      markRemoveStarted = resolve;
    });
    const removeReleased = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    const invocations: string[][] = [];
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      invocations.push(invocation.args);
      if (invocation.args[0] === '--version') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'Docker version 27',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'image') {
        return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (invocation.args[0] === 'create') {
        createCount += 1;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: `container-${createCount}\n`,
          stderr: '',
        };
      }
      if (invocation.args[0] === 'start') {
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.args[0] === 'inspect') {
        const containerId = invocation.args[1] ?? '';
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: containerId, State: { Running: true } },
          ]),
          stderr: '',
        };
      }
      if (invocation.args[0] === 'rm') {
        markRemoveStarted();
        await removeReleased;
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const first = await manager.getOrCreate(IDENTITY);
    assert.equal(first.ok ? first.value.containerId : '', 'container-1');

    const closeAll = manager.closeAll();
    await removeStarted;
    const duringCloseAll = manager.getOrCreate(IDENTITY);
    releaseRemove();

    assert.equal((await closeAll).ok, true);
    const duringCloseAllResult = await duringCloseAll;
    assert.equal(duringCloseAllResult.ok, false);
    assert.equal(
      duringCloseAllResult.ok ? '' : duringCloseAllResult.reasonCode,
      'manager_closing',
    );
    assert.equal(createCount, 1);

    const afterCloseAll = await manager.getOrCreate(IDENTITY);
    assert.equal(
      afterCloseAll.ok ? afterCloseAll.value.containerId : '',
      'container-2',
    );
    assert.equal(invocations.filter((args) => args[0] === 'create').length, 2);
  });
});

void test('PtcSessionDockerManager diagnostics redact private path markers', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: async (invocation) => {
        if (invocation.args[0] === '--version') {
          return {
            kind: 'exit',
            exitCode: 127,
            stdout: '',
            stderr:
              'failed at /workspace/project-a/.geulbat/private, /tmp/geulbat-ptc-session-abc/ptc-sessions/hash/callbacks, and /var/run/docker.sock',
          };
        }
        throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
      },
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, false);
    const text = JSON.stringify(result);
    assert.doesNotMatch(text, /\.geulbat/u);
    assert.doesNotMatch(text, /\/tmp\/geulbat-ptc-session/u);
    assert.doesNotMatch(text, /\/var\/run\/docker\.sock/u);
    assert.match(text, /\[redacted:path\]/u);
    assert.match(text, /\[redacted:docker-socket\]/u);
  });
});
