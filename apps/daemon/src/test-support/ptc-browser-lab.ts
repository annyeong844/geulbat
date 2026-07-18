import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerPolicyProjection,
  type PtcLabAdmittedProfile,
  type PtcLabPolicyProjection,
} from '../daemon/ptc/lab/profile/lab-profile.js';
import type { PtcLabPolicyId } from '../daemon/ptc/lab/profile/lab-profile-contract.js';
import { createPtcLabOpenEgressLocalPolicy } from '../daemon/ptc/lab/network/lab-network-policy.js';
import {
  PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_DEFAULT_POLICY,
  type PtcSessionDockerCommandInvocation,
  type PtcSessionDockerCommandResult,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerPolicy,
} from '../daemon/ptc/lab/session/session-docker-contract.js';
import {
  PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
  readPtcSessionDockerBindMountHostPath,
  withRealPtcSessionDockerManager,
  type PtcSessionDockerManagerFixture,
} from './ptc-session-docker.js';

type PtcBrowserTestLabNetworkMode = 'open' | 'disabled';

export interface PtcBrowserTestLab {
  admission: PtcLabAdmittedProfile;
  labPolicy: PtcLabPolicyProjection;
  dockerPolicy: PtcSessionDockerPolicy;
}

export interface PtcBrowserRuntimeExecContext<Input> {
  invocation: PtcSessionDockerCommandInvocation;
  input: Input;
  inputHostPath: string;
  inputContainerPath: string;
}

interface WithPtcBrowserRuntimeSessionManagerArgs<Input> {
  identity: PtcSessionDockerIdentity;
  runtimeScript: string;
  policy?: PtcSessionDockerPolicy;
  createResult?: PtcSessionDockerCommandResult;
  onExec?: (args: PtcBrowserRuntimeExecContext<Input>) => void | Promise<void>;
  execResult: (
    args: PtcBrowserRuntimeExecContext<Input>,
  ) => PtcSessionDockerCommandResult | Promise<PtcSessionDockerCommandResult>;
}

interface CreatePtcBrowserTestLabArgs {
  policyId: PtcLabPolicyId;
  browser: PtcLabPolicyProjection['browser'];
  networkMode?: PtcBrowserTestLabNetworkMode;
  admissionErrorMessage: string;
}

export function createPtcBrowserTestLab(
  args: CreatePtcBrowserTestLabArgs,
): PtcBrowserTestLab {
  const basePolicy = createPtcLabLocalDockerPolicyProjection();
  const labPolicy: PtcLabPolicyProjection = {
    ...basePolicy,
    policyId: args.policyId,
    network:
      args.networkMode === 'disabled'
        ? basePolicy.network
        : createPtcLabOpenEgressLocalPolicy({
            metricsCoverage: 'owner_outcome_only',
          }),
    browser: args.browser,
  };
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy,
  });
  if (!admission.ok) {
    throw new Error(args.admissionErrorMessage);
  }

  return {
    admission: admission.value,
    labPolicy,
    dockerPolicy: {
      ...PTC_SESSION_DOCKER_DEFAULT_POLICY,
      labPolicyId: labPolicy.policyId,
      network: labPolicy.network,
      browser: labPolicy.browser,
    },
  };
}

export async function withPtcBrowserRuntimeSessionManager<Input, T>(
  args: WithPtcBrowserRuntimeSessionManagerArgs<Input>,
  fn: (fixture: PtcSessionDockerManagerFixture) => Promise<T>,
): Promise<T> {
  let callbackRootHostPath = '';
  return await withRealPtcSessionDockerManager(
    {
      identity: args.identity,
      ...(args.policy === undefined ? {} : { policy: args.policy }),
      ...(args.createResult === undefined
        ? {}
        : { createResult: args.createResult }),
      commandResult: async (invocation) => {
        if (invocation.args[0] === 'create') {
          callbackRootHostPath = readPtcSessionDockerBindMountHostPath(
            invocation,
            PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT,
          );
          return undefined;
        }
        if (invocation.args[0] !== 'exec') {
          return undefined;
        }

        const inputContainerPath = invocation.args.at(-1);
        assert.ok(inputContainerPath);
        assert.deepEqual(invocation.args, [
          'exec',
          PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
          'node',
          '-e',
          args.runtimeScript,
          inputContainerPath,
        ]);
        const inputHostPath = join(
          callbackRootHostPath,
          basename(inputContainerPath),
        );
        const input = JSON.parse(
          await readFile(inputHostPath, 'utf8'),
        ) as Input;
        const context = {
          invocation,
          input,
          inputHostPath,
          inputContainerPath,
        };
        await args.onExec?.(context);
        return await args.execResult(context);
      },
    },
    fn,
  );
}
