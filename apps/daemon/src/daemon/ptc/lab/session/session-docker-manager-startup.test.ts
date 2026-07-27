import assert from 'node:assert/strict';
import { access, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildPtcSessionDockerPackageCacheHostRoot as packageCacheHostRootFor,
  PTC_TEST_SESSION_DOCKER_IDENTITY as IDENTITY,
  withTempPtcSessionDockerRuntimeRoot as withTempRuntimeRoot,
} from '../../../../test-support/ptc-session-docker.js';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from '../packages/lab-package-cache-contract.js';
import { createPtcLabOpenEgressLocalPolicy } from '../network/lab-network-policy.js';
import {
  createPtcSessionDockerManager,
  normalizePtcSessionDockerReuseKey,
} from './session-docker.js';
import { buildPtcSessionDockerSessionRoot } from './session-docker-host-roots.js';
import {
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  type PtcSessionDockerCommandInvocation,
  type PtcSessionDockerCommandResult,
} from './session-docker-contract.js';

void test('PtcSessionDockerManager creates, inspects, reuses, and closes one container', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const invocations: PtcSessionDockerCommandInvocation[] = [];
    const runner = async (
      invocation: PtcSessionDockerCommandInvocation,
    ): Promise<PtcSessionDockerCommandResult> => {
      invocations.push(invocation);
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
        const mountIndex = invocation.args.indexOf('--mount');
        const mountSpec =
          mountIndex >= 0 ? invocation.args[mountIndex + 1] : '';
        const callbackRoot =
          /^type=bind,src=([^,]+),dst=\/geulbat\/callbacks$/u.exec(
            mountSpec ?? '',
          )?.[1];
        assert.ok(callbackRoot);
        await access(callbackRoot);
        const callbackRootStat = await stat(callbackRoot);
        assert.equal(callbackRootStat.isDirectory(), true);
        const packageCacheMountSpec = invocation.args.find((item) =>
          item.includes(
            `,dst=${PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT}`,
          ),
        );
        assert.ok(packageCacheMountSpec);
        const packageCacheRoot =
          /^type=bind,src=([^,]+),dst=\/geulbat\/package-cache$/u.exec(
            packageCacheMountSpec,
          )?.[1];
        assert.ok(packageCacheRoot);
        await access(packageCacheRoot);
        const packageCacheRootStat = await stat(packageCacheRoot);
        assert.equal(packageCacheRootStat.isDirectory(), true);
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

    const first = await manager.getOrCreate(IDENTITY);
    assert.equal(first.ok, true);
    assert.equal(first.ok ? first.value.containerId : '', 'container-1');
    assert.equal(first.ok ? first.value.state : '', 'ready');
    const artifactRoot = first.ok ? first.value.artifactRootHostPath : '';
    const packageCacheRoot = first.ok
      ? first.value.packageCacheRootHostPath
      : '';
    await access(artifactRoot);
    await access(packageCacheRoot);

    const second = await manager.getOrCreate(IDENTITY);
    assert.equal(second.ok, true);
    assert.equal(second.ok ? second.value.containerId : '', 'container-1');

    const close = await manager.close(IDENTITY);
    assert.equal(close.ok, true);
    await assert.rejects(() => access(artifactRoot), /ENOENT/u);
    await access(packageCacheRoot);

    const commandNames = invocations.map((invocation) => invocation.args[0]);
    assert.equal(commandNames.filter((name) => name === 'create').length, 1);
    assert.equal(commandNames.filter((name) => name === 'rm').length, 1);
    assert.equal(
      commandNames.filter((name) => name === 'inspect').length >= 1,
      true,
    );
    assert.equal(
      invocations.every((invocation) => invocation.timeoutMs === undefined),
      true,
    );
  });
});

void test('PtcSessionDockerManager single-flights concurrent getOrCreate calls', async () => {
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
      throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
    };
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      commandRunner: runner,
      realpathStateRoot: async () => '/real/workspace/project-a',
    });

    const first = manager.getOrCreate(IDENTITY);
    const second = manager.getOrCreate(IDENTITY);
    await createStarted;
    releaseCreate();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.equal(
      firstResult.ok && secondResult.ok
        ? firstResult.value.containerId === secondResult.value.containerId
        : false,
      true,
    );
    assert.equal(invocations.filter((args) => args[0] === 'create').length, 1);
  });
});

