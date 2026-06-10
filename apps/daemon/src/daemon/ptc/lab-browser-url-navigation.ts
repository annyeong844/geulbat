import { isRecord } from '@geulbat/protocol/runtime-utils';
import { sha256StableJson } from '@geulbat/shared-utils/stable-json';

export const PTC_LAB_BROWSER_USER_URL_NAVIGATION_CAPABILITY =
  'ptc_lab_browser_user_url_navigation' as const;
export const PTC_LAB_BROWSER_USER_URL_TARGET_NORMALIZATION_CAPABILITY =
  'ptc_lab_browser_user_url_target_normalization' as const;
export const PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID =
  'ptc_lab_browser_url_grammar_http_https_no_credentials_v1' as const;
export const PTC_LAB_BROWSER_CALLER_HEADERS_NONE_POLICY_ID =
  'ptc_lab_browser_caller_headers_none_v1' as const;
export const PTC_LAB_BROWSER_BODY_NONE_POLICY_ID =
  'ptc_lab_browser_body_none_v1' as const;
export const PTC_LAB_BROWSER_USER_URL_MAX_BYTES = 2048;

export type PtcLabBrowserUserUrlAdmissionReasonCode =
  | 'accepted'
  | 'url_not_string'
  | 'url_empty'
  | 'url_too_large'
  | 'url_parse_failed'
  | 'url_scheme_not_admitted_by_grammar_policy'
  | 'url_credentials_disallowed'
  | 'url_raw_control_character_disallowed'
  | 'unsupported_by_this_owner';

export type PtcLabBrowserUserUrlAdmissionFailureReasonCode = Exclude<
  PtcLabBrowserUserUrlAdmissionReasonCode,
  'accepted'
>;

export type PtcLabBrowserUserUrlUnsupportedFieldCategory =
  | 'browser_execution'
  | 'browser_evidence'
  | 'browser_action'
  | 'browser_crawler'
  | 'browser_artifact'
  | 'browser_runtime_policy'
  | 'caller_request_policy'
  | 'unknown';

export type PtcLabBrowserUserUrlTargetDigest = `sha256:${string}`;

export interface PtcLabBrowserUserUrlNavigationRequest {
  url: string;
  timeoutMs?: number;
}

export interface PtcLabBrowserUserUrlNavigationTarget {
  url: string;
  method: 'GET';
  callerHeadersPolicyId: typeof PTC_LAB_BROWSER_CALLER_HEADERS_NONE_POLICY_ID;
  bodyPolicyId: typeof PTC_LAB_BROWSER_BODY_NONE_POLICY_ID;
  urlGrammarPolicyId: typeof PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID;
  targetDigest: PtcLabBrowserUserUrlTargetDigest;
}

export type PtcLabBrowserUserUrlAdmissionResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: PtcLabBrowserUserUrlAdmissionFailureReasonCode;
      message: string;
      diagnostics?: Record<string, string | number | boolean>;
    };

type PtcLabBrowserUserUrlNavigationTargetDigestInput = Omit<
  PtcLabBrowserUserUrlNavigationTarget,
  'targetDigest'
>;

const ASCII_EDGE_WHITESPACE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu;
const EMBEDDED_ASCII_CONTROL_OR_WHITESPACE = /[\u0000-\u0020\u007F]/u;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const HTTP_OR_HTTPS_WITH_AUTHORITY = /^https?:\/\//iu;
const AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u;

const FUTURE_FIELD_CATEGORIES = new Map<
  string,
  PtcLabBrowserUserUrlUnsupportedFieldCategory
>([
  ['action', 'browser_action'],
  ['actions', 'browser_action'],
  ['artifactExport', 'browser_artifact'],
  ['artifactExportPolicyId', 'browser_artifact'],
  ['artifactRef', 'browser_artifact'],
  ['body', 'caller_request_policy'],
  ['browserEnginePolicyId', 'browser_runtime_policy'],
  ['browserHeadersPolicyId', 'browser_runtime_policy'],
  ['browserPolicyId', 'browser_runtime_policy'],
  ['browserRuntimePolicyId', 'browser_runtime_policy'],
  ['click', 'browser_action'],
  ['cookieStorePolicyId', 'browser_runtime_policy'],
  ['crawl', 'browser_crawler'],
  ['crawler', 'browser_crawler'],
  ['dom', 'browser_evidence'],
  ['domText', 'browser_evidence'],
  ['download', 'browser_artifact'],
  ['downloadPolicyId', 'browser_artifact'],
  ['downloads', 'browser_artifact'],
  ['evidencePolicyId', 'browser_evidence'],
  ['finalUrl', 'browser_evidence'],
  ['headers', 'caller_request_policy'],
  ['loadWaitPolicyId', 'browser_runtime_policy'],
  ['localePolicyId', 'browser_runtime_policy'],
  ['method', 'caller_request_policy'],
  ['navigationAttemptDigest', 'browser_execution'],
  ['networkPolicyId', 'browser_runtime_policy'],
  ['outputPath', 'browser_artifact'],
  ['permissionPolicyId', 'browser_runtime_policy'],
  ['popupPolicyId', 'browser_runtime_policy'],
  ['profilePolicyId', 'browser_runtime_policy'],
  ['redirectPolicyId', 'browser_runtime_policy'],
  ['screenshot', 'browser_evidence'],
  ['textExtract', 'browser_evidence'],
  ['timezonePolicyId', 'browser_runtime_policy'],
  ['timeoutPolicyId', 'browser_runtime_policy'],
  ['trace', 'browser_evidence'],
  ['type', 'browser_action'],
  ['video', 'browser_evidence'],
  ['viewportPolicyId', 'browser_runtime_policy'],
]);

