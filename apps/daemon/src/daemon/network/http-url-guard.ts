import type { LookupAddress } from 'node:dns';

export {
  isUnsafeHttpAddress,
  isUnsafeHttpHostname,
  parseHttpUrl,
} from '../utils/http-url-policy.js';

export type HttpLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;