void test('PtcSessionDockerManager removes created container when start fails', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const invocations: string[][] = [];
    const reuseKey = normalizePtcSessionDockerReuseKey({
      identity: IDENTITY,
      stateRootRealpath: '/real/workspace/project-a',
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });
    const sessionRoot = buildPtcSessionDockerSessionRoot({
      runtimeRoot,
      reuseKey,
    });
    const packageCacheRoot = packageCacheHostRootFor({ runtimeRoot, reuseKey });
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
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'container-start-fail\n',
          stderr: '',
        };
      }
      if (invocation.args[0] === 'start') {
        return {
          kind: 'exit',
          exitCode: 1,
          stdout: '',
          stderr: 'start failed',
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

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, false);
    assert.equal(result.ok ? '' : result.reasonCode, 'container_start_failed');
    assert.deepEqual(invocations.at(-1), ['rm', '-f', 'container-start-fail']);
    await assert.rejects(() => access(sessionRoot), /ENOENT/u);
    await access(packageCacheRoot);
  });
});

void test('PtcSessionDockerManager removes created container and host root when inspect fails', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const invocations: string[][] = [];
    const reuseKey = normalizePtcSessionDockerReuseKey({
      identity: IDENTITY,
      stateRootRealpath: '/real/workspace/project-a',
      policy: PTC_SESSION_DOCKER_DEFAULT_POLICY,
    });
    const sessionRoot = buildPtcSessionDockerSessionRoot({
      runtimeRoot,
      reuseKey,
    });
    const packageCacheRoot = packageCacheHostRootFor({ runtimeRoot, reuseKey });
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
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'container-inspect-fail\n',
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
          stdout: '{not-json',
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

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'container_inspect_failed',
    );
    assert.equal(
      result.ok ? '' : result.diagnostics?.dockerInspectFailureKind,
      'invalid_json',
    );
    assert.doesNotMatch(JSON.stringify(result), /\{not-json/u);
    assert.deepEqual(invocations.at(-1), [
      'rm',
      '-f',
      'container-inspect-fail',
    ]);
    await assert.rejects(() => access(sessionRoot), /ENOENT/u);
    await access(packageCacheRoot);
  });
});

void test('PtcSessionDockerManager creates the open network bridge before launching an open-network session (slice 1b)', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const openPolicy = {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      network: createPtcLabOpenEgressLocalPolicy(),
    };
    const invocations: PtcSessionDockerCommandInvocation[] = [];
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      policy: openPolicy,
      realpathStateRoot: async () => '/real/workspace',
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        if (invocation.args[0] === '--version') {
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: 'Docker version',
            stderr: '',
          };
        }
        if (invocation.args[0] === 'image') {
          return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (
          invocation.args[0] === 'network' &&
          invocation.args[1] === 'inspect'
        ) {
          return {
            kind: 'exit',
            exitCode: 1,
            stdout: '',
            stderr: 'Error: No such network: geulbat-ptc-lab-open-v1',
          };
        }
        if (
          invocation.args[0] === 'network' &&
          invocation.args[1] === 'create'
        ) {
          return { kind: 'exit', exitCode: 0, stdout: 'net-id\n', stderr: '' };
        }
        if (invocation.args[0] === 'create') {
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: 'container-open-1\n',
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
              { Id: 'container-open-1', State: { Running: true } },
            ]),
            stderr: '',
          };
        }
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, true);
    const order = invocations.map((invocation) => invocation.args.join(' '));
    const networkCreateIndex = order.findIndex((line) =>
      line.startsWith('network create'),
    );
    const containerCreateIndex = order.findIndex((line) =>
      line.startsWith('create'),
    );
    assert.notEqual(networkCreateIndex, -1);
    assert.notEqual(containerCreateIndex, -1);
    assert.ok(networkCreateIndex < containerCreateIndex);
    const networkCreateCall = invocations[networkCreateIndex];
    assert.ok(networkCreateCall);
    assert.equal(networkCreateCall.args.at(-1), 'geulbat-ptc-lab-open-v1');
  });
});

