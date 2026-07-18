import {
  PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY,
  type PtcLabBrowserTextEvidenceRequest,
} from '../daemon/ptc/lab/browser/text-evidence/lab-browser-text-evidence-contract.js';
import { PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT } from '../daemon/ptc/lab/browser/core/lab-browser-runtime-script.js';
import { createPtcLabBrowserTextEvidencePolicy } from '../daemon/ptc/lab/browser/core/lab-browser-policy.js';
import type { PtcLabBrowserEvidenceChecks } from '../daemon/ptc/shared/browser-evidence-contract.js';
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
import {
  ptcBrowserAdapterStdout,
  ptcBrowserEvidenceSuccessStdout,
} from './ptc-browser-stdout.js';

export const PTC_BROWSER_TEXT_EVIDENCE_TEST_PRIVATE_PATH =
  PTC_TEST_PRIVATE_GEULBAT_SECRET_PATH;

export const PTC_BROWSER_TEXT_EVIDENCE_TEST_IDENTITY: PtcSessionDockerIdentity =
  Object.freeze({
    threadId: 'thread-browser-text-evidence',
    stateRoot: '/workspace/project-a',
    trustContextId: 'trust-local-v1',
  });

export const PTC_BROWSER_TEXT_EVIDENCE_TEST_SUCCESS_CHECKS: Omit<
  PtcLabBrowserEvidenceChecks,
  'targetVerified'
> = Object.freeze({
  engineAvailable: true,
  contextCreated: true,
  navigationStarted: true,
  navigationSettled: true,
  redirectPolicyEnforced: true,
  downloadPolicyEnforced: true,
  popupPolicyEnforced: true,
  evidenceCaptured: true,
  cleanupCompleted: true,
});

export interface BrowserTextEvidenceExecInput {
  targetUrl: string;
  timeoutMs: number;
  loadWaitState: 'domcontentloaded';
}

export function createBrowserTextEvidenceLab(
  args: {
    browserMaxNavigationMs?: number;
    networkMode?: 'open' | 'disabled';
  } = {},
): PtcBrowserTestLab {
  return createPtcBrowserTestLab({
    policyId: 'ptc_lab_browser_text_evidence_test_policy_v1',
    browser: createPtcLabBrowserTextEvidencePolicy({
      maxNavigationMs: args.browserMaxNavigationMs ?? 5_000,
    }),
    ...(args.networkMode === undefined
      ? {}
      : { networkMode: args.networkMode }),
    admissionErrorMessage: 'expected browser text evidence lab admission',
  });
}

export function browserTextEvidenceRequest(
  overrides: Partial<PtcLabBrowserTextEvidenceRequest> = {},
): PtcLabBrowserTextEvidenceRequest {
  return {
    url: 'https://example.com/private?access_token=secret#id_token=secret',
    ...overrides,
  };
}

export async function withBrowserTextEvidenceSessionManager<T>(
  args: {
    policy?: PtcSessionDockerPolicy;
    createResult?: PtcSessionDockerCommandResult;
    evidenceResult?: PtcSessionDockerCommandResult;
    onExec?: (
      args: PtcBrowserRuntimeExecContext<BrowserTextEvidenceExecInput>,
    ) => void | Promise<void>;
  },
  fn: (fixture: PtcSessionDockerManagerFixture) => Promise<T>,
): Promise<T> {
  return await withPtcBrowserRuntimeSessionManager(
    {
      identity: PTC_BROWSER_TEXT_EVIDENCE_TEST_IDENTITY,
      runtimeScript: PTC_LAB_BROWSER_TEXT_EVIDENCE_RUNTIME_SCRIPT,
      ...(args.policy === undefined ? {} : { policy: args.policy }),
      ...(args.createResult === undefined
        ? {}
        : { createResult: args.createResult }),
      ...(args.onExec === undefined ? {} : { onExec: args.onExec }),
      execResult: () =>
        args.evidenceResult ?? {
          kind: 'exit',
          exitCode: 0,
          stdout: browserTextEvidenceStdout({
            ok: true,
            checks: PTC_BROWSER_TEXT_EVIDENCE_TEST_SUCCESS_CHECKS,
          }),
          stderr: '',
        },
    },
    fn,
  );
}

export function browserTextEvidenceStdout(
  args:
    | {
        ok: true;
        checks: Omit<PtcLabBrowserEvidenceChecks, 'targetVerified'>;
        finalUrlDigest?: `sha256:${string}`;
        visibleText?: string;
        redirectCount?: number;
        navigationDurationMs?: number;
      }
    | {
        ok: false;
        checks: Omit<PtcLabBrowserEvidenceChecks, 'targetVerified'>;
        errorCode:
          | 'browser_runtime_unavailable'
          | 'navigation_failed'
          | 'redirect_disallowed'
          | 'download_disallowed'
          | 'popup_disallowed'
          | 'evidence_unavailable'
          | 'evidence_output_invalid'
          | 'cleanup_failed'
          | 'cleanup_uncertain';
      },
): string {
  if (!args.ok) {
    return ptcBrowserAdapterStdout({
      ...args,
      capability: PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY,
    });
  }

  return ptcBrowserEvidenceSuccessStdout({
    capability: PTC_LAB_BROWSER_TEXT_EVIDENCE_CAPABILITY,
    checks: args.checks,
    ...(args.finalUrlDigest === undefined
      ? {}
      : { finalUrlDigest: args.finalUrlDigest }),
    evidenceFields: {
      visibleText: args.visibleText ?? 'Example Domain Visible Text',
    },
    ...(args.redirectCount === undefined
      ? {}
      : { redirectCount: args.redirectCount }),
    ...(args.navigationDurationMs === undefined
      ? {}
      : { navigationDurationMs: args.navigationDurationMs }),
  });
}
