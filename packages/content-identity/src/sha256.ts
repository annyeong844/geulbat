import { createHash } from 'node:crypto';

type Sha256Input = string | Uint8Array;

export function sha256Hex(input: Sha256Input): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256Digest(input: Sha256Input): `sha256:${string}` {
  return `sha256:${sha256Hex(input)}`;
}
