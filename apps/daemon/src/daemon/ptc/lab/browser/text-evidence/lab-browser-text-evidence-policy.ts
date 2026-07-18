import { isPtcRecord } from '../../../shared/record-shape.js';
import { admitPtcBoundedTimeoutMs } from '../../../shared/lab-spine.js';
import { validatePtcLabBrowserSessionPolicy } from '../core/lab-browser-identity.js';
import type { PtcLabBrowserPolicy } from '../core/lab-browser-policy.js';
import { readPtcLabOpenBrowserPolicy } from '../../profile/lab-browser-policy-admission.js';
import type { PtcLabAdmittedProfile } from '../../profile/lab-profile.js';
import type { PtcSessionDockerHandle } from '../../session/session-docker-contract.js';
import {
  type PtcLabBrowserTextEvidenceResult,
  browserTextEvidenceFailure,
} from './lab-browser-text-evidence-contract.js';
import {
  normalizePtcLabBrowserUserUrlNavigationTarget,
  type PtcLabBrowserValidatedUrlRequest,
} from '../core/lab-browser-url-navigation.js';

export interface PtcLabBrowserTextEvidencePolicy {
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'dom_text_evidence' }>;
  network: Extract<
    NonNullable<PtcLabAdmittedProfile['labPolicy']>['network'],
    { mode: 'open' }
  >;
  shell: NonNullable<PtcLabAdmittedProfile['labPolicy']>['shell'];
}

export type PtcLabBrowserValidatedTextEvidenceRequest =
  PtcLabBrowserValidatedUrlRequest;

const PTC_LAB_BROWSER_TEXT_EVIDENCE_DEFAULT_TIMEOUT_MS = 5_000;

export function readBrowserTextEvidencePolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabBrowserTextEvidenceResult<PtcLabBrowserTextEvidencePolicy> {
  const policy = readPtcLabOpenBrowserPolicy({
    admission,
    browserMode: 'dom_text_evidence',
    modeMismatchMessage:
      'PTC lab browser text evidence requires DOM text evidence browser policy identity',
    subject: 'text evidence',
  });
  if (!policy.ok) {
    return browserTextEvidenceFailure(
      policy.reasonCode,
      policy.message,
      policy.phase,
    );
  }
  return policy;
}

export function validateBrowserTextEvidenceRequest(args: {
  request: unknown;
  maxTimeoutMs: number;
}): PtcLabBrowserTextEvidenceResult<PtcLabBrowserValidatedTextEvidenceRequest> {
  const timeout = validateBrowserTextEvidenceTimeout({
    timeoutMs: isPtcRecord(args.request) ? args.request.timeoutMs : undefined,
    maxTimeoutMs: args.maxTimeoutMs,
  });
  if (!timeout.ok) {
    return timeout;
  }
  const target = normalizePtcLabBrowserUserUrlNavigationTarget(args.request);
  if (!target.ok) {
    return browserTextEvidenceFailure(
      'ptc_lab_browser_url_admission_failed',
      'PTC lab browser text evidence target admission failed',
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
    value: {
      target: target.value,
      timeoutMs: timeout.value,
    },
  };
}

export function validateBrowserTextEvidenceSession(args: {
  handle: PtcSessionDockerHandle;
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'dom_text_evidence' }>;
  network: PtcLabBrowserTextEvidencePolicy['network'];
}): PtcLabBrowserTextEvidenceResult<void> {
  const sessionPolicy = validatePtcLabBrowserSessionPolicy({
    ...args,
    capabilityLabel: 'text evidence',
  });
  if (!sessionPolicy.ok) {
    return browserTextEvidenceFailure(
      sessionPolicy.reasonCode,
      sessionPolicy.message,
      'session_acquisition',
    );
  }
  return sessionPolicy;
}

function validateBrowserTextEvidenceTimeout(args: {
  timeoutMs: unknown;
  maxTimeoutMs: number;
}): PtcLabBrowserTextEvidenceResult<number> {
  const timeout = admitPtcBoundedTimeoutMs({
    timeoutMs: args.timeoutMs,
    defaultTimeoutMs: PTC_LAB_BROWSER_TEXT_EVIDENCE_DEFAULT_TIMEOUT_MS,
    maxTimeoutMs: args.maxTimeoutMs,
  });
  if (!timeout.ok) {
    return browserTextEvidenceFailure(
      'ptc_lab_browser_request_invalid',
      'PTC lab browser text evidence timeout is invalid',
      'request_admission',
    );
  }
  return timeout;
}
