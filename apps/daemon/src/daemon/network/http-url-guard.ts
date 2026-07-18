import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface DnsAddress {
  address: string;
  family: 4 | 6;
}

export type HttpLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

type HttpUrlGuardReasonCode = 'invalid_url' | 'unsafe_url';

export function parseHttpUrl(
  input: string,
  options: { label?: string; protocolLabel?: string } = {},
):
  | { ok: true; url: URL }
  | { ok: false; reasonCode: HttpUrlGuardReasonCode; message: string } {
  const label = options.label ?? 'URL';
  const protocolLabel = options.protocolLabel ?? label;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return {
      ok: false,
      reasonCode: 'invalid_url',
      message: `${label} must be an absolute http or https URL.`,
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reasonCode: 'invalid_url',
      message: `${protocolLabel} only supports http and https URLs.`,
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      reasonCode: 'unsafe_url',
      message: `${label} must not include embedded credentials.`,
    };
  }
  if (isUnsafeHttpHostname(url.hostname)) {
    return {
      ok: false,
      reasonCode: 'unsafe_url',
      message: `${label} resolves to a blocked hostname.`,
    };
  }

  return { ok: true, url };
}

export async function guardedLookupPublicAddress(
  hostname: string,
  options: { lookup?: HttpLookup; label?: string } = {},
): Promise<DnsAddress> {
  const records = await (options.lookup ?? defaultLookup)(hostname, {
    all: true,
    verbatim: true,
  });
  const first = records[0];
  if (!first) {
    throw new Error('hostname did not resolve to an address');
  }
  const unsafe = records.find((record) => isUnsafeHttpAddress(record.address));
  if (unsafe) {
    const label = options.label ?? 'HTTP URL';
    throw new Error(
      `unsafe network address resolved for ${label}: ${unsafe.address}`,
    );
  }
  if (first.family !== 4 && first.family !== 6) {
    const label = options.label ?? 'HTTP URL';
    throw new Error(
      `unsupported network address family resolved for ${label}: ${first.family}`,
    );
  }
  return {
    address: first.address,
    family: first.family,
  };
}

export function isUnsafeHttpHostname(hostname: string): boolean {
  const normalized = normalizeIpLiteralHost(hostname);
  const lowered = normalized.toLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.localhost')) {
    return true;
  }
  return isIP(normalized) !== 0 && isUnsafeHttpAddress(normalized);
}

export function isUnsafeHttpAddress(address: string): boolean {
  const normalized = normalizeIpLiteralHost(address);
  const family = isIP(normalized);
  if (family === 4) {
    return isUnsafeIpv4(normalized);
  }
  if (family === 6) {
    return isUnsafeIpv6(normalized);
  }
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
  if (a === undefined || b === undefined) {
    return true;
  }
  if (a === 0 || a === 10 || a === 127) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 192 && b === 0) {
    return true;
  }
  if (a === 192 && b === 2) {
    return true;
  }
  if (a === 198 && (b === 18 || b === 19 || b === 51)) {
    return true;
  }
  if (a === 203 && b === 0) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return false;
}

function isUnsafeIpv6(address: string): boolean {
  const lowered = address.toLowerCase();
  const mappedIpv4 = parseIpv4MappedAddress(lowered);
  if (mappedIpv4) {
    return isUnsafeIpv4(mappedIpv4);
  }
  return (
    lowered === '::1' ||
    lowered === '::' ||
    lowered.startsWith('::ffff:') ||
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

function parseIpv4MappedAddress(address: string): string | null {
  const dottedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(address);
  if (dottedMatch?.[1]) {
    return dottedMatch[1];
  }

  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (!hexMatch?.[1] || !hexMatch[2]) {
    return null;
  }

  const high = Number.parseInt(hexMatch[1], 16);
  const low = Number.parseInt(hexMatch[2], 16);
  if (high > 0xffff || low > 0xffff) {
    return null;
  }

  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(
    '.',
  );
}

async function defaultLookup(
  hostname: string,
  options: { all: true; verbatim: true },
): Promise<LookupAddress[]> {
  return dnsLookup(hostname, options);
}
