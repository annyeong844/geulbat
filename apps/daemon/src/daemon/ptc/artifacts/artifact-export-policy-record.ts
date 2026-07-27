import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isPtcArtifactExportPolicy,
  type PtcArtifactExportPolicy,
} from '@geulbat/protocol/ptc-artifacts';

import { writeTextFileAtomically } from '../../utils/atomic-file.js';
import { getErrorMessage, isNotFoundError } from '../../utils/error.js';
import { isRecord } from '../../runtime-json.js';

export const PTC_ARTIFACT_EXPORT_MAX_FILES_ENV =
  'GEULBAT_PTC_ARTIFACT_MAX_FILES';
export const PTC_ARTIFACT_EXPORT_MAX_FILE_BYTES_ENV =
  'GEULBAT_PTC_ARTIFACT_MAX_FILE_BYTES';
export const PTC_ARTIFACT_EXPORT_MAX_TOTAL_BYTES_ENV =
  'GEULBAT_PTC_ARTIFACT_MAX_TOTAL_BYTES';

export const PTC_ARTIFACT_EXPORT_POLICY_RELATIVE_PATH = join(
  '.geulbat',
  'ptc-artifact-export.json',
);
export const PTC_ARTIFACT_EXPORT_POLICY_SCHEMA_VERSION = 1 as const;

export interface PersistedPtcArtifactExportPolicy {
  schemaVersion: typeof PTC_ARTIFACT_EXPORT_POLICY_SCHEMA_VERSION;
  policy: PtcArtifactExportPolicy;
}

export type PtcArtifactExportPolicySource =
  | 'environment'
  | 'settings'
  | 'disabled';

export interface ResolvedPtcArtifactExportPolicy {
  source: PtcArtifactExportPolicySource;
  policy?: PtcArtifactExportPolicy;
}

export class PtcArtifactExportPolicyRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PtcArtifactExportPolicyRecordError';
  }
}

type PtcArtifactExportPolicyEnv = Readonly<Record<string, string | undefined>>;

export function ptcArtifactExportPolicyRecordPath(
  homeStateRoot: string,
): string {
  return join(homeStateRoot, PTC_ARTIFACT_EXPORT_POLICY_RELATIVE_PATH);
}

export function readStoredPtcArtifactExportPolicy(
  homeStateRoot: string,
): PtcArtifactExportPolicy | undefined {
  const path = ptcArtifactExportPolicyRecordPath(homeStateRoot);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw new PtcArtifactExportPolicyRecordError(
      `PTC artifact export policy could not be read: ${getErrorMessage(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new PtcArtifactExportPolicyRecordError(
      `PTC artifact export policy is not valid JSON: ${getErrorMessage(error)}`,
    );
  }
  if (
    !isRecord(parsed) ||
    parsed['schemaVersion'] !== PTC_ARTIFACT_EXPORT_POLICY_SCHEMA_VERSION ||
    !isPtcArtifactExportPolicy(parsed['policy'])
  ) {
    throw new PtcArtifactExportPolicyRecordError(
      'PTC artifact export policy record is invalid',
    );
  }
  return Object.freeze({ ...parsed['policy'] });
}

export async function writeStoredPtcArtifactExportPolicy(args: {
  homeStateRoot: string;
  policy: PtcArtifactExportPolicy;
}): Promise<void> {
  if (!isPtcArtifactExportPolicy(args.policy)) {
    throw new PtcArtifactExportPolicyRecordError(
      'PTC artifact export policy requires every limit as a positive safe integer',
    );
  }
  const record: PersistedPtcArtifactExportPolicy = {
    schemaVersion: PTC_ARTIFACT_EXPORT_POLICY_SCHEMA_VERSION,
    policy: { ...args.policy },
  };
  await writeTextFileAtomically(
    ptcArtifactExportPolicyRecordPath(args.homeStateRoot),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

export async function clearStoredPtcArtifactExportPolicy(
  homeStateRoot: string,
): Promise<void> {
  await rm(ptcArtifactExportPolicyRecordPath(homeStateRoot), { force: true });
}

export function resolvePtcArtifactExportPolicy(args: {
  homeStateRoot: string;
  env?: PtcArtifactExportPolicyEnv;
}): ResolvedPtcArtifactExportPolicy {
  const fromEnvironment = resolvePtcArtifactExportPolicyFromEnv(
    args.env ?? process.env,
  );
  if (fromEnvironment !== undefined) {
    return { source: 'environment', policy: fromEnvironment };
  }
  const stored = readStoredPtcArtifactExportPolicy(args.homeStateRoot);
  return stored === undefined
    ? { source: 'disabled' }
    : { source: 'settings', policy: stored };
}

export function resolvePtcArtifactExportPolicyFromEnv(
  env: PtcArtifactExportPolicyEnv = process.env,
): PtcArtifactExportPolicy | undefined {
  const values = {
    maxFiles: env[PTC_ARTIFACT_EXPORT_MAX_FILES_ENV],
    maxFileBytes: env[PTC_ARTIFACT_EXPORT_MAX_FILE_BYTES_ENV],
    maxTotalBytes: env[PTC_ARTIFACT_EXPORT_MAX_TOTAL_BYTES_ENV],
  };
  if (Object.values(values).every((value) => value === undefined)) {
    return undefined;
  }
  return Object.freeze({
    maxFiles: readRequiredPositiveInteger(
      PTC_ARTIFACT_EXPORT_MAX_FILES_ENV,
      values.maxFiles,
    ),
    maxFileBytes: readRequiredPositiveInteger(
      PTC_ARTIFACT_EXPORT_MAX_FILE_BYTES_ENV,
      values.maxFileBytes,
    ),
    maxTotalBytes: readRequiredPositiveInteger(
      PTC_ARTIFACT_EXPORT_MAX_TOTAL_BYTES_ENV,
      values.maxTotalBytes,
    ),
  });
}

function readRequiredPositiveInteger(
  name: string,
  value: string | undefined,
): number {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    throw new PtcArtifactExportPolicyRecordError(
      `${name} must be set to a positive safe integer when artifact export environment policy is present`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new PtcArtifactExportPolicyRecordError(
      `${name} must be set to a positive safe integer`,
    );
  }
  return parsed;
}
