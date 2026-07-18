import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { hostname as readHostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { hasErrorCode } from './utils/error.js';
import { GEULBAT_INTERNAL_ROOT } from './files/geulbat-internal-paths.js';
import { tryParseJsonRecord } from './runtime-json.js';

const DAEMON_INSTANCE_ADMISSION_LOCK_FILE = 'daemon-admission-lock.json';

interface DaemonInstanceAdmissionLockOwner {
  version: 2;
  acquiredAt: string;
  hostname: string;
  ownerId: string;
  pid: number;
  stateRoot: string;
}

interface DaemonInstanceAdmissionLock {
  lockPath: string;
  owner: DaemonInstanceAdmissionLockOwner;
  release(): Promise<void>;
}

interface AcquireDaemonInstanceAdmissionLockOptions {
  stateRoot: string;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
  ownerId?: string;
  pid?: number;
}

type LockReadResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'owner'; owner: DaemonInstanceAdmissionLockOwner };

export class DaemonInstanceAdmissionLockConflictError extends Error {
  code = 'daemon_instance_admission_conflict' as const;
  lockPath: string;
  owner: DaemonInstanceAdmissionLockOwner | null;

  constructor(args: {
    lockPath: string;
    owner: DaemonInstanceAdmissionLockOwner | null;
  }) {
    super(`Geulbat Home is already owned by another daemon: ${args.lockPath}`);
    this.name = 'DaemonInstanceAdmissionLockConflictError';
    this.lockPath = args.lockPath;
    this.owner = args.owner;
  }
}

export function getDaemonInstanceAdmissionLockPath(stateRoot: string): string {
  return join(
    resolve(stateRoot),
    GEULBAT_INTERNAL_ROOT,
    DAEMON_INSTANCE_ADMISSION_LOCK_FILE,
  );
}

export async function acquireDaemonInstanceAdmissionLock(
  options: AcquireDaemonInstanceAdmissionLockOptions,
): Promise<DaemonInstanceAdmissionLock> {
  const requestedStateRoot = resolve(options.stateRoot);
  await mkdir(requestedStateRoot, { recursive: true, mode: 0o700 });
  const stateRoot = await realpath(requestedStateRoot);
  const lockPath = getDaemonInstanceAdmissionLockPath(stateRoot);
  const hostname = options.hostname ?? readHostname();
  const pid = options.pid ?? process.pid;
  const owner: DaemonInstanceAdmissionLockOwner = {
    version: 2,
    acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
    hostname,
    ownerId: options.ownerId ?? randomUUID(),
    pid,
    stateRoot,
  };
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    if (await tryCreateLockFile(lockPath, owner)) {
      return {
        lockPath,
        owner,
        release: () =>
          releaseDaemonInstanceAdmissionLock(lockPath, owner.ownerId),
      };
    }

    const existing = await readDaemonInstanceAdmissionLock(lockPath);
    if (existing.kind === 'missing') {
      continue;
    }
    if (existing.kind === 'invalid') {
      throw new DaemonInstanceAdmissionLockConflictError({
        lockPath,
        owner: null,
      });
    }
    if (
      existing.owner.hostname === hostname &&
      !isProcessAlive(existing.owner.pid)
    ) {
      await releaseDaemonInstanceAdmissionLock(
        lockPath,
        existing.owner.ownerId,
      );
      continue;
    }

    throw new DaemonInstanceAdmissionLockConflictError({
      lockPath,
      owner: existing.owner,
    });
  }
}

async function tryCreateLockFile(
  lockPath: string,
  owner: DaemonInstanceAdmissionLockOwner,
): Promise<boolean> {
  const preparedPath = `${lockPath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(preparedPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(preparedPath, lockPath);
      return true;
    } catch (error: unknown) {
      if (hasErrorCode(error, 'EEXIST')) {
        return false;
      }
      throw error;
    }
  } finally {
    await rm(preparedPath, { force: true });
  }
}

async function releaseDaemonInstanceAdmissionLock(
  lockPath: string,
  ownerId: string,
): Promise<void> {
  const current = await readDaemonInstanceAdmissionLock(lockPath);
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

async function readDaemonInstanceAdmissionLock(
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

  const parsed = tryParseJsonRecord(raw);
  if (!parsed.ok) {
    return { kind: 'invalid' };
  }
  const owner = parseDaemonInstanceAdmissionLockOwner(parsed.value);
  return owner ? { kind: 'owner', owner } : { kind: 'invalid' };
}

function parseDaemonInstanceAdmissionLockOwner(
  record: Record<string, unknown>,
): DaemonInstanceAdmissionLockOwner | null {
  if (
    record['version'] !== 2 ||
    !isNonEmptyString(record['acquiredAt']) ||
    !isNonEmptyString(record['hostname']) ||
    !isNonEmptyString(record['ownerId']) ||
    !isValidPid(record['pid']) ||
    !isNonEmptyString(record['stateRoot'])
  ) {
    return null;
  }

  return {
    version: 2,
    acquiredAt: record['acquiredAt'],
    hostname: record['hostname'],
    ownerId: record['ownerId'],
    pid: record['pid'],
    stateRoot: record['stateRoot'],
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
