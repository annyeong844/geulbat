import {
  guardedLookupPublicAddress as guardedLookupPublicAddressBase,
  isUnsafeHttpAddress,
  isUnsafeHttpHostname,
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
    label: 'web_fetch URL',
    protocolLabel: 'web_fetch',
  });
  if (result.ok) return result;
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
    label: 'web_fetch',
  });
}

export function isUnsafeWebFetchHostname(hostname: string): boolean {
  return isUnsafeHttpHostname(hostname);
}

export function isUnsafeWebFetchAddress(address: string): boolean {
  return isUnsafeHttpAddress(address);
}
