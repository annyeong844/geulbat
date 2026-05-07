import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, rm, mkdir } from 'node:fs/promises';
import { hostname as readHostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { hasErrorCode } from './utils/error.js';
import { joinWorkspaceGeulbatPath } from './files/geulbat-internal-paths.js';

const WORKSPACE_ADMISSION_LOCK_FILE = 'daemon-admission-lock.json';

interface WorkspaceAdmissionLockOwner {
  version: 1;
  acquiredAt: string;
  hostname: string;
  ownerId: string;
  pid: number;
  workspaceRoot: string;
}

export interface WorkspaceAdmissionLock {
  lockPath: string;
  owner: WorkspaceAdmissionLockOwner;
  release(): Promise<void>;
}

interface AcquireWorkspaceAdmissionLockOptions {
  workspaceRoot: string;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
  ownerId?: string;
  pid?: number;
}

type LockReadResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'owner'; owner: WorkspaceAdmissionLockOwner };

export class WorkspaceAdmissionLockConflictError extends Error {
  code = 'workspace_admission_conflict' as const;
  lockPath: string;
  owner: WorkspaceAdmissionLockOwner | null;

  constructor(args: {
    lockPath: string;
    owner: WorkspaceAdmissionLockOwner | null;
  }) {
    super(`workspace is already owned by another daemon: ${args.lockPath}`);
    this.name = 'WorkspaceAdmissionLockConflictError';
    this.lockPath = args.lockPath;
    this.owner = args.owner;
  }
}

export function getWorkspaceAdmissionLockPath(workspaceRoot: string): string {
  return joinWorkspaceGeulbatPath(
    resolve(workspaceRoot),
    WORKSPACE_ADMISSION_LOCK_FILE,
  );
}

export async function acquireWorkspaceAdmissionLock(
  options: AcquireWorkspaceAdmissionLockOptions,
): Promise<WorkspaceAdmissionLock> {
  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  const lockPath = getWorkspaceAdmissionLockPath(workspaceRoot);
  const hostname = options.hostname ?? readHostname();
  const pid = options.pid ?? process.pid;
  const owner: WorkspaceAdmissionLockOwner = {
    version: 1,
    acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
    hostname,
    ownerId: options.ownerId ?? randomUUID(),
    pid,
    workspaceRoot,
  };
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    if (await tryCreateLockFile(lockPath, owner)) {
      return {
        lockPath,
        owner,
        release: () => releaseWorkspaceAdmissionLock(lockPath, owner.ownerId),
      };
    }

    const existing = await readWorkspaceAdmissionLock(lockPath);
    if (existing.kind === 'missing') {
      continue;
    }
    if (existing.kind === 'invalid') {
      throw new WorkspaceAdmissionLockConflictError({
        lockPath,
        owner: null,
      });
    }
    if (
      existing.owner.hostname === hostname &&
      !isProcessAlive(existing.owner.pid)
    ) {
      await releaseWorkspaceAdmissionLock(lockPath, existing.owner.ownerId);
      continue;
    }

    throw new WorkspaceAdmissionLockConflictError({
      lockPath,
      owner: existing.owner,
    });
  }
}

async function tryCreateLockFile(
  lockPath: string,
  owner: WorkspaceAdmissionLockOwner,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, 'wx');
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function releaseWorkspaceAdmissionLock(
  lockPath: string,
  ownerId: string,
): Promise<void> {
  const current = await readWorkspaceAdmissionLock(lockPath);
  if (current.kind === 'missing') {
    return;
  }
  if (current.kind !== 'owner' || current.owner.ownerId !== ownerId) {
    return;
  }

  try {
    await rm(lockPath, { force: true });
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

async function readWorkspaceAdmissionLock(
  lockPath: string,
): Promise<LockReadResult> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { kind: 'missing' };
    }
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const owner = parseWorkspaceAdmissionLockOwner(parsed);
    return owner ? { kind: 'owner', owner } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function parseWorkspaceAdmissionLockOwner(
  value: unknown,
): WorkspaceAdmissionLockOwner | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record['version'] !== 1 ||
    !isNonEmptyString(record['acquiredAt']) ||
    !isNonEmptyString(record['hostname']) ||
    !isNonEmptyString(record['ownerId']) ||
    !isValidPid(record['pid']) ||
    !isNonEmptyString(record['workspaceRoot'])
  ) {
    return null;
  }

  return {
    version: 1,
    acquiredAt: record['acquiredAt'],
    hostname: record['hostname'],
    ownerId: record['ownerId'],
    pid: record['pid'],
    workspaceRoot: record['workspaceRoot'],
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isValidPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ESRCH')) {
      return false;
    }
    return true;
  }
}
