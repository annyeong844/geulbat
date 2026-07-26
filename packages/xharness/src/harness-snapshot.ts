import {
  sha256StableJson,
  stableStringify,
} from '@geulbat/content-identity/stable-json';
import {
  createToolCapabilityPolicy,
  parseToolCapabilityPolicy,
  serializeToolCapabilityPolicy,
  type CreateToolCapabilityPolicyArgs,
  type ToolCapabilityPolicy,
} from '@geulbat/tool-library/tool-capability-policy';

export type HarnessConfigJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly HarnessConfigJsonValue[]
  | HarnessConfigJsonObject;

export interface HarnessConfigJsonObject {
  readonly [key: string]: HarnessConfigJsonValue;
}

export type HarnessToolCapabilityPolicy = {
  readonly [Key in keyof ToolCapabilityPolicy]: ToolCapabilityPolicy[Key];
};

export interface HarnessConfigSnapshot<
  TConfig extends HarnessConfigJsonObject = HarnessConfigJsonObject,
> {
  readonly schemaVersion: 1;
  readonly harnessId: string;
  readonly harnessVersion: string;
  readonly harnessSnapshotId: `sha256:${string}`;
  readonly config: TConfig;
}

export function createHarnessToolCapabilityPolicy(
  args: CreateToolCapabilityPolicyArgs,
): HarnessToolCapabilityPolicy {
  return createToolCapabilityPolicy(args);
}

export function serializeHarnessToolCapabilityPolicy(
  policy: HarnessToolCapabilityPolicy,
): string {
  return serializeToolCapabilityPolicy(policy);
}

export function parseHarnessToolCapabilityPolicy(
  serialized: string,
): HarnessToolCapabilityPolicy {
  return parseToolCapabilityPolicy(serialized);
}

export function createHarnessConfigSnapshot<
  TConfig extends HarnessConfigJsonObject,
>(args: {
  harnessId: string;
  harnessVersion: string;
  config: TConfig;
}): HarnessConfigSnapshot<TConfig> {
  if (args.harnessId.trim().length === 0) {
    throw new Error('harnessId must not be blank');
  }
  if (args.harnessVersion.trim().length === 0) {
    throw new Error('harnessVersion must not be blank');
  }
  const config = cloneHarnessConfigJsonObject(args.config) as TConfig;
  const identity = Object.freeze({
    schemaVersion: 1 as const,
    harnessId: args.harnessId,
    harnessVersion: args.harnessVersion,
    config,
  });
  const harnessSnapshotId: `sha256:${string}` = `sha256:${sha256StableJson(identity)}`;
  return Object.freeze({ ...identity, harnessSnapshotId });
}

export function serializeHarnessConfigSnapshot(
  snapshot: HarnessConfigSnapshot,
): string {
  const serialized = stableStringify(snapshot);
  parseHarnessConfigSnapshot(serialized);
  return serialized;
}

export function parseHarnessConfigSnapshot(
  serialized: string,
): HarnessConfigSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('harness config snapshot must be valid JSON');
  }
  const snapshot = assertExactPlainRecord(
    value,
    [
      'config',
      'harnessId',
      'harnessSnapshotId',
      'harnessVersion',
      'schemaVersion',
    ],
    'harness config snapshot',
  );
  if (snapshot.schemaVersion !== 1) {
    throw new Error('unsupported harness config snapshot schemaVersion');
  }
  if (typeof snapshot.harnessId !== 'string') {
    throw new Error('harnessId must be a string');
  }
  if (typeof snapshot.harnessVersion !== 'string') {
    throw new Error('harnessVersion must be a string');
  }
  if (typeof snapshot.harnessSnapshotId !== 'string') {
    throw new Error('harnessSnapshotId must be a string');
  }
  const canonical = createHarnessConfigSnapshot({
    harnessId: snapshot.harnessId,
    harnessVersion: snapshot.harnessVersion,
    config: cloneHarnessConfigJsonObject(snapshot.config),
  });
  if (canonical.harnessSnapshotId !== snapshot.harnessSnapshotId) {
    throw new Error(
      'harnessSnapshotId does not match the harness config snapshot body',
    );
  }
  return canonical;
}

function cloneHarnessConfigJsonObject(value: unknown): HarnessConfigJsonObject {
  const cloned = cloneHarnessConfigJson(value, new Set());
  if (!isHarnessConfigJsonObject(cloned)) {
    throw new Error('harness config must be a JSON object');
  }
  return cloned;
}

function cloneHarnessConfigJson(
  value: unknown,
  ancestors: Set<object>,
): HarnessConfigJsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('harness config numbers must be finite');
    }
    return value;
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error('harness config must contain only JSON values');
  }
  if (ancestors.has(value)) {
    throw new Error('harness config must not contain cycles');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((item) => cloneHarnessConfigJson(item, ancestors)),
      );
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('harness config must contain only JSON objects');
    }
    const cloned: Record<string, HarnessConfigJsonValue> = {};
    for (const key of Object.keys(value)) {
      const item: unknown = Reflect.get(value, key);
      Object.defineProperty(cloned, key, {
        configurable: true,
        enumerable: true,
        value: cloneHarnessConfigJson(item, ancestors),
        writable: true,
      });
    }
    return Object.freeze(cloned);
  } finally {
    ancestors.delete(value);
  }
}

function isHarnessConfigJsonObject(
  value: HarnessConfigJsonValue,
): value is HarnessConfigJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactPlainRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
  return value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
