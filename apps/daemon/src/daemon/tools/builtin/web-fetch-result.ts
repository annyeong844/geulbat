import type { ErrorCode } from '../../error-codes.js';
import { WEB_FETCH_DEFAULT_MAX_CHARS } from './web-fetch-policy.js';

export type WebFetchFailureReasonCode =
  | 'invalid_url'
  | 'unsafe_url'
  | 'unsafe_redirect'
  | 'redirect_limit_exceeded'
  | 'timeout'
  | 'aborted'
  | 'network_error'
  | 'unsupported_content_type'
  | 'response_too_large'
  | 'extraction_failed';

export interface WebFetchSuccess {
  ok: true;
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  title?: string;
  content: string;
  truncated: boolean;
  truncationReason?: 'max_chars' | 'max_bytes';
  untrusted: true;
}

export interface WebFetchFailure {
  ok: false;
  url: string;
  finalUrl?: string;
  reasonCode: WebFetchFailureReasonCode;
  message: string;
  untrusted?: true;
}

export type WebFetchOutput = WebFetchSuccess | WebFetchFailure;

export function resolveWebFetchMaxChars(value: number | undefined): number {
  return value ?? WEB_FETCH_DEFAULT_MAX_CHARS;
}

export function webFetchFailureToolErrorCode(
  reasonCode: WebFetchFailureReasonCode,
): ErrorCode {
  switch (reasonCode) {
    case 'invalid_url':
    case 'unsafe_url':
    case 'unsafe_redirect':
    case 'unsupported_content_type':
      return 'invalid_args';
    case 'timeout':
      return 'timeout';
    case 'aborted':
      return 'aborted';
    case 'response_too_large':
      return 'buffer_limit_exceeded';
    case 'network_error':
    case 'redirect_limit_exceeded':
    case 'extraction_failed':
      return 'execution_failed';
  }

  const _exhaustive: never = reasonCode;
  return _exhaustive;
}

export function webFetchFailure(args: {
  url: string;
  finalUrl?: string;
  reasonCode: WebFetchFailureReasonCode;
  message: string;
}): WebFetchFailure {
  return {
    ok: false,
    url: args.url,
    ...(args.finalUrl ? { finalUrl: args.finalUrl } : {}),
    reasonCode: args.reasonCode,
    message: args.message,
    untrusted: true,
  };
}

export function stringifyWebFetchOutput(output: WebFetchOutput): string {
  return JSON.stringify(output);
}
