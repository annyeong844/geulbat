import assert from 'node:assert/strict';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PTC_SESSION_DOCKER_PACKAGE_CACHE_CONTAINER_ROOT } from '../daemon/ptc/lab/packages/lab-package-cache-contract.js';
import { createPtcSessionDockerManager } from '../daemon/ptc/lab/session/session-docker.js';
import {
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
  type PtcSessionDockerCommandInvocation,
  type PtcSessionDockerCommandResult,
  type PtcSessionDockerCommandRunner,
  type PtcSessionDockerHostUser,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerManager,
  type PtcSessionDockerPolicy,
} from '../daemon/ptc/lab/session/session-docker-contract.js';

export const PTC_TEST_SESSION_DOCKER_CONTAINER_ID = 'container-ptc-test-1';
export const PTC_TEST_SESSION_DOCKER_HOST_USER: PtcSessionDockerHostUser = {
  hostUserPolicyId: PTC_SESSION_DOCKER_HOST_USER_POLICY_ID,
  uid: 1000,
  gid: 1000,
};
export const PTC_TEST_STATE_ROOT_REALPATH = '/real/workspace/project-a';

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
    realpathStateRoot?: (stateRoot: string) => Promise<string>;
    stateRootRealpath?: string;
  },
  fn: (fixture: PtcSessionDockerManagerFixture) => Promise<T>,
): Promise<T> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'geulbat-ptc-session-'));
  try {
    const fixture = createPtcSessionDockerCommandFixture(args);
    const manager = createPtcSessionDockerManager({
      runtimeRoot,
      policy: fixture.policy,
      hostUser: PTC_TEST_SESSION_DOCKER_HOST_USER,
      commandRunner: fixture.runner,
      realpathStateRoot:
        args.realpathStateRoot ??
        (async (stateRoot) => {
          assert.equal(stateRoot, args.identity.stateRoot);
          return args.stateRootRealpath ?? PTC_TEST_STATE_ROOT_REALPATH;
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
    if (invocation.args[0] === 'network') {
      // Slice 1b open egress bridge ensure. Default to "bridge present" so the
      // adopt path is behavior-preserving for existing open-network tests;
      // tests that exercise the create path override via commandResult.
      if (invocation.args[1] === 'inspect') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: JSON.stringify([
            { Name: invocation.args.at(-1), Driver: 'bridge' },
          ]),
          stderr: '',
        };
      }
      if (invocation.args[1] === 'create') {
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'network-id\n',
          stderr: '',
        };
      }
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
      (item.endsWith(`,dst=${containerPath}`) ||
        item.endsWith(`,dst=${containerPath},readonly`)),
  );
  assert.ok(mountSpec);
  const hostPath = /^type=bind,src=([^,]+),dst=.+$/u.exec(mountSpec)?.[1];
  assert.ok(hostPath);
  return hostPath;
}
