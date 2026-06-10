import { isRecord } from '@geulbat/protocol/runtime-utils';
import {
  validatePtcLabBrowserSessionPolicy,
  type PtcLabBrowserPolicy,
} from './lab-browser-policy.js';
import type { PtcLabAdmittedProfile } from './lab-profile.js';
import type { PtcSessionDockerHandle } from './session-docker-contract.js';
import {
  type PtcLabBrowserPageLoadEvidenceResult,
  type PtcLabBrowserPageLoadEvidenceRuntimeInput,
  browserPageLoadEvidenceFailure,
} from './lab-browser-page-load-evidence-contract.js';
import {
  digestPtcLabBrowserUserUrlNavigationTarget,
  normalizePtcLabBrowserUserUrlNavigationTarget,
  type PtcLabBrowserUserUrlNavigationRequest,
  type PtcLabBrowserUserUrlNavigationTarget,
} from './lab-browser-url-navigation.js';

export interface PtcLabBrowserPageLoadEvidencePolicy {
  policyId: string;
  browser: Extract<PtcLabBrowserPolicy, { mode: 'page_load_evidence' }>;
  network: Extract<
    NonNullable<PtcLabAdmittedProfile['labPolicy']>['network'],
    { mode: 'open' }
  >;
}

export interface PtcLabBrowserValidatedPageLoadEvidenceRequest {
  target: PtcLabBrowserUserUrlNavigationTarget;
  timeoutMs: number;
}

const PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DEFAULT_TIMEOUT_MS = 5_000;

export function readBrowserPageLoadEvidencePolicy(
  admission: PtcLabAdmittedProfile | undefined,
): PtcLabBrowserPageLoadEvidenceResult<PtcLabBrowserPageLoadEvidencePolicy> {
  if (
    admission === undefined ||
    admission.metadata.selectedProfile !== 'lab' ||
    admission.labPolicy === undefined
  ) {
    return browserPageLoadEvidenceFailure(
      'ptc_lab_browser_policy_disabled',
      'PTC lab browser page-load evidence requires an admitted lab profile',
      'policy_admission',
    );
  }
  if (!admission.labPolicy.browser.enabled) {
    return browserPageLoadEvidenceFailure(
      'ptc_lab_browser_policy_disabled',
      'PTC lab browser page-load evidence policy is disabled',
      'policy_admission',
    );
  }
  if (admission.labPolicy.browser.mode !== 'page_load_evidence') {
    return browserPageLoadEvidenceFailure(
      'ptc_lab_browser_policy_mismatch',
      'PTC lab browser page-load evidence requires page-load evidence browser policy identity',
      'policy_admission',
    );
  }
  if (admission.labPolicy.network.mode !== 'open') {
    return browserPageLoadEvidenceFailure(
      'ptc_lab_browser_network_disabled',
      'PTC lab browser page-load evidence requires admitted lab open network policy',
      'policy_admission',
    );
  }
  if (
    admission.labPolicy.browser.networkPolicyId !==
      admission.labPolicy.network.networkPolicyId ||
    admission.labPolicy.network.metricsCoverage === 'runtime_observed'
  ) {
    return browserPageLoadEvidenceFailure(
      'ptc_lab_browser_policy_mismatch',
      'PTC lab browser page-load evidence policy is not compatible with admitted network policy',
      'policy_admission',
    );
  }

  return {
    ok: true,
    value: {
      policyId: admission.labPolicy.policyId,
      browser: admission.labPolicy.browser,
      network: admission.labPolicy.network,
    },
  };
}

export function validateBrowserPageLoadEvidenceRequest(args: {
  request: PtcLabBrowserUserUrlNavigationRequest | unknown;
  maxTimeoutMs: number;
}): PtcLabBrowserPageLoadEvidenceResult<PtcLabBrowserValidatedPageLoadEvidenceRequest> {
  const timeout = validateBrowserPageLoadEvidenceTimeout({
    timeoutMs: isRecord(args.request) ? args.request.timeoutMs : undefined,
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

export function validateBrowserPageLoadEvidenceRuntimeInput(args: {
  input: PtcLabBrowserPageLoadEvidenceRuntimeInput;
  maxTimeoutMs: number;
}): PtcLabBrowserPageLoadEvidenceResult<PtcLabBrowserValidatedPageLoadEvidenceRequest> {
  const timeout = validateBrowserPageLoadEvidenceTimeout({
    timeoutMs: args.input.timeoutMs,
    maxTimeoutMs: args.maxTimeoutMs,
  });
  if (!timeout.ok) {
    return timeout;
  }
  if (!targetDigestMatches(args.input.target)) {
    return browserPageLoadEvidenceFailure(
      'ptc_lab_browser_target_digest_mismatch',
      'PTC lab browser page-load evidence target digest does not match normalized target',
      'target_verification',
      { targetDigest: args.input.target.targetDigest },
    );
  }

  return {
    ok: true,
    value: { target: args.input.target, timeoutMs: timeout.value },
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
  const timeoutMs =
    args.timeoutMs ?? PTC_LAB_BROWSER_PAGE_LOAD_EVIDENCE_DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > args.maxTimeoutMs
  ) {
    return browserPageLoadEvidenceFailure(
      'ptc_lab_browser_request_invalid',
      'PTC lab browser page-load evidence timeout is invalid',
      'request_admission',
    );
  }
  return { ok: true, value: timeoutMs };
}

function targetDigestMatches(
  target: PtcLabBrowserUserUrlNavigationTarget,
): boolean {
  return (
    digestPtcLabBrowserUserUrlNavigationTarget({
      url: target.url,
      method: target.method,
      callerHeadersPolicyId: target.callerHeadersPolicyId,
      bodyPolicyId: target.bodyPolicyId,
      urlGrammarPolicyId: target.urlGrammarPolicyId,
    }) === target.targetDigest
  );
}
