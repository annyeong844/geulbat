import type { PtcLabBrowserUserUrlNavigationChecks } from '../daemon/ptc/lab/browser/user-url-navigation/lab-browser-user-url-navigation-contract.js';
import { PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT } from '../daemon/ptc/lab/browser/core/lab-browser-runtime-script.js';
import {
  PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY,
  type PtcLabBrowserUserUrlNavigationRequest,
} from '../daemon/ptc/lab/browser/core/lab-browser-url-navigation.js';
import { createPtcLabBrowserUserUrlNavigationPolicy } from '../daemon/ptc/lab/browser/core/lab-browser-policy.js';
import {
  type PtcSessionDockerCommandResult,
  type PtcSessionDockerIdentity,
  type PtcSessionDockerPolicy,
} from '../daemon/ptc/lab/session/session-docker-contract.js';
import type { PtcSessionDockerManagerFixture } from './ptc-session-docker.js';
import { PTC_TEST_PRIVATE_GEULBAT_SECRET_PATH } from './ptc-private-path.js';
import {
  createPtcBrowserTestLab,
  type PtcBrowserRuntimeExecContext,
  type PtcBrowserTestLab,
  withPtcBrowserRuntimeSessionManager,
} from './ptc-browser-lab.js';
import { ptcBrowserAdapterStdout } from './ptc-browser-stdout.js';

export const PTC_BROWSER_USER_URL_NAVIGATION_TEST_PRIVATE_PATH =
  PTC_TEST_PRIVATE_GEULBAT_SECRET_PATH;

export const PTC_BROWSER_USER_URL_NAVIGATION_TEST_IDENTITY: PtcSessionDockerIdentity =
  Object.freeze({
    threadId: 'thread-browser-user-url-navigation',
    stateRoot: '/workspace/project-a',
    trustContextId: 'trust-local-v1',
  });

export const PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS: Omit<
  PtcLabBrowserUserUrlNavigationChecks,
  'targetVerified'
> = Object.freeze({
  engineAvailable: true,
  contextCreated: true,
  navigationStarted: true,
  navigationSettled: true,
  redirectPolicyEnforced: true,
  downloadPolicyEnforced: true,
  cleanupCompleted: true,
});

export interface BrowserUserUrlNavigationExecInput {
  targetUrl: string;
  timeoutMs: number;
  loadWaitState: 'domcontentloaded';
}

export function createBrowserUserUrlNavigationLab(
  args: {
    browserMaxActionMs?: number;
    networkMode?: 'open' | 'disabled';
  } = {},
): PtcBrowserTestLab {
  return createPtcBrowserTestLab({
    policyId: 'ptc_lab_browser_user_url_navigation_test_policy_v1',
    browser: createPtcLabBrowserUserUrlNavigationPolicy({
      maxActionMs: args.browserMaxActionMs ?? 5_000,
    }),
    ...(args.networkMode === undefined
      ? {}
      : { networkMode: args.networkMode }),
    admissionErrorMessage: 'expected browser user URL navigation lab admission',
  });
}

export function browserUserUrlNavigationRequest(
  overrides: Partial<PtcLabBrowserUserUrlNavigationRequest> = {},
): PtcLabBrowserUserUrlNavigationRequest {
  return {
    url: 'https://example.com/private?access_token=secret#id_token=secret',
    ...overrides,
  };
}

export async function withBrowserUserUrlNavigationSessionManager<T>(
  args: {
    policy?: PtcSessionDockerPolicy;
    createResult?: PtcSessionDockerCommandResult;
    navigationResult?: PtcSessionDockerCommandResult;
    onExec?: (
      args: PtcBrowserRuntimeExecContext<BrowserUserUrlNavigationExecInput>,
    ) => void | Promise<void>;
  },
  fn: (fixture: PtcSessionDockerManagerFixture) => Promise<T>,
): Promise<T> {
  return await withPtcBrowserRuntimeSessionManager(
    {
      identity: PTC_BROWSER_USER_URL_NAVIGATION_TEST_IDENTITY,
      runtimeScript: PTC_LAB_BROWSER_USER_URL_NAVIGATION_RUNTIME_SCRIPT,
      ...(args.policy === undefined ? {} : { policy: args.policy }),
      ...(args.createResult === undefined
        ? {}
        : { createResult: args.createResult }),
      ...(args.onExec === undefined ? {} : { onExec: args.onExec }),
      execResult: () =>
        args.navigationResult ?? {
          kind: 'exit',
          exitCode: 0,
          stdout: browserUserUrlNavigationStdout({
            ok: true,
            checks: PTC_BROWSER_USER_URL_NAVIGATION_TEST_SUCCESS_CHECKS,
          }),
          stderr: '',
        },
    },
    fn,
  );
}

export function browserUserUrlNavigationStdout(
  args:
    | {
        ok: true;
        checks: Omit<PtcLabBrowserUserUrlNavigationChecks, 'targetVerified'>;
      }
    | {
        ok: false;
        checks: Omit<PtcLabBrowserUserUrlNavigationChecks, 'targetVerified'>;
        errorCode:
          | 'browser_runtime_unavailable'
          | 'navigation_failed'
          | 'redirect_disallowed'
          | 'download_disallowed'
          | 'popup_disallowed'
          | 'cleanup_failed'
          | 'cleanup_uncertain';
      },
): string {
  return ptcBrowserAdapterStdout({
    ...args,
    capability: PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY,
  });
}
