import { getErrorCode, getErrorMessage } from '../utils/error.js';

export class PersistenceConflictError extends Error {
  readonly code = 'persistence_conflict';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PersistenceConflictError';
  }
}

export class PersistenceBlockedError extends Error {
  readonly code = 'persistence_blocked';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PersistenceBlockedError';
  }
}

export class PersistenceUnavailableError extends Error {
  readonly code = 'persistence_unavailable';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PersistenceUnavailableError';
  }
}

export class PersistenceQuotaExceededError extends Error {
  readonly code = 'persistence_quota_exceeded';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PersistenceQuotaExceededError';
  }
}

type RuntimePersistenceError =
  | PersistenceBlockedError
  | PersistenceConflictError
  | PersistenceQuotaExceededError
  | PersistenceUnavailableError;

export function classifyRuntimePersistenceError(
  message: string,
  error: unknown,
): RuntimePersistenceError {
  if (
    error instanceof PersistenceBlockedError ||
    error instanceof PersistenceConflictError ||
    error instanceof PersistenceQuotaExceededError ||
    error instanceof PersistenceUnavailableError
  ) {
    return error;
  }

  const code = getErrorCode(error);
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new PersistenceQuotaExceededError(
      `${message}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EISDIR' ||
    code === 'ENOTDIR' ||
    code === 'EROFS'
  ) {
    return new PersistenceBlockedError(
      `${message}: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  return new PersistenceUnavailableError(
    `${message}: ${getErrorMessage(error)}`,
    { cause: error },
  );
}
