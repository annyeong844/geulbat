import type { PtcSessionDockerHandle } from '../session/session-docker-contract.js';

const PTC_LAB_PUBLIC_SESSION_ID_PREFIX = 'ptc-lab-' as const;
const PTC_LAB_PUBLIC_SESSION_ID_HASH_CHARS = 32;

interface PtcLabPublicSessionIdHandle {
  reuseKey: Pick<PtcSessionDockerHandle['reuseKey'], 'identityHash'>;
}

type PtcLabPublicSessionId =
  `${typeof PTC_LAB_PUBLIC_SESSION_ID_PREFIX}${string}`;

export function buildPtcLabPublicSessionId(
  handle: PtcLabPublicSessionIdHandle,
): PtcLabPublicSessionId {
  return buildPtcLabPublicSessionIdFromIdentityHash(
    handle.reuseKey.identityHash,
  );
}

function buildPtcLabPublicSessionIdFromIdentityHash(
  identityHash: string,
): PtcLabPublicSessionId {
  return `${PTC_LAB_PUBLIC_SESSION_ID_PREFIX}${identityHash.slice(
    0,
    PTC_LAB_PUBLIC_SESSION_ID_HASH_CHARS,
  )}`;
}
