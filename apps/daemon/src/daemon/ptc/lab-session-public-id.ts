import type { PtcSessionDockerHandle } from './session-docker-contract.js';

const PTC_LAB_PUBLIC_SESSION_ID_PREFIX = 'ptc-lab-' as const;
const PTC_LAB_PUBLIC_SESSION_ID_HASH_CHARS = 32;

export type PtcLabPublicSessionId =
  `${typeof PTC_LAB_PUBLIC_SESSION_ID_PREFIX}${string}`;

export function buildPtcLabPublicSessionId(
  handle: Pick<PtcSessionDockerHandle, 'reuseKey'>,
): PtcLabPublicSessionId {
  return buildPtcLabPublicSessionIdFromIdentityHash(
    handle.reuseKey.identityHash,
  );
}

export function buildPtcLabPublicSessionIdFromIdentityHash(
  identityHash: string,
): PtcLabPublicSessionId {
  return `${PTC_LAB_PUBLIC_SESSION_ID_PREFIX}${identityHash.slice(
    0,
    PTC_LAB_PUBLIC_SESSION_ID_HASH_CHARS,
  )}`;
}
