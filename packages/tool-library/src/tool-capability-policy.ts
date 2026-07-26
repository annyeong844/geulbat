import {
  sha256StableJson,
  stableStringify,
} from '@geulbat/content-identity/stable-json';

export type ToolCapabilityPolicy = {
  readonly schemaVersion: 1;
  readonly toolCapabilityPolicyId: `sha256:${string}`;
  readonly directRegistryNames: readonly string[];
  readonly allowedRegistryNames: readonly string[];
  readonly callbackRegistryNames: readonly string[];
  readonly writeCallbackEnabled: boolean;
};

export interface CreateToolCapabilityPolicyArgs {
  directRegistryNames: readonly string[];
  allowedRegistryNames: readonly string[];
  callbackRegistryNames: readonly string[];
  writeCallbackEnabled: boolean;
}

export function createToolCapabilityPolicy(
  args: CreateToolCapabilityPolicyArgs,
): ToolCapabilityPolicy {
  const directRegistryNames = normalizeRegistryNames(
    args.directRegistryNames,
    'directRegistryNames',
  );
  const allowedRegistryNames = normalizeRegistryNames(
    args.allowedRegistryNames,
    'allowedRegistryNames',
  );
  const callbackRegistryNames = normalizeRegistryNames(
    args.callbackRegistryNames,
    'callbackRegistryNames',
  );
  if (typeof args.writeCallbackEnabled !== 'boolean') {
    throw new Error('writeCallbackEnabled must be a boolean');
  }
  assertRegistryNameSubset({
    names: directRegistryNames,
    allowedRegistryNames,
    label: 'directRegistryNames',
  });
  assertRegistryNameSubset({
    names: callbackRegistryNames,
    allowedRegistryNames,
    label: 'callbackRegistryNames',
  });
  const identity = Object.freeze({
    schemaVersion: 1 as const,
    directRegistryNames,
    allowedRegistryNames,
    callbackRegistryNames,
    writeCallbackEnabled: args.writeCallbackEnabled,
  });
  const toolCapabilityPolicyId: `sha256:${string}` = `sha256:${sha256StableJson(identity)}`;
  return Object.freeze({ ...identity, toolCapabilityPolicyId });
}

export function validateToolCapabilityPolicy(
  value: unknown,
): ToolCapabilityPolicy {
  const policy = assertExactPlainRecord(
    value,
    [
      'allowedRegistryNames',
      'callbackRegistryNames',
      'directRegistryNames',
      'schemaVersion',
      'toolCapabilityPolicyId',
      'writeCallbackEnabled',
    ],
    'tool capability policy',
  );
  if (policy.schemaVersion !== 1) {
    throw new Error('unsupported tool capability policy schemaVersion');
  }
  if (typeof policy.toolCapabilityPolicyId !== 'string') {
    throw new Error('toolCapabilityPolicyId must be a string');
  }
  if (typeof policy.writeCallbackEnabled !== 'boolean') {
    throw new Error('writeCallbackEnabled must be a boolean');
  }
  const canonical = createToolCapabilityPolicy({
    directRegistryNames: normalizeRegistryNames(
      policy.directRegistryNames,
      'directRegistryNames',
    ),
    allowedRegistryNames: normalizeRegistryNames(
      policy.allowedRegistryNames,
      'allowedRegistryNames',
    ),
    callbackRegistryNames: normalizeRegistryNames(
      policy.callbackRegistryNames,
      'callbackRegistryNames',
    ),
    writeCallbackEnabled: policy.writeCallbackEnabled,
  });
  if (canonical.toolCapabilityPolicyId !== policy.toolCapabilityPolicyId) {
    throw new Error(
      'toolCapabilityPolicyId does not match the tool capability policy body',
    );
  }
  return canonical;
}

export function serializeToolCapabilityPolicy(
  policy: ToolCapabilityPolicy,
): string {
  return stableStringify(validateToolCapabilityPolicy(policy));
}

export function parseToolCapabilityPolicy(
  serialized: string,
): ToolCapabilityPolicy {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('tool capability policy must be valid JSON');
  }
  return validateToolCapabilityPolicy(value);
}

function normalizeRegistryNames(
  value: unknown,
  label: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const names = value.map((item: unknown) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${label} must contain only non-blank strings`);
    }
    if (item !== item.trim()) {
      throw new Error(`${label} must not contain surrounding whitespace`);
    }
    return item;
  });
  return Object.freeze([...new Set(names)].sort());
}

function assertRegistryNameSubset(args: {
  names: readonly string[];
  allowedRegistryNames: readonly string[];
  label: string;
}): void {
  const allowedRegistryNames = new Set(args.allowedRegistryNames);
  const outsideAllowed = args.names.find(
    (name) => !allowedRegistryNames.has(name),
  );
  if (outsideAllowed !== undefined) {
    throw new Error(
      `${args.label} must be a subset of allowedRegistryNames: ${outsideAllowed}`,
    );
  }
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
