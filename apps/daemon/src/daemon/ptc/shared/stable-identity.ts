import {
  sha256StableJson,
  type StableJsonOptions,
} from '@geulbat/shared-utils/stable-json';

export function hashPtcStableJson(
  value: unknown,
  options: StableJsonOptions = {},
): string {
  return sha256StableJson(value, options);
}

export function digestPtcStableJson(
  value: unknown,
  options: StableJsonOptions = {},
): `sha256:${string}` {
  return `sha256:${hashPtcStableJson(value, options)}`;
}
