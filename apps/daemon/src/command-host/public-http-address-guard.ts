import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';

import { isUnsafeHttpAddress } from '../daemon/utils/http-url-policy.js';

export interface PublicHttpAddress {
  address: string;
  family: 4 | 6;
}

type PublicHttpLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

export async function guardedLookupPublicAddress(
  hostname: string,
  options: { lookup?: PublicHttpLookup; label?: string } = {},
): Promise<PublicHttpAddress> {
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

const defaultLookup: PublicHttpLookup = (hostname, options) =>
  dnsLookup(hostname, options);
