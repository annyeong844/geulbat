import assert from 'node:assert/strict';
import {
  PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_CAPABILITY,
  PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_SCRIPT,
  PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_REF,
  type PtcLabBrowserFixedNavigationProbeChecks,
  type PtcLabBrowserFixedNavigationProbeRequest,
} from '../daemon/ptc/lab-browser-navigation-contract.js';
import { createPtcLabBrowserFixedNavigationProbePolicy } from '../daemon/ptc/lab-browser-policy.js';
import {
  admitPtcExecutionProfile,
  type PtcLabAdmittedProfile,
} from '../daemon/ptc/lab-profile.js';
import type {
  PtcSessionDockerCommandInvocation,
  PtcSessionDockerCommandResult,
  PtcSessionDockerIdentity,
  PtcSessionDockerPolicy,
} from '../daemon/ptc/session-docker-contract.js';
import {
  PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
  withRealPtcSessionDockerManager,
  type PtcSessionDockerManagerFixture,
} from './ptc-session-docker.js';
import { PTC_TEST_PRIVATE_GEULBAT_SECRET_PATH } from './ptc-private-path.js';
import {
  createPtcBrowserTestLab,
  type PtcBrowserTestLab,
} from './ptc-browser-lab.js';
import { ptcBrowserAdapterStdout } from './ptc-browser-stdout.js';

export const PTC_BROWSER_NAVIGATION_TEST_PRIVATE_PATH =
  PTC_TEST_PRIVATE_GEULBAT_SECRET_PATH;

export const PTC_BROWSER_NAVIGATION_TEST_IDENTITY: PtcSessionDockerIdentity =
  Object.freeze({
    threadId: 'thread-browser-navigation',
    workspaceRoot: '/workspace/project-a',
    trustContextId: 'trust-local-v1',
  });

export const PTC_BROWSER_NAVIGATION_TEST_SUCCESS_CHECKS: PtcLabBrowserFixedNavigationProbeChecks =
  Object.freeze({
    engineAvailable: true,
    contextCreated: true,
    navigationCommitted: true,
    loadStateReached: true,
    cleanupCompleted: true,
  });

export function createBrowserNavigationLab(
  args: {
    browserMaxActionMs?: number;
    networkMode?: 'open' | 'disabled';
  } = {},
): PtcBrowserTestLab {
  return createPtcBrowserTestLab({
    policyId: 'ptc_lab_browser_navigation_test_policy_v1',
    browser: createPtcLabBrowserFixedNavigationProbePolicy({
      maxActionMs: args.browserMaxActionMs ?? 5_000,
    }),
    ...(args.networkMode === undefined
      ? {}
      : { networkMode: args.networkMode }),
    admissionErrorMessage: 'expected browser navigation lab admission',
  });
}

export function createDisabledBrowserNavigationAdmission(): PtcLabAdmittedProfile {
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
  });
  if (!admission.ok) {
    throw new Error('expected disabled lab admission');
  }
  return admission.value;
}

export async function withBrowserNavigationSessionManager<T>(
  args: {
    policy?: PtcSessionDockerPolicy;
    createResult?: PtcSessionDockerCommandResult;
    navigationResult?: PtcSessionDockerCommandResult;
    onExec?: (
      invocation: PtcSessionDockerCommandInvocation,
    ) => void | Promise<void>;
  },
  fn: (fixture: PtcSessionDockerManagerFixture) => Promise<T>,
): Promise<T> {
  return await withRealPtcSessionDockerManager(
    {
      identity: PTC_BROWSER_NAVIGATION_TEST_IDENTITY,
      ...(args.policy === undefined ? {} : { policy: args.policy }),
      ...(args.createResult === undefined
        ? {}
        : { createResult: args.createResult }),
      commandResult: async (invocation) => {
        if (invocation.args[0] !== 'exec') {
          return undefined;
        }
        assert.deepEqual(invocation.args, [
          'exec',
          PTC_TEST_SESSION_DOCKER_CONTAINER_ID,
          'node',
          '-e',
          PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_SCRIPT,
        ]);
        await args.onExec?.(invocation);
        return (
          args.navigationResult ?? {
            kind: 'exit',
            exitCode: 0,
            stdout: browserNavigationStdout({
              ok: true,
              checks: PTC_BROWSER_NAVIGATION_TEST_SUCCESS_CHECKS,
            }),
            stderr: '',
          }
        );
      },
    },
    fn,
  );
}

export function browserNavigationRequest(
  overrides: Partial<PtcLabBrowserFixedNavigationProbeRequest> = {},
): PtcLabBrowserFixedNavigationProbeRequest {
  return {
    probeId: 'browser-navigation-probe-1',
    targetRef: PTC_LAB_BROWSER_FIXED_NAVIGATION_TARGET_REF,
    ...overrides,
  };
}

export function browserNavigationStdout(
  args:
    | { ok: true; checks: PtcLabBrowserFixedNavigationProbeChecks }
    | {
        ok: false;
        checks: PtcLabBrowserFixedNavigationProbeChecks;
        errorCode:
          | 'browser_runtime_unavailable'
          | 'target_unavailable'
          | 'navigation_failed'
          | 'cleanup_failed'
          | 'cleanup_uncertain';
      },
): string {
  return ptcBrowserAdapterStdout({
    ...args,
    capability: PTC_LAB_BROWSER_FIXED_NAVIGATION_PROBE_CAPABILITY,
  });
}
