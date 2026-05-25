import { isPlainRecord, isString } from './runtime-utils.js';

export const REACT_BUNDLE_INLINE_MAX_FILE_COUNT = 32;
export const REACT_BUNDLE_INLINE_MAX_TOTAL_SOURCE_BYTES = 262144;
export const REACT_BUNDLE_INLINE_MAX_COMPILED_OUTPUT_BYTES = 1048576;
export const REACT_BUNDLE_INLINE_COMPILE_TIMEOUT_MS = 5000;
export const PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX =
  '/public-generated/react-bundle-inline/';
export const REACT_BUNDLE_RUNTIME_ABI_VERSION = 'react-bundle-runtime-v1';
export const REACT_BUNDLE_RUNTIME_REACT_MAJOR = 19;
export const REACT_BUNDLE_RUNTIME_SHIM_MAP_VERSION = 'react-inline-shims-v1';
export const REACT_BUNDLE_INLINE_COMPILE_POLICY_VERSION =
  'react-inline-compile-policy-v1';

export type ReactBundleInlineCompileFailureCode =
  | 'sanitize_rejected'
  | 'policy_blocked'
  | 'boot_failed'
  | 'runtime_crashed';

export interface ReactBundleRuntimeImportMap {
  imports?: Record<string, string>;
}

export interface ReactBundleRuntimeDependencies {
  importMap?: ReactBundleRuntimeImportMap;
  stylesheets?: string[];
}

export interface ReactBundleRuntimeManifest {
  entryUrl: string;
  runtimeDependencies?: ReactBundleRuntimeDependencies;
}

export interface ReactBundleInlineSourceInput {
  files: Record<string, string>;
  entry: string;
}

export type ReactBundleArtifactInput =
  | ReactBundleRuntimeManifest
  | ReactBundleInlineSourceInput;

export interface ReactBundleInlineCompileRequest {
  renderer: 'react_bundle';
  input: ReactBundleInlineSourceInput;
}

export type ReactBundleInlineCompileResponse =
  | {
      ok: true;
      manifest: ReactBundleRuntimeManifest;
    }
  | {
      ok: false;
      code: ReactBundleInlineCompileFailureCode;
      detail: string;
    };

export function isReactBundleRuntimeManifest(
  value: unknown,
): value is ReactBundleRuntimeManifest {
  return (
    isPlainRecord(value) &&
    isString(value.entryUrl) &&
    isOptionalReactBundleRuntimeDependencies(value.runtimeDependencies)
  );
}

export function isReactBundleInlineSourceInput(
  value: unknown,
): value is ReactBundleInlineSourceInput {
  return decodeReactBundleInlineSourceInput(value).ok;
}

export function isReactBundleArtifactInput(
  value: unknown,
): value is ReactBundleArtifactInput {
  return (
    isReactBundleRuntimeManifest(value) || isReactBundleInlineSourceInput(value)
  );
}

export function isReactBundleInlineCompileRequest(
  value: unknown,
): value is ReactBundleInlineCompileRequest {
  return decodeReactBundleInlineCompileRequest(value).ok;
}

export function isReactBundleInlineCompileResponse(
  value: unknown,
): value is ReactBundleInlineCompileResponse {
  return (
    (isPlainRecord(value) &&
      value.ok === true &&
      isReactBundleRuntimeManifest(value.manifest)) ||
    (isPlainRecord(value) &&
      value.ok === false &&
      isReactBundleInlineCompileFailureCode(value.code) &&
      isString(value.detail))
  );
}

export function decodeReactBundleInlineCompileRequest(value: unknown):
  | { ok: true; value: ReactBundleInlineCompileRequest }
  | {
      ok: false;
      code: 'sanitize_rejected';
      detail: string;
    } {
  if (!isPlainRecord(value)) {
    return reject('react bundle inline compile request must be an object');
  }
  if (value.renderer !== 'react_bundle') {
    return reject(
      'react bundle inline compile request renderer must be react_bundle',
    );
  }

  const input = decodeReactBundleInlineSourceInput(value.input);
  if (!input.ok) {
    return input;
  }

  return {
    ok: true,
    value: {
      renderer: 'react_bundle',
      input: input.value,
    },
  };
}