export function normalizePtcLabBrowserUserUrlNavigationTarget(
  request: unknown,
): PtcLabBrowserUserUrlAdmissionResult<PtcLabBrowserUserUrlNavigationTarget> {
  if (!isRecord(request)) {
    return browserUserUrlAdmissionFailure(
      'url_not_string',
      'Browser URL target normalization requires a request object with a string URL.',
    );
  }

  const unsupportedCategory = detectUnsupportedFieldCategory(request);
  if (unsupportedCategory !== undefined) {
    return browserUserUrlAdmissionFailure(
      'unsupported_by_this_owner',
      'Browser URL target normalization received a field owned by a later browser owner.',
      { unsupportedCategory },
    );
  }

  const value = request.url;
  if (typeof value !== 'string') {
    return browserUserUrlAdmissionFailure(
      'url_not_string',
      'Browser URL target normalization requires a string URL.',
    );
  }

  const trimmed = trimAsciiWhitespace(value);
  if (trimmed.length === 0) {
    return browserUserUrlAdmissionFailure(
      'url_empty',
      'Browser URL target normalization requires a non-empty URL.',
    );
  }

  const byteLength = Buffer.byteLength(trimmed, 'utf8');
  if (byteLength > PTC_LAB_BROWSER_USER_URL_MAX_BYTES) {
    return browserUserUrlAdmissionFailure(
      'url_too_large',
      'Browser URL target normalization rejected a URL over the grammar byte limit.',
      {
        maxUrlBytes: PTC_LAB_BROWSER_USER_URL_MAX_BYTES,
      },
    );
  }

  if (EMBEDDED_ASCII_CONTROL_OR_WHITESPACE.test(trimmed)) {
    return browserUserUrlAdmissionFailure(
      'url_raw_control_character_disallowed',
      'Browser URL target normalization rejected raw ASCII whitespace or control characters.',
    );
  }

  if (URL_SCHEME.test(trimmed) && !/^https?:/iu.test(trimmed)) {
    return browserUserUrlAdmissionFailure(
      'url_scheme_not_admitted_by_grammar_policy',
      'Browser URL target normalization admits only http and https URL schemes.',
    );
  }

  if (!HTTP_OR_HTTPS_WITH_AUTHORITY.test(trimmed)) {
    return browserUserUrlAdmissionFailure(
      'url_parse_failed',
      'Browser URL target normalization requires an absolute http or https URL.',
    );
  }

  if (authorityContainsUserinfoDelimiter(trimmed)) {
    return browserUserUrlAdmissionFailure(
      'url_credentials_disallowed',
      'Browser URL target normalization rejects credential-bearing URLs.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return browserUserUrlAdmissionFailure(
      'url_parse_failed',
      'Browser URL target normalization could not parse the URL.',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return browserUserUrlAdmissionFailure(
      'url_scheme_not_admitted_by_grammar_policy',
      'Browser URL target normalization admits only http and https URL schemes.',
    );
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return browserUserUrlAdmissionFailure(
      'url_credentials_disallowed',
      'Browser URL target normalization rejects credential-bearing URLs.',
    );
  }

  const digestInput: PtcLabBrowserUserUrlNavigationTargetDigestInput = {
    url: parsed.href,
    method: 'GET',
    callerHeadersPolicyId: PTC_LAB_BROWSER_CALLER_HEADERS_NONE_POLICY_ID,
    bodyPolicyId: PTC_LAB_BROWSER_BODY_NONE_POLICY_ID,
    urlGrammarPolicyId:
      PTC_LAB_BROWSER_URL_GRAMMAR_HTTP_HTTPS_NO_CREDENTIALS_POLICY_ID,
  };

  return {
    ok: true,
    value: {
      ...digestInput,
      targetDigest: digestPtcLabBrowserUserUrlNavigationTarget(digestInput),
    },
  };
}

export function digestPtcLabBrowserUserUrlNavigationTarget(
  target: PtcLabBrowserUserUrlNavigationTargetDigestInput,
): PtcLabBrowserUserUrlTargetDigest {
  const digest = sha256StableJson(target, { omitUndefinedObjectKeys: true });
  return `sha256:${digest}`;
}

function browserUserUrlAdmissionFailure(
  reasonCode: PtcLabBrowserUserUrlAdmissionFailureReasonCode,
  message: string,
  diagnostics?: Record<string, string | number | boolean>,
): PtcLabBrowserUserUrlAdmissionResult<never> {
  return diagnostics === undefined
    ? { ok: false, reasonCode, message }
    : { ok: false, reasonCode, message, diagnostics };
}

function trimAsciiWhitespace(value: string): string {
  return value.replace(ASCII_EDGE_WHITESPACE, '');
}

function authorityContainsUserinfoDelimiter(value: string): boolean {
  return (AUTHORITY.exec(value)?.[1] ?? '').includes('@');
}

function detectUnsupportedFieldCategory(
  request: Record<string, unknown>,
): PtcLabBrowserUserUrlUnsupportedFieldCategory | undefined {
  for (const key of Object.keys(request)) {
    if (key === 'url' || key === 'timeoutMs') {
      continue;
    }
    return FUTURE_FIELD_CATEGORIES.get(key) ?? 'unknown';
  }
  return undefined;
}
