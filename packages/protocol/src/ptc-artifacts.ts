import {
  hasOnlyKeys,
  isNumber,
  isRecord,
  isString,
} from './wire-value-guards.js';

export const PTC_EXECUTE_CODE_ARTIFACT_EXPORT_POLICY_ID =
  'ptc_execute_code_artifact_export_operator_v1';

export interface PtcArtifactExportPolicy {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export type PtcArtifactExportSettingsStatus =
  | { state: 'disabled' }
  | {
      state: 'ready';
      source: 'environment' | 'stored';
      policy: PtcArtifactExportPolicy;
    };

export interface PtcExecuteCodeArtifactFile {
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface PtcExecuteCodeArtifactExport {
  evidenceRef: string;
  files: PtcExecuteCodeArtifactFile[];
  totalBytes: number;
}

export function isPtcArtifactExportPolicy(
  value: unknown,
): value is PtcArtifactExportPolicy {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['maxFiles', 'maxFileBytes', 'maxTotalBytes'])
  ) {
    return false;
  }
  return (
    isPositiveSafeInteger(value['maxFiles']) &&
    isPositiveSafeInteger(value['maxFileBytes']) &&
    isPositiveSafeInteger(value['maxTotalBytes'])
  );
}

export function isPtcArtifactRelativePath(value: unknown): value is string {
  if (
    !isString(value) ||
    value.trim().length === 0 ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value.startsWith('/geulbat/artifacts/') ||
    value.includes('\\')
  ) {
    return false;
  }
  const segments = value.split('/');
  return !segments.some(
    (segment) =>
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment === '.geulbat' ||
      segment === 'node_modules',
  );
}

export function isPtcArtifactExportSettingsStatus(
  value: unknown,
): value is PtcArtifactExportSettingsStatus {
  if (!isRecord(value) || !isString(value['state'])) {
    return false;
  }
  if (value['state'] === 'disabled') {
    return hasOnlyKeys(value, ['state']);
  }
  return (
    value['state'] === 'ready' &&
    hasOnlyKeys(value, ['state', 'source', 'policy']) &&
    (value['source'] === 'environment' || value['source'] === 'stored') &&
    isPtcArtifactExportPolicy(value['policy'])
  );
}

export function isPtcExecuteCodeArtifactExport(
  value: unknown,
): value is PtcExecuteCodeArtifactExport {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['evidenceRef', 'files', 'totalBytes']) ||
    !isString(value['evidenceRef']) ||
    !value['evidenceRef'].startsWith('sandbox-output:') ||
    !Array.isArray(value['files']) ||
    !isNonNegativeSafeInteger(value['totalBytes'])
  ) {
    return false;
  }
  return value['files'].every(
    (file) =>
      isRecord(file) &&
      hasOnlyKeys(file, ['relativePath', 'bytes', 'sha256']) &&
      isPtcArtifactRelativePath(file['relativePath']) &&
      isNonNegativeSafeInteger(file['bytes']) &&
      isString(file['sha256']) &&
      /^[a-f0-9]{64}$/u.test(file['sha256']),
  );
}

export function buildPtcArtifactFileUrl(args: {
  evidenceRef: string;
  relativePath: string;
  download?: boolean;
}): string {
  const query = new URLSearchParams({
    evidenceRef: args.evidenceRef,
    relativePath: args.relativePath,
  });
  if (args.download === true) {
    query.set('download', '1');
  }
  return `/api/ptc-artifacts/file?${query.toString()}`;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 0;
}
