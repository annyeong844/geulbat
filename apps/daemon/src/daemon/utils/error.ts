import { getErrorMessage } from '@geulbat/shared-utils/error';
import {
  isErrorCode,
  isGenericApiErrorCode,
  type ErrorCode,
  type GenericApiErrorCode,
} from '../error-codes.js';

export { getErrorMessage };

function readProperty(error: unknown, key: string): unknown {
  if (!error || typeof error !== 'object' || !(key in error)) {
    return undefined;
  }
  return Reflect.get(error, key);
}

export function getErrorCode(error: unknown): string | undefined {
  const code = readProperty(error, 'code');
  return typeof code === 'string' && code.trim() !== '' ? code : undefined;
}

export function getErrorStringProperty(
  error: unknown,
  key: string,
): string | undefined {
  const value = readProperty(error, key);
  return typeof value === 'string' ? value : undefined;
}

export function getErrorNumberProperty(
  error: unknown,
  key: string,
): number | undefined {
  const value = readProperty(error, key);
  return typeof value === 'number' ? value : undefined;
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return getErrorCode(error) === code;
}

export function getAppErrorCode(error: unknown): ErrorCode | undefined {
  const code = getErrorCode(error);
  return isErrorCode(code) ? code : undefined;
}

export function getGenericApiErrorCode(
  error: unknown,
): GenericApiErrorCode | undefined {
  const code = getErrorCode(error);
  return isGenericApiErrorCode(code) ? code : undefined;
}

export function isNotFoundError(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}
