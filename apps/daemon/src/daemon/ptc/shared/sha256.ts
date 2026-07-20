import { sha256Hex } from '@geulbat/content-identity/sha256';

const PTC_SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

export function hashPtcSha256Hex(input: string | Uint8Array): string {
  return sha256Hex(input);
}

export function isPtcSha256Hex(value: string): boolean {
  return PTC_SHA256_HEX_PATTERN.test(value);
}
