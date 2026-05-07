import type { ErrorCode } from '../error-codes.js';

class FileDomainError extends Error {
  code: ErrorCode;
  path?: string;

  constructor(
    name: string,
    code: ErrorCode,
    message: string,
    path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = name;
    this.code = code;
    if (path !== undefined) {
      this.path = path;
    }
  }
}

export class FileAccessError extends FileDomainError {
  constructor(
    code: ErrorCode,
    message: string,
    path?: string,
    options?: ErrorOptions,
  ) {
    super('FileAccessError', code, message, path, options);
  }

  static reservedPath(path: string): FileAccessError {
    return new FileAccessError('access_denied', `reserved path: ${path}`, path);
  }

  static notFound(path: string): FileAccessError {
    return new FileAccessError('not_found', `file not found: ${path}`, path);
  }

  static directoryPath(path: string): FileAccessError {
    return new FileAccessError(
      'not_found',
      `path is a directory: ${path}`,
      path,
    );
  }

  static tooLarge(path: string, byteLength: number): FileAccessError {
    return new FileAccessError(
      'buffer_limit_exceeded',
      `file too large: ${path} (${byteLength} bytes)`,
      path,
    );
  }

  static treeTooLarge(path: string, detail: string): FileAccessError {
    return new FileAccessError(
      'buffer_limit_exceeded',
      `file tree too large: ${path} (${detail})`,
      path,
    );
  }

  static binaryFile(path: string): FileAccessError {
    return new FileAccessError('binary_file', `binary file: ${path}`, path);
  }
}

export class MissingWriteTargetError extends FileAccessError {
  constructor(path: string, options?: ErrorOptions) {
    super('not_found', `file not found: ${path}`, path, options);
    this.name = 'MissingWriteTargetError';
  }
}

export class StaleWriteError extends FileAccessError {
  currentVersionToken: string;

  constructor(path: string, currentVersionToken: string) {
    super(
      'conflict_stale_write',
      `stale write: file has been modified (${path})`,
      path,
    );
    this.name = 'StaleWriteError';
    this.currentVersionToken = currentVersionToken;
  }
}

export class AlreadyExistsWriteTargetError extends FileAccessError {
  constructor(path: string) {
    super('already_exists', `file already exists: ${path}`, path);
    this.name = 'AlreadyExistsWriteTargetError';
  }
}
