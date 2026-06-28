import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY } from '../daemon/ptc/lab/browser/page-load-evidence/lab-browser-page-load-evidence-contract.js';
import { PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT } from '../daemon/ptc/lab/browser/core/lab-browser-runtime-script.js';
import { createPtcLabBrowserPageLoadEvidencePolicy } from '../daemon/ptc/lab/browser/core/lab-browser-policy.js';
import type { PtcLabBrowserEvidenceChecks } from '../daemon/ptc/shared/browser-evidence-contract.js';
import type { PtcLabBrowserUserUrlNavigationRequest } from '../daemon/ptc/lab/browser/core/lab-browser-url-navigation.js';
import { PTC_SESSION_DOCKER_CALLBACK_CONTAINER_ROOT } from '../daemon/ptc/lab/session/session-docker-contract.js';
import {
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
import { PTC_TEST_PRIVATE_GEULBAT_SECRET_PATH } from './ptc-private-path.js';
import {
  createPtcBrowserTestLab,
  type PtcBrowserTestLab,
} from './ptc-browser-lab.js';
import { ptcBrowserAdapterStdout } from './ptc-browser-stdout.js';

export const PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_PRIVATE_PATH =
  PTC_TEST_PRIVATE_GEULBAT_SECRET_PATH;

export const PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_IDENTITY: PtcSessionDockerIdentity =
  Object.freeze({
    threadId: 'thread-browser-page-load-evidence',
    workspaceRoot: '/workspace/project-a',
    trustContextId: 'trust-local-v1',
  });

export const PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS: Omit<
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

export interface BrowserPageLoadEvidenceExecInput {
  targetUrl: string;
  timeoutMs: number;
  loadWaitState: 'domcontentloaded';
}

export function createBrowserPageLoadEvidenceLab(
  args: {
    browserMaxNavigationMs?: number;
    networkMode?: 'open' | 'disabled';
  } = {},
): PtcBrowserTestLab {
  return createPtcBrowserTestLab({
    policyId: 'ptc_lab_browser_page_load_evidence_test_policy_v1',
    browser: createPtcLabBrowserPageLoadEvidencePolicy({
      maxNavigationMs: args.browserMaxNavigationMs ?? 5_000,
    }),
    ...(args.networkMode === undefined
      ? {}
      : { networkMode: args.networkMode }),
    admissionErrorMessage: 'expected browser page-load evidence lab admission',
  });
}

export function browserPageLoadEvidenceRequest(
  overrides: Partial<PtcLabBrowserUserUrlNavigationRequest> = {},
): PtcLabBrowserUserUrlNavigationRequest {
  return {
    url: 'https://example.com/private?access_token=secret#id_token=secret',
    ...overrides,
  };
}

export async function withBrowserPageLoadEvidenceSessionManager<T>(
  args: {
    policy?: PtcSessionDockerPolicy;
    createResult?: PtcSessionDockerCommandResult;
    evidenceResult?: PtcSessionDockerCommandResult;
    onExec?: (args: {
      invocation: PtcSessionDockerCommandInvocation;
      input: BrowserPageLoadEvidenceExecInput;
      inputHostPath: string;
      inputContainerPath: string;
    }) => void | Promise<void>;
  },
  fn: (fixture: PtcSessionDockerManagerFixture) => Promise<T>,
): Promise<T> {
  let callbackRootHostPath = '';
  return await withRealPtcSessionDockerManager(
    {
      identity: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_IDENTITY,
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
        assert.equal(invocation.args[1], PTC_TEST_SESSION_DOCKER_CONTAINER_ID);
        const nodeIndex = invocation.args.indexOf('node');
        assert.notEqual(nodeIndex, -1);
        assert.equal(invocation.args[nodeIndex + 1], '-e');
        assert.equal(
          invocation.args[nodeIndex + 2],
          PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
        );
        const inputContainerPath = invocation.args.at(-1);
        assert.ok(inputContainerPath);
        assert.notEqual(
          inputContainerPath,
          PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_RUNTIME_SCRIPT,
        );
        const inputHostPath = join(
          callbackRootHostPath,
          basename(inputContainerPath),
        );
        const input = JSON.parse(
          await readFile(inputHostPath, 'utf8'),
        ) as BrowserPageLoadEvidenceExecInput;
        await args.onExec?.({
          invocation,
          input,
          inputHostPath,
          inputContainerPath,
        });
        return (
          args.evidenceResult ?? {
            kind: 'exit',
            exitCode: 0,
            stdout: browserPageLoadEvidenceStdout({
              ok: true,
              checks: PTC_BROWSER_PAGE_LOAD_EVIDENCE_TEST_SUCCESS_CHECKS,
            }),
            stderr: '',
          }
        );
      },
    },
    fn,
  );
}

export function browserPageLoadEvidenceStdout(
  args:
    | {
        ok: true;
        checks: Omit<PtcLabBrowserEvidenceChecks, 'targetVerified'>;
        finalUrlDigest?: `sha256:${string}`;
        statusCode?: number;
        title?: string;
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
      capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
    });
  }

  return ptcBrowserAdapterStdout({
    ok: true,
    capability: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_CAPABILITY,
    checks: args.checks,
    successFields: {
      loadOutcome: 'loaded',
      loadState: 'domcontentloaded',
      finalUrlDigest:
        args.finalUrlDigest ??
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      responseStatus:
        args.statusCode === undefined
          ? undefined
          : {
              code: args.statusCode,
              source: 'final_main_resource_response',
            },
      title: args.title ?? 'Example Domain',
      redirectCount: args.redirectCount ?? 0,
      navigationDurationMs: args.navigationDurationMs ?? 37,
    },
  });
}