export function decodeReactBundleInlineSourceInput(value: unknown):
  | { ok: true; value: ReactBundleInlineSourceInput }
  | {
      ok: false;
      code: 'sanitize_rejected';
      detail: string;
    } {
  if (!isPlainRecord(value)) {
    return reject('react bundle inline source input must be an object');
  }

  const files = value.files;
  if (!isPlainRecord(files)) {
    return reject('react bundle inline source input files must be an object');
  }

  const rawEntry = value.entry;
  if (!isString(rawEntry)) {
    return reject('react bundle inline source input entry must be a string');
  }

  const normalizedFiles = new Map<string, string>();
  let totalSourceBytes = 0;

  for (const [rawPath, rawSource] of Object.entries(files)) {
    if (!isString(rawSource)) {
      return reject(
        `react bundle inline source file ${rawPath} must be a string`,
      );
    }

    const normalizedPath = normalizeReactBundleInlinePath(rawPath);
    if (!normalizedPath.ok) {
      return normalizedPath;
    }
    if (normalizedFiles.has(normalizedPath.value)) {
      return reject(
        `react bundle inline source contains duplicate normalized path ${normalizedPath.value}`,
      );
    }

    normalizedFiles.set(normalizedPath.value, rawSource);
    totalSourceBytes += measureUtf8Bytes(rawSource);
    if (normalizedFiles.size > REACT_BUNDLE_INLINE_MAX_FILE_COUNT) {
      return reject(
        `react bundle inline source exceeds max file count ${REACT_BUNDLE_INLINE_MAX_FILE_COUNT}`,
      );
    }
    if (totalSourceBytes > REACT_BUNDLE_INLINE_MAX_TOTAL_SOURCE_BYTES) {
      return reject(
        `react bundle inline source exceeds max total source bytes ${REACT_BUNDLE_INLINE_MAX_TOTAL_SOURCE_BYTES}`,
      );
    }
  }

  if (normalizedFiles.size === 0) {
    return reject('react bundle inline source files must not be empty');
  }

  const normalizedEntry = normalizeReactBundleInlinePath(rawEntry);
  if (!normalizedEntry.ok) {
    return normalizedEntry;
  }
  if (!normalizedFiles.has(normalizedEntry.value)) {
    return reject(
      `react bundle inline source entry ${normalizedEntry.value} must match a provided file`,
    );
  }

  return {
    ok: true,
    value: {
      files: Object.fromEntries(normalizedFiles),
      entry: normalizedEntry.value,
    },
  };
}

export function isReactBundleInlineCompileFailureCode(
  value: unknown,
): value is ReactBundleInlineCompileFailureCode {
  return (
    value === 'sanitize_rejected' ||
    value === 'policy_blocked' ||
    value === 'boot_failed' ||
    value === 'runtime_crashed'
  );
}

export function isPublicGeneratedReactBundleInlinePath(
  pathname: string,
): boolean {
  return pathname.startsWith(PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX);
}

function normalizeReactBundleInlinePath(rawPath: string):
  | { ok: true; value: string }
  | {
      ok: false;
      code: 'sanitize_rejected';
      detail: string;
    } {
  const path = rawPath.trim();
  if (!path) {
    return reject('react bundle inline source path must be non-empty');
  }
  if (path.startsWith('/')) {
    return reject(
      `react bundle inline source path ${path} must not be absolute`,
    );
  }
  if (/^[A-Za-z]:/.test(path)) {
    return reject(
      `react bundle inline source path ${path} must not use a drive letter`,
    );
  }
  if (path.includes('\\')) {
    return reject(
      `react bundle inline source path ${path} must use POSIX separators`,
    );
  }

  const segments = path.split('/');
  for (const segment of segments) {
    if (!segment) {
      return reject(
        `react bundle inline source path ${path} must not contain empty segments`,
      );
    }
    if (segment === '.') {
      return reject(
        `react bundle inline source path ${path} must not contain dot segments`,
      );
    }
    if (segment === '..') {
      return reject(
        `react bundle inline source path ${path} must not escape its root`,
      );
    }
  }

  return {
    ok: true,
    value: segments.join('/'),
  };
}

function reject(detail: string): {
  ok: false;
  code: 'sanitize_rejected';
  detail: string;
} {
  return {
    ok: false,
    code: 'sanitize_rejected',
    detail,
  };
}

function isOptionalReactBundleRuntimeDependencies(value: unknown): boolean {
  return value === undefined || isReactBundleRuntimeDependencies(value);
}

function isReactBundleRuntimeDependencies(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }

  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'importMap' && key !== 'stylesheets')) {
    return false;
  }

  return (
    isOptionalReactBundleRuntimeImportMap(value.importMap) &&
    isOptionalStringArray(value.stylesheets)
  );
}

function isOptionalReactBundleRuntimeImportMap(value: unknown): boolean {
  return value === undefined || isReactBundleRuntimeImportMap(value);
}

function isReactBundleRuntimeImportMap(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }

  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'imports')) {
    return false;
  }

  return value.imports === undefined || isStringRecord(value.imports);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isPlainRecord(value) &&
    Object.values(value).every((entry) => isString(entry))
  );
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(isString));
}

function measureUtf8Bytes(value: string): number {
  let total = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint <= 0x7f) {
      total += 1;
      continue;
    }
    if (codePoint <= 0x7ff) {
      total += 2;
      continue;
    }
    if (codePoint <= 0xffff) {
      total += 3;
      continue;
    }

    total += 4;
    index += 1;
  }

  return total;
}
