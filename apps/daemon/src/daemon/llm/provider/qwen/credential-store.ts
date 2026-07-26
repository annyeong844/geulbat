import fs from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { isRecord } from '../../../runtime-json.js';
import {
  hardenProviderAuthFilePermissions,
  type ProviderAuthFilePermissionHardener,
} from '../../../auth/credentials/store.js';
import { writeTextFileAtomically } from '../../../utils/atomic-file.js';
import { isNotFoundError } from '../../../utils/error.js';

const QWEN_TOKEN_PLAN_CREDENTIAL_FILE_PATH_ENV =
  'GEULBAT_QWEN_CREDENTIAL_FILE_PATH';

const QWEN_TOKEN_PLAN_REGIONS = ['global', 'china'] as const;
export type QwenTokenPlanRegion = (typeof QWEN_TOKEN_PLAN_REGIONS)[number];

export interface QwenTokenPlanCredential {
  apiKey: string;
  region: QwenTokenPlanRegion;
}

interface QwenTokenPlanCredentialFile {
  version: 1;
  credential: QwenTokenPlanCredential;
}

export function isQwenTokenPlanRegion(
  value: unknown,
): value is QwenTokenPlanRegion {
  return QWEN_TOKEN_PLAN_REGIONS.some((region) => region === value);
}

function resolveQwenTokenPlanCredentialFilePath(
  env: Record<string, string | undefined> = process.env,
  userHome = os.homedir(),
): string {
  const override = env[QWEN_TOKEN_PLAN_CREDENTIAL_FILE_PATH_ENV]?.trim();
  return override || join(userHome, '.geulbat', 'auth', 'qwen-token-plan.json');
}

export async function readQwenTokenPlanCredential(
  args: {
    filePath?: string;
  } = {},
): Promise<QwenTokenPlanCredential | null> {
  const filePath = args.filePath ?? resolveQwenTokenPlanCredentialFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new QwenTokenPlanCredentialFileError();
  }
  if (
    !isRecord(value) ||
    value['version'] !== 1 ||
    !isRecord(value['credential']) ||
    typeof value['credential']['apiKey'] !== 'string' ||
    value['credential']['apiKey'].trim() === '' ||
    !isQwenTokenPlanRegion(value['credential']['region'])
  ) {
    throw new QwenTokenPlanCredentialFileError();
  }
  return {
    apiKey: value['credential']['apiKey'],
    region: value['credential']['region'],
  };
}

export async function writeQwenTokenPlanCredential(
  credential: QwenTokenPlanCredential,
  args: {
    filePath?: string;
    hardenPermissions?: ProviderAuthFilePermissionHardener;
  } = {},
): Promise<void> {
  const apiKey = credential.apiKey.trim();
  if (apiKey === '' || !isQwenTokenPlanRegion(credential.region)) {
    throw new QwenTokenPlanCredentialInputError();
  }
  const filePath = args.filePath ?? resolveQwenTokenPlanCredentialFilePath();
  await assertQwenCredentialPathOutsideGitWorktree(filePath);
  const data: QwenTokenPlanCredentialFile = {
    version: 1,
    credential: { apiKey, region: credential.region },
  };
  await writeTextFileAtomically(filePath, JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
  await (args.hardenPermissions ?? hardenProviderAuthFilePermissions)(filePath);
}

export async function deleteQwenTokenPlanCredential(
  args: {
    filePath?: string;
  } = {},
): Promise<void> {
  const filePath = args.filePath ?? resolveQwenTokenPlanCredentialFilePath();
  try {
    await fs.unlink(filePath);
  } catch (error: unknown) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

async function assertQwenCredentialPathOutsideGitWorktree(
  filePath: string,
): Promise<void> {
  let current = await resolveCanonicalDirectory(dirname(resolve(filePath)));
  while (true) {
    if (await pathExists(join(current, '.git'))) {
      throw new QwenTokenPlanCredentialGitWorktreeError();
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

async function resolveCanonicalDirectory(
  directoryPath: string,
): Promise<string> {
  let current = directoryPath;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonicalAncestor = await fs.realpath(current);
      return join(canonicalAncestor, ...missingSegments);
    } catch (error: unknown) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

class QwenTokenPlanCredentialGitWorktreeError extends Error {
  constructor() {
    super('Qwen Token Plan credentials cannot be stored inside a Git worktree');
    this.name = 'QwenTokenPlanCredentialGitWorktreeError';
  }
}

class QwenTokenPlanCredentialInputError extends Error {
  constructor() {
    super('Qwen Token Plan credential is invalid');
    this.name = 'QwenTokenPlanCredentialInputError';
  }
}

class QwenTokenPlanCredentialFileError extends Error {
  constructor() {
    super('Qwen Token Plan credential file is invalid');
    this.name = 'QwenTokenPlanCredentialFileError';
  }
}
