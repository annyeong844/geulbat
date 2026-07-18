import { isNumber, isRecord, isString } from './runtime-utils.js';

export const INPUT_REF_KINDS = [
  'run_prompt',
  'file_binary',
  'artifact_runtime_state',
  'react_bundle_inline_compile',
] as const;

export type InputRefKind = (typeof INPUT_REF_KINDS)[number];

export const INPUT_REF_STATES = ['pending', 'claimed', 'interrupted'] as const;

export type InputRefState = (typeof INPUT_REF_STATES)[number];

export const INPUT_REF_RECOVERY_ACTIONS = ['retry', 'release'] as const;

export type InputRefRecoveryAction =
  (typeof INPUT_REF_RECOVERY_ACTIONS)[number];

export interface InputRefInventoryEntry {
  ref: string;
  kind: InputRefKind;
  state: InputRefState;
  byteLength: number;
  createdAt: string;
  claimId?: string;
}

export interface InputRefInventoryResponse {
  ok: true;
  entries: InputRefInventoryEntry[];
  totalByteLength: number;
}

export interface InputRefRecoveryRequest {
  ref: string;
  action: InputRefRecoveryAction;
  claimId?: string;
}

export interface InputRefRecoveryResponse {
  ok: true;
  disposition: 'pending' | 'released';
}

export function isInputRefKind(value: unknown): value is InputRefKind {
  return INPUT_REF_KINDS.some((kind) => kind === value);
}

export function isInputRefState(value: unknown): value is InputRefState {
  return INPUT_REF_STATES.some((state) => state === value);
}

export function isInputRefRecoveryAction(
  value: unknown,
): value is InputRefRecoveryAction {
  return INPUT_REF_RECOVERY_ACTIONS.some((action) => action === value);
}

export function isInputRefInventoryEntry(
  value: unknown,
): value is InputRefInventoryEntry {
  if (
    !isRecord(value) ||
    !isString(value.ref) ||
    value.ref.length === 0 ||
    !isInputRefKind(value.kind) ||
    !isInputRefState(value.state) ||
    !isNonNegativeFiniteNumber(value.byteLength) ||
    !isString(value.createdAt) ||
    value.createdAt.length === 0
  ) {
    return false;
  }
  if (value.state === 'pending') {
    return value.claimId === undefined;
  }
  return isString(value.claimId) && value.claimId.length > 0;
}

export function isInputRefInventoryResponse(
  value: unknown,
): value is InputRefInventoryResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    Array.isArray(value.entries) &&
    value.entries.every(isInputRefInventoryEntry) &&
    isNonNegativeFiniteNumber(value.totalByteLength)
  );
}

export function isInputRefRecoveryResponse(
  value: unknown,
): value is InputRefRecoveryResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    (value.disposition === 'pending' || value.disposition === 'released')
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isNumber(value) && Number.isFinite(value) && value >= 0;
}
