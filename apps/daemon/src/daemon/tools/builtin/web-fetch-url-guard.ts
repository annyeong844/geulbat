import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { WebFetchFailureReasonCode } from './web-fetch-result.js';

interface DnsAddress {
  address: string;
  family: 4 | 6;
}

export type WebFetchLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<DnsAddress[]>;

export function parseWebFetchHttpUrl(
  input: string,
):
  | { ok: true; url: URL }
  | { ok: false; reasonCode: WebFetchFailureReasonCode; message: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return {
      ok: false,
      reasonCode: 'invalid_url',
      message: 'web_fetch URL must be an absolute http or https URL.',
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reasonCode: 'invalid_url',
      message: 'web_fetch only supports http and https URLs.',
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      reasonCode: 'unsafe_url',
      message: 'web_fetch URL must not include embedded credentials.',
    };
  }
  if (isUnsafeWebFetchHostname(url.hostname)) {
    return {
      ok: false,
      reasonCode: 'unsafe_url',
      message: 'web_fetch URL resolves to a blocked hostname.',
    };
  }

  return { ok: true, url };
}

export async function guardedLookupPublicAddress(
  hostname: string,
  options: { lookup?: WebFetchLookup } = {},
): Promise<DnsAddress> {
  const records = await (options.lookup ?? defaultLookup)(hostname, {
    all: true,
    verbatim: true,
  });
  const first = records[0];
  if (!first) {
    throw new Error('hostname did not resolve to an address');
  }
  const unsafe = records.find((record) =>
    isUnsafeWebFetchAddress(record.address),
  );
  if (unsafe) {
    throw new Error(
      `unsafe network address resolved for web_fetch: ${unsafe.address}`,
    );
  }
  return first;
}

export function isUnsafeWebFetchHostname(hostname: string): boolean {
  const normalized = normalizeIpLiteralHost(hostname);
  const lowered = normalized.toLocaleLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.localhost')) {
    return true;
  }
  return isIP(normalized) !== 0 && isUnsafeWebFetchAddress(normalized);
}

export function isUnsafeWebFetchAddress(address: string): boolean {
  const normalized = normalizeIpLiteralHost(address);
  const family = isIP(normalized);
  if (family === 4) return isUnsafeIpv4(normalized);
  if (family === 6) return isUnsafeIpv6(normalized);
  return true;
}

function normalizeIpLiteralHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isUnsafeIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [a, b] = octets;
  if (a === undefined || b === undefined) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 2) return true;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

function isUnsafeIpv6(address: string): boolean {
  const lowered = address.toLocaleLowerCase();
  const ipv4MappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lowered);
  if (ipv4MappedMatch?.[1]) {
    return isUnsafeIpv4(ipv4MappedMatch[1]);
  }
  return (
    lowered === '::1' ||
    lowered === '::' ||
    lowered.startsWith('fc') ||
    lowered.startsWith('fd') ||
    lowered.startsWith('fe8') ||
    lowered.startsWith('fe9') ||
    lowered.startsWith('fea') ||
    lowered.startsWith('feb') ||
    lowered.startsWith('ff') ||
    lowered.startsWith('2001:db8:')
  );
}

async function defaultLookup(
  hostname: string,
  options: { all: true; verbatim: true },
): Promise<DnsAddress[]> {
  return dnsLookup(hostname, options) as Promise<DnsAddress[]>;
}