void test('PtcSessionDockerManager adopts an existing open network bridge without recreating it', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const openPolicy = {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      network: createPtcLabOpenEgressLocalPolicy(),
    };
    const invocations: PtcSessionDockerCommandInvocation[] = [];
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      policy: openPolicy,
      realpathStateRoot: async () => '/real/workspace',
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        if (invocation.args[0] === '--version') {
          return { kind: 'exit', exitCode: 0, stdout: 'v', stderr: '' };
        }
        if (invocation.args[0] === 'image') {
          return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (
          invocation.args[0] === 'network' &&
          invocation.args[1] === 'inspect'
        ) {
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: JSON.stringify([{ Name: 'geulbat-ptc-lab-open-v1' }]),
            stderr: '',
          };
        }
        if (invocation.args[0] === 'create') {
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: 'container-open-2\n',
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
              { Id: 'container-open-2', State: { Running: true } },
            ]),
            stderr: '',
          };
        }
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, true);
    assert.equal(
      invocations.some((invocation) =>
        invocation.args.join(' ').startsWith('network create'),
      ),
      false,
    );
  });
});

void test('PtcSessionDockerManager fails closed when the open network bridge cannot be ensured', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    const openPolicy = {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      network: createPtcLabOpenEgressLocalPolicy(),
    };
    const invocations: PtcSessionDockerCommandInvocation[] = [];
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      policy: openPolicy,
      realpathStateRoot: async () => '/real/workspace',
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        if (invocation.args[0] === '--version') {
          return { kind: 'exit', exitCode: 0, stdout: 'v', stderr: '' };
        }
        if (invocation.args[0] === 'image') {
          return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (
          invocation.args[0] === 'network' &&
          invocation.args[1] === 'inspect'
        ) {
          return {
            kind: 'exit',
            exitCode: 1,
            stdout: '',
            stderr: 'Error: No such network',
          };
        }
        if (
          invocation.args[0] === 'network' &&
          invocation.args[1] === 'create'
        ) {
          return {
            kind: 'exit',
            exitCode: 1,
            stdout: '',
            stderr: 'Error response from daemon: permission denied',
          };
        }
        return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await manager.getOrCreate(IDENTITY);

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'network_backend_unavailable',
    );
    // Ensure failed before any container was created.
    assert.equal(
      invocations.some((invocation) => invocation.args[0] === 'create'),
      false,
    );
  });
});

void test('PtcSessionDockerManager recreates a tracked container that no longer runs', async () => {
  await withTempRuntimeRoot(async (runtimeRoot) => {
    let createCount = 0;
    let inspectCount = 0;
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
        inspectCount += 1;
        const containerId = invocation.args[1] ?? '';
        const running = inspectCount !== 2;
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: containerId, State: { Running: running } },
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
    assert.equal(first.ok, true);
    const oldArtifactRoot = first.ok ? first.value.artifactRootHostPath : '';
    const oldPackageCacheRoot = first.ok
      ? first.value.packageCacheRootHostPath
      : '';
    const staleMarker = join(oldArtifactRoot, 'stale-output.txt');
    const packageCacheMarker = join(oldPackageCacheRoot, 'keep-cache.txt');
    await writeFile(staleMarker, 'stale', 'utf8');
    await writeFile(packageCacheMarker, 'cache', 'utf8');
    const second = await manager.getOrCreate(IDENTITY);

    assert.equal(first.ok ? first.value.containerId : '', 'container-1');
    assert.equal(second.ok ? second.value.containerId : '', 'container-2');
    await assert.rejects(() => access(staleMarker), /ENOENT/u);
    await access(packageCacheMarker);
    await access(second.ok ? second.value.artifactRootHostPath : '');
    assert.equal(
      second.ok ? second.value.packageCacheRootHostPath : '',
      oldPackageCacheRoot,
    );
    assert.deepEqual(invocations.filter((args) => args[0] === 'rm').at(0), [
      'rm',
      '-f',
      'container-1',
    ]);
  });
});
