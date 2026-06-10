import assert from 'node:assert/strict';
import {
  PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_CAPABILITY,
  PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_SCRIPT,
  type PtcLabBrowserFixedRuntimeProbeChecks,
  type PtcLabBrowserFixedRuntimeProbeRequest,
} from '../daemon/ptc/lab-browser-runtime-contract.js';
import { createPtcLabBrowserFixedRuntimeProbePolicy } from '../daemon/ptc/lab-browser-policy.js';
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

export const PTC_BROWSER_RUNTIME_TEST_PRIVATE_PATH =
  PTC_TEST_PRIVATE_GEULBAT_SECRET_PATH;

export const PTC_BROWSER_RUNTIME_TEST_IDENTITY: PtcSessionDockerIdentity =
  Object.freeze({
    threadId: 'thread-browser-runtime',
    workspaceRoot: '/workspace/project-a',
    trustContextId: 'trust-local-v1',
  });

export const PTC_BROWSER_RUNTIME_TEST_SUCCESS_CHECKS: PtcLabBrowserFixedRuntimeProbeChecks =
  Object.freeze({
    engineAvailable: true,
    contextCreated: true,
    controlledDocumentReady: true,
    cleanupCompleted: true,
  });

export function createBrowserRuntimeLab(
  args: {
    browserMaxActionMs?: number;
    networkMode?: 'open' | 'disabled';
  } = {},
): PtcBrowserTestLab {
  return createPtcBrowserTestLab({
    policyId: 'ptc_lab_browser_runtime_test_policy_v1',
    browser: createPtcLabBrowserFixedRuntimeProbePolicy({
      maxActionMs: args.browserMaxActionMs ?? 5_000,
    }),
    ...(args.networkMode === undefined
      ? {}
      : { networkMode: args.networkMode }),
    admissionErrorMessage: 'expected browser runtime lab admission',
  });
}

export function createDisabledBrowserAdmission(): PtcLabAdmittedProfile {
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

export async function withBrowserRuntimeSessionManager<T>(
  args: {
    policy?: PtcSessionDockerPolicy;
    createResult?: PtcSessionDockerCommandResult;
    runtimeResult?: PtcSessionDockerCommandResult;
    onExec?: (
      invocation: PtcSessionDockerCommandInvocation,
    ) => void | Promise<void>;
  },
  fn: (fixture: PtcSessionDockerManagerFixture) => Promise<T>,
): Promise<T> {
  return await withRealPtcSessionDockerManager(
    {
      identity: PTC_BROWSER_RUNTIME_TEST_IDENTITY,
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
          PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_SCRIPT,
        ]);
        await args.onExec?.(invocation);
        return (
          args.runtimeResult ?? {
            kind: 'exit',
            exitCode: 0,
            stdout: browserRuntimeStdout({
              ok: true,
              checks: PTC_BROWSER_RUNTIME_TEST_SUCCESS_CHECKS,
            }),
            stderr: '',
          }
        );
      },
    },
    fn,
  );
}

export function browserRuntimeRequest(
  overrides: Partial<PtcLabBrowserFixedRuntimeProbeRequest> = {},
): PtcLabBrowserFixedRuntimeProbeRequest {
  return { probeId: 'browser-runtime-probe-1', ...overrides };
}

export function browserRuntimeStdout(
  args:
    | { ok: true; checks: PtcLabBrowserFixedRuntimeProbeChecks }
    | {
        ok: false;
        checks: PtcLabBrowserFixedRuntimeProbeChecks;
        errorCode:
          | 'browser_runtime_unavailable'
          | 'execution_failed'
          | 'cleanup_failed'
          | 'cleanup_uncertain';
      },
): string {
  return ptcBrowserAdapterStdout({
    ...args,
    capability: PTC_LAB_BROWSER_FIXED_RUNTIME_PROBE_CAPABILITY,
  });
}
