import { isPtcRecord } from '../../../shared/record-shape.js';
import { admitPtcBoundedTimeoutMs } from '../../../shared/lab-spine.js';
import { validatePtcLabBrowserSessionPolicy } from '../core/lab-browser-identity.js';
import type { PtcLabBrowserPolicy } from '../core/lab-browser-policy.js';
import { readPtcLabOpenBrowserPolicy } from '../../profile/lab-browser-policy-admission.js';
import type { PtcLabAdmittedProfile } from '../../profile/lab-profile.js';
import type { PtcSessionDockerHandle } from '../../session/session-docker-contract.js';
import {
  type PtcLabBrowserPageLoadEvidenceResult,
  browserPageLoadEvidenceFailure,
} from './lab-browser-page-load-evidence-contract.js';
import {
  normalizePtcLabBrowserUserUrlNavigationTarget,
  type PtcLabBrowserValidatedUrlRequest,
} from '../core/lab-browser-url-navigation.js';

export interface PtcLabBrowserPageLoadEvidencePolicy {
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'page_load_evidence' }>;
  network: Extract<
    NonNullable<PtcLabAdmittedProfile['labPolicy']>['network'],
    { mode: 'open' }
  >;
  shell: NonNullable<PtcLabAdmittedProfile['labPolicy']>['shell'];
}

export type PtcLabBrowserValidatedPageLoadEvidenceRequest =
  PtcLabBrowserValidatedUrlRequest;

const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DEFAULT_TIMEOUT_MS = 5_000;

export function readBrowserPageLoadEvidencePolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabBrowserPageLoadEvidenceResult<PtcLabBrowserPageLoadEvidencePolicy> {
  const policy = readPtcLabOpenBrowserPolicy({
    admission,
    browserMode: 'page_load_evidence',
    modeMismatchMessage:
      'PTC lab browser page-load evidence requires page-load evidence browser policy identity',
    subject: 'page-load evidence',
  });
  if (!policy.ok) {
    return browserPageLoadEvidenceFailure(
      policy.reasonCode,
      policy.message,
      policy.phase,
    );
  }
  return policy;
}

export function validateBrowserPageLoadEvidenceRequest(args: {
  request: unknown;
  maxTimeoutMs: number;
}): PtcLabBrowserPageLoadEvidenceResult<PtcLabBrowserValidatedPageLoadEvidenceRequest> {
  const timeout = validateBrowserPageLoadEvidenceTimeout({
    timeoutMs: isPtcRecord(args.request) ? args.request.timeoutMs : undefined,
    maxTimeoutMs: args.maxTimeoutMs,
  });
  if (!timeout.ok) {
    return timeout;
  }
  const target = normalizePtcLabBrowserUserUrlNavigationTarget(args.request);
  if (!target.ok) {
    return browserPageLoadEvidenceFailure(
      'ptc_lab_browser_url_admission_failed',
      'PTC lab browser page-load evidence target admission failed',
      'request_admission',
      {
        diagnostics: target.diagnostics ?? {
          admissionReasonCode: target.reasonCode,
        },
      },
    );
  }

  return {
    ok: true,
    value: { target: target.value, timeoutMs: timeout.value },
  };
}

export function validateBrowserPageLoadEvidenceSession(args: {
  handle: PtcSessionDockerHandle;
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'page_load_evidence' }>;
  network: PtcLabBrowserPageLoadEvidencePolicy['network'];
}): PtcLabBrowserPageLoadEvidenceResult<void> {
  const sessionPolicy = validatePtcLabBrowserSessionPolicy({
    ...args,
    capabilityLabel: 'page-load evidence',
  });
  if (!sessionPolicy.ok) {
    return browserPageLoadEvidenceFailure(
      sessionPolicy.reasonCode,
      sessionPolicy.message,
      'session_acquisition',
    );
  }
  return sessionPolicy;
}

function validateBrowserPageLoadEvidenceTimeout(args: {
  timeoutMs: unknown;
  maxTimeoutMs: number;
}): PtcLabBrowserPageLoadEvidenceResult<number> {
  const timeout = admitPtcBoundedTimeoutMs({
    timeoutMs: args.timeoutMs,
    defaultTimeoutMs: PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: args.maxTimeoutMs,
  });
  if (!timeout.ok) {
    return browserPageLoadEvidenceFailure(
      'ptc_lab_browser_request_invalid',
      'PTC lab browser page-load evidence timeout is invalid',
      'request_admission',
    );
  }
  return timeout;
}
