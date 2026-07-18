import type { GeulbatRuntimePersistenceError } from './artifact-runtime-persistence-bootstrap-types.js';
import {
  DATABASE_NAMESPACE_KEY,
  STORAGE_NAMESPACE_KEY,
} from './artifact-runtime-persistence-authority-state.js';

export function createArtifactRuntimePersistenceValidation() {
  const storageReservedKeys = new Set([
    '__proto__',
    'constructor',
    'prototype',
    STORAGE_NAMESPACE_KEY,
    DATABASE_NAMESPACE_KEY,
  ]);

  const createPersistenceError = (
    code: string,
    message: string,
  ): GeulbatRuntimePersistenceError =>
    Object.assign(new Error(message), {
      name: 'GeulbatRuntimePersistenceError',
      code,
    });

  const clonePersistenceError = (error: GeulbatRuntimePersistenceError) =>
    createPersistenceError(error.code, error.message);

  const stabilizePersistenceError = (
    error: unknown,
    fallbackCode = 'persistence_unavailable',
    fallbackMessage = 'runtime persistence unavailable',
  ) => {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : fallbackCode;
    const message =
      error instanceof Error && error.message
        ? error.message
        : error &&
            typeof error === 'object' &&
            'message' in error &&
            typeof error.message === 'string' &&
            error.message
          ? error.message
          : fallbackMessage;

    if (
      code === 'persistence_blocked' ||
      code === 'persistence_quota_exceeded' ||
      code === 'persistence_unavailable'
    ) {
      return createPersistenceError(code, message);
    }

    return createPersistenceError(fallbackCode, message);
  };

  const isPersistenceConflict = (error: unknown) =>
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'persistence_conflict';

  const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === null || prototype === Object.prototype) {
      return true;
    }
    return (
      Object.prototype.toString.call(value) === '[object Object]' &&
      typeof prototype === 'object' &&
      'constructor' in prototype &&
      typeof prototype.constructor === 'function' &&
      prototype.constructor.name === 'Object'
    );
  };

  const isJsonStorageValue = (
    value: unknown,
    seen = new Set<object>(),
  ): boolean => {
    if (value === null) {
      return true;
    }

    switch (typeof value) {
      case 'string':
      case 'boolean':
        return true;
      case 'number':
        return Number.isFinite(value);
      case 'object':
        break;
      default:
        return false;
    }

    if (seen.has(value)) {
      return false;
    }
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        return value.every((entry) => isJsonStorageValue(entry, seen));
      }
      if (!isPlainRecord(value)) {
        return false;
      }
      return Object.keys(value).every((key) =>
        isJsonStorageValue(value[key], seen),
      );
    } finally {
      seen.delete(value);
    }
  };

  function assertStorageKey(key: unknown): asserts key is string {
    if (typeof key !== 'string' || key.length === 0) {
      throw createPersistenceError(
        'persistence_blocked',
        'storage key must be a non-empty string',
      );
    }
    if (storageReservedKeys.has(key)) {
      throw createPersistenceError(
        'persistence_blocked',
        'storage key is reserved in artifact runtime storage',
      );
    }
  }

  const assertStorageValue = (value: unknown) => {
    if (value === null || !isJsonStorageValue(value)) {
      throw createPersistenceError(
        'persistence_blocked',
        'storage value must be JSON-serializable and not top-level null',
      );
    }
  };

  function assertDatabaseKey(key: unknown): asserts key is string {
    if (typeof key !== 'string' || key.length === 0) {
      throw createPersistenceError(
        'persistence_blocked',
        'database key must be a non-empty string',
      );
    }
    if (storageReservedKeys.has(key)) {
      throw createPersistenceError(
        'persistence_blocked',
        'database key is reserved in artifact runtime storage',
      );
    }
  }

  const assertDatabaseValue = (value: unknown) => {
    if (value === null || !isJsonStorageValue(value)) {
      throw createPersistenceError(
        'persistence_blocked',
        'database value must be JSON-serializable and not top-level null',
      );
    }
  };

  const normalizeStorageKey = (key: unknown) => {
    const normalized = String(key);
    assertStorageKey(normalized);
    return normalized;
  };

  const normalizeDatabaseKey = (key: unknown) => {
    const normalized = String(key);
    assertDatabaseKey(normalized);
    return normalized;
  };

  const normalizeStorageIndex = (index: unknown) => {
    const normalized = Number(index);
    if (!Number.isInteger(normalized) || normalized < 0) {
      return null;
    }
    return normalized;
  };

  return {
    createPersistenceError,
    clonePersistenceError,
    stabilizePersistenceError,
    isPersistenceConflict,
    isPlainRecord,
    assertStorageKey,
    assertStorageValue,
    assertDatabaseKey,
    assertDatabaseValue,
    normalizeStorageKey,
    normalizeDatabaseKey,
    normalizeStorageIndex,
  };
}

export type ArtifactRuntimePersistenceValidation = ReturnType<
  typeof createArtifactRuntimePersistenceValidation
>;
