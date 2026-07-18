import {
  guardedLookupPublicAddress as guardedLookupPublicAddressBase,
  isUnsafeHttpAddress,
  parseHttpUrl,
  type DnsAddress,
  type HttpLookup,
} from '../../network/http-url-guard.js';
import type { WebFetchFailureReasonCode } from './web-fetch-result.js';

export type WebFetchLookup = HttpLookup;

export function parseWebFetchHttpUrl(
  input: string,
):
  | { ok: true; url: URL }
  | { ok: false; reasonCode: WebFetchFailureReasonCode; message: string } {
  const result = parseHttpUrl(input, {
    label: 'fetch_url URL',
    protocolLabel: 'fetch_url',
  });
  if (result.ok) {
    return result;
  }
  return {
    ok: false,
    reasonCode: result.reasonCode,
    message: result.message,
  };
}

export function guardedLookupPublicAddress(
  hostname: string,
  options: { lookup?: WebFetchLookup } = {},
): Promise<DnsAddress> {
  return guardedLookupPublicAddressBase(hostname, {
    ...options,
    label: 'fetch_url',
  });
}

export function isUnsafeWebFetchAddress(address: string): boolean {
  return isUnsafeHttpAddress(address);
}
