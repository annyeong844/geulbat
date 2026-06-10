import assert from 'node:assert/strict';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from '../daemon/ptc/lab-package-cache-contract.js';
import { createPtcSessionDockerManager } from '../daemon/ptc/session-docker.js';
import {
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  type PtcSessionDockerCommandInvocation,
  type PtcSessionDockerCommandResult,
  type PtcSessionDockerCommandRunner,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
  type PtcSessionDockerPolicy,
} from '../daemon/ptc/session-docker-contract.js';

export const PTC_TEST_SESSION_DOCKER_CONTAINER_ID = 'container-ptc-test-1';
export const PTC_TEST_WORKSPACE_REALPATH = '/real/workspace/project-a';

export interface PtcSessionDockerCommandFixtureArgs {
  policy?: PtcSessionDockerPolicy;
  containerId?: string;
  createResult?: PtcSessionDockerCommandResult;
  commandResult?: (
    invocation: PtcSessionDockerCommandInvocation,
  ) =>
    | PtcSessionDockerCommandResult
    | undefined
    | Promise<PtcSessionDockerCommandResult | undefined>;
}

export interface PtcSessionDockerCommandFixture {
  containerId: string;
  invocations: PtcSessionDockerCommandInvocation[];
  policy: PtcSessionDockerPolicy;
  runner: PtcSessionDockerCommandRunner;
}

export interface PtcSessionDockerManagerFixture extends PtcSessionDockerCommandFixture {
  manager: PtcSessionDockerManager;
  runtimeRoot: string;
}

export async function withRealPtcSessionDockerManager<T>(
  args: PtcSessionDockerCommandFixtureArgs & {
    identity: PtcSessionDockerIdentity;
    realpathWorkspaceRoot?: (workspaceRoot: string) => Promise<string>;
    workspaceRootRealpath?: string;
  },
  fn: (fixture: PtcSessionDockerManagerFixture) => Promise<T>,
): Promise<T> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'geulbat-ptc-session-'));
  try {
    const fixture = createPtcSessionDockerCommandFixture(args);
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      policy: fixture.policy,
      commandRunner: fixture.runner,
      realpathWorkspaceRoot:
        args.realpathWorkspaceRoot ??
        (async (workspaceRoot) => {
          assert.equal(workspaceRoot, args.identity.workspaceRoot);
          return args.workspaceRootRealpath ?? PTC_TEST_WORKSPACE_REALPATH;
        }),
    });

    return await fn({ ...fixture, manager, runtimeRoot });
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

export function createPtcSessionDockerCommandFixture(
  args: PtcSessionDockerCommandFixtureArgs = {},
): PtcSessionDockerCommandFixture {
  const policy = args.policy ?? PTC_SESSION_DOCKER_DEFAULT_POLICY;
  const containerId = args.containerId ?? PTC_TEST_SESSION_DOCKER_CONTAINER_ID;
  const invocations: PtcSessionDockerCommandInvocation[] = [];
  const runner: PtcSessionDockerCommandRunner = async (invocation) => {
    invocations.push(invocation);
    const commandResult = await args.commandResult?.(invocation);
    if (commandResult !== undefined) {
      return commandResult;
    }

    if (invocation.args[0] === '--version') {
      return {
        kind: 'exit',
        exitCode: 0,
        stdout: 'Docker version 27',
        stderr: '',
      };
    }
    if (invocation.args[0] === 'image') {
      assert.equal(invocation.args[1], 'inspect');
      assert.equal(invocation.args.at(-1), policy.imageRef);
      return { kind: 'exit', exitCode: 0, stdout: '[]', stderr: '' };
    }
    if (invocation.args[0] === 'create') {
      await assertPreparedHostRoots(invocation);
      const networkIndex = invocation.args.indexOf('--network');
      assert.notEqual(networkIndex, -1);
      assert.equal(
        invocation.args[networkIndex + 1],
        policy.network.mode === 'open'
          ? policy.network.dockerNetworkName
          : 'none',
      );
      return (
        args.createResult ?? {
          kind: 'exit',
          exitCode: 0,
          stdout: `${containerId}\n`,
          stderr: '',
        }
      );
    }
    if (invocation.args[0] === 'start') {
      assert.equal(invocation.args.at(-1), containerId);
      return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
    }
    if (invocation.args[0] === 'inspect') {
      assert.equal(invocation.args.at(-1), containerId);
      return {
        kind: 'exit',
        exitCode: 0,
        stdout: JSON.stringify([{ Id: containerId, State: { Running: true } }]),
        stderr: '',
      };
    }
    if (invocation.args[0] === 'rm') {
      assert.equal(invocation.args.at(-1), containerId);
      assert.equal(
        invocation.args.includes('-f') || invocation.args.includes('--force'),
        true,
      );
      return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected docker args: ${invocation.args.join(' ')}`);
  };

  return { containerId, invocations, policy, runner };
}

async function assertPreparedHostRoots(
  invocation: PtcSessionDockerCommandInvocation,
): Promise<void> {
  await assertBindMountHostDir(
    invocation,
    PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  );
  await assertBindMountHostDir(
    invocation,
    PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  );
  await assertBindMountHostDir(
    invocation,
    PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT,
  );
}

async function assertBindMountHostDir(
  invocation: PtcSessionDockerCommandInvocation,
  containerPath: string,
): Promise<void> {
  const hostPath = readPtcSessionDockerBindMountHostPath(
    invocation,
    containerPath,
  );
  await access(hostPath);
  const hostPathStat = await stat(hostPath);
  assert.equal(hostPathStat.isDirectory(), true);
}

export function readPtcSessionDockerBindMountHostPath(
  invocation: PtcSessionDockerCommandInvocation,
  containerPath: string,
): string {
  const mountSpec = invocation.args.find(
    (item) =>
      item.startsWith('type=bind,src=') &&
      item.endsWith(`,dst=${containerPath},rw`),
  );
  assert.ok(mountSpec);
  const hostPath = /^type=bind,src=([^,]+),dst=.+,rw$/u.exec(mountSpec)?.[1];
  assert.ok(hostPath);
  return hostPath;
}
