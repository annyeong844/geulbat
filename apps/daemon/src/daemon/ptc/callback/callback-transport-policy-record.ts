import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { writeTextFileAtomically } from '../../utils/atomic-file.js';
import { getErrorMessage, isNotFoundError } from '../../utils/error.js';
import {
  resolvePtcSessionEpochBridgeCallbackPolicyFromEnv,
  type PtcSessionEpochBridgeCallbackPolicy,
} from './session-epoch-bridge.js';

export type PtcCallbackTransportPolicy = PtcSessionEpochBridgeCallbackPolicy;

// PTC transition spec v7 §3 (2026-07-27 운영 표면 요청) — 콜백 전송 정책을 운영자가
// 고른 값으로 지속한다. F003의 닫힘 조건은 그대로다: 숫자 기본값을 도입하지 않고,
// 다섯 값 전체가 아니면 저장하지 않으며, 정책이 없으면 bridge를 만들지 않는다.
// 그러므로 이 파일은 "값을 지어내는 곳"이 아니라 "운영자가 확정한 값을 담는 곳"이다.
//
// 환경변수가 이긴다. 환경으로 관리되는 배포에서 저장된 레코드가 조용히 다른 한도를
// 적용하면 운영자가 본 값과 실제 값이 갈라지기 때문이다.

const PTC_CALLBACK_TRANSPORT_POLICY_RELATIVE_PATH = join(
  '.geulbat',
  'ptc-callback-transport.json',
);

const PTC_CALLBACK_TRANSPORT_POLICY_SCHEMA_VERSION = 1 as const;

interface PersistedPtcCallbackTransportPolicy {
  schemaVersion: typeof PTC_CALLBACK_TRANSPORT_POLICY_SCHEMA_VERSION;
  policy: PtcCallbackTransportPolicy;
}

type PtcCallbackTransportPolicySource = 'environment' | 'settings' | 'disabled';

interface ResolvedPtcCallbackTransportPolicy {
  source: PtcCallbackTransportPolicySource;
  policy?: PtcCallbackTransportPolicy;
}

/**
 * 저장된 정책이 깨졌을 때 조용히 비활성으로 떨어지지 않게 하는 진단. 운영자가 켠
 * 통로가 파일 손상으로 사라지면 그건 "꺼짐"이 아니라 고쳐야 하는 상태다.
 */
export class PtcCallbackTransportPolicyRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PtcCallbackTransportPolicyRecordError';
  }
}

const POLICY_FIELDS = [
  'maxFrameBytes',
  'maxOpenConnections',
  'maxCallbacks',
  'callbackTimeoutMs',
  'maxResponseBytes',
] as const;

export function ptcCallbackTransportPolicyRecordPath(
  homeStateRoot: string,
): string {
  return join(homeStateRoot, PTC_CALLBACK_TRANSPORT_POLICY_RELATIVE_PATH);
}

/**
 * 부팅 경로에서 한 번 읽는다 — 정책은 런타임 조립이 결정하고, 조립은 동기다.
 * 파일이 없으면 undefined(비활성), 있으면 다섯 값이 모두 유효해야 한다.
 */
export function readStoredPtcCallbackTransportPolicy(
  homeStateRoot: string,
): PtcCallbackTransportPolicy | undefined {
  const path = ptcCallbackTransportPolicyRecordPath(homeStateRoot);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw new PtcCallbackTransportPolicyRecordError(
      `PTC callback transport policy could not be read: ${getErrorMessage(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new PtcCallbackTransportPolicyRecordError(
      `PTC callback transport policy is not valid JSON: ${getErrorMessage(error)}`,
    );
  }
  return readPersistedPolicy(parsed);
}

export async function writeStoredPtcCallbackTransportPolicy(args: {
  homeStateRoot: string;
  policy: PtcCallbackTransportPolicy;
}): Promise<void> {
  const policy = requireCompletePolicy(args.policy);
  const record: PersistedPtcCallbackTransportPolicy = {
    schemaVersion: PTC_CALLBACK_TRANSPORT_POLICY_SCHEMA_VERSION,
    policy,
  };
  await writeTextFileAtomically(
    ptcCallbackTransportPolicyRecordPath(args.homeStateRoot),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

export async function clearStoredPtcCallbackTransportPolicy(
  homeStateRoot: string,
): Promise<void> {
  await rm(ptcCallbackTransportPolicyRecordPath(homeStateRoot), {
    force: true,
  });
}

/**
 * 조립이 쓰는 단일 판정. 환경 → 저장된 레코드 → 비활성 순이며, 어느 쪽이 이겼는지
 * source로 함께 돌려준다 — 설정 화면이 "환경이 관리 중"을 표시할 근거다.
 */
export function resolvePtcCallbackTransportPolicy(args: {
  homeStateRoot: string;
  env?: Parameters<typeof resolvePtcSessionEpochBridgeCallbackPolicyFromEnv>[0];
}): ResolvedPtcCallbackTransportPolicy {
  const fromEnv = resolvePtcSessionEpochBridgeCallbackPolicyFromEnv(
    args.env ?? process.env,
  );
  if (fromEnv !== undefined) {
    return { source: 'environment', policy: fromEnv };
  }
  const stored = readStoredPtcCallbackTransportPolicy(args.homeStateRoot);
  return stored === undefined
    ? { source: 'disabled' }
    : { source: 'settings', policy: stored };
}

function readPersistedPolicy(value: unknown): PtcCallbackTransportPolicy {
  if (typeof value !== 'object' || value === null) {
    throw new PtcCallbackTransportPolicyRecordError(
      'PTC callback transport policy record is not an object',
    );
  }
  const record = value as Record<string, unknown>;
  if (
    record['schemaVersion'] !== PTC_CALLBACK_TRANSPORT_POLICY_SCHEMA_VERSION
  ) {
    throw new PtcCallbackTransportPolicyRecordError(
      `PTC callback transport policy schema ${String(record['schemaVersion'])} is not readable by this build`,
    );
  }
  const policy = record['policy'];
  if (typeof policy !== 'object' || policy === null) {
    throw new PtcCallbackTransportPolicyRecordError(
      'PTC callback transport policy record has no policy object',
    );
  }
  return requireCompletePolicy(policy as Record<string, unknown>);
}

function requireCompletePolicy(
  value: Record<string, unknown> | PtcCallbackTransportPolicy,
): PtcCallbackTransportPolicy {
  const source = value as Record<string, unknown>;
  const missing = POLICY_FIELDS.filter((field) => source[field] === undefined);
  if (missing.length > 0) {
    throw new PtcCallbackTransportPolicyRecordError(
      `PTC callback transport policy requires every limit; missing ${missing.join(', ')}`,
    );
  }
  const invalid = POLICY_FIELDS.filter((field) => {
    const candidate = source[field];
    return (
      typeof candidate !== 'number' ||
      !Number.isSafeInteger(candidate) ||
      candidate <= 0
    );
  });
  if (invalid.length > 0) {
    throw new PtcCallbackTransportPolicyRecordError(
      `PTC callback transport policy limits must be positive safe integers; invalid ${invalid.join(', ')}`,
    );
  }
  return {
    maxFrameBytes: source['maxFrameBytes'] as number,
    maxOpenConnections: source['maxOpenConnections'] as number,
    maxCallbacks: source['maxCallbacks'] as number,
    callbackTimeoutMs: source['callbackTimeoutMs'] as number,
    maxResponseBytes: source['maxResponseBytes'] as number,
  };
}
