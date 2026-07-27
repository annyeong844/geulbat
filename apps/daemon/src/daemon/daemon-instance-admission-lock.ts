import { randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
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
  /**
   * 소유자가 실제로 listen한 포트. lock은 listen 전에 잡히므로 처음에는 없고,
   * bind가 끝난 뒤 `recordListeningPort`가 채운다. 포트가 유동일 때 "지금 도는
   * 데몬은 어디 있나"의 유일한 답이다. 필드가 optional이므로 이 값을 모르는
   * 이전 기록도 그대로 읽힌다.
   */
  port?: number;
}

interface DaemonInstanceAdmissionLock {
  lockPath: string;
  owner: DaemonInstanceAdmissionLockOwner;
  /**
   * bind가 끝난 뒤 접속 지점을 기록한다. 그 사이 다른 소유자가 같은 경로를
   * 잡았다면 덮어쓰지 않고 실패한다 — 늦게 도착한 기록이 살아있는 소유자의
   * 주소를 지우면 CLI가 없는 곳을 연다.
   */
  recordListeningPort(port: number): Promise<void>;
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
        recordListeningPort: (port: number) =>
          recordDaemonInstanceAdmissionLockPort(lockPath, owner, port),
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

/**
 * 지금 이 Geulbat Home을 소유한 데몬의 기록. lock이 없으면 `null`이므로
 * 죽은 데몬의 주소를 살아있는 것처럼 돌려주지 않는다.
 */
export async function readDaemonInstanceAdmissionLockOwner(
  stateRoot: string,
): Promise<DaemonInstanceAdmissionLockOwner | null> {
  const result = await readDaemonInstanceAdmissionLock(
    getDaemonInstanceAdmissionLockPath(resolve(stateRoot)),
  );
  return result.kind === 'owner' ? result.owner : null;
}

async function recordDaemonInstanceAdmissionLockPort(
  lockPath: string,
  owner: DaemonInstanceAdmissionLockOwner,
  port: number,
): Promise<void> {
  const current = await readDaemonInstanceAdmissionLock(lockPath);
  if (current.kind !== 'owner' || current.owner.ownerId !== owner.ownerId) {
    throw new DaemonInstanceAdmissionLockConflictError({
      lockPath,
      owner: current.kind === 'owner' ? current.owner : null,
    });
  }

  const next: DaemonInstanceAdmissionLockOwner = { ...current.owner, port };
  const preparedPath = `${lockPath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(preparedPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // 이미 소유권을 가진 파일의 내용 갱신이므로 create 의미론(link)이 아니라
    // 원자적 대체를 쓴다. 읽는 쪽은 언제나 완결된 기록만 본다.
    await rename(preparedPath, lockPath);
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

  const port = record['port'];
  return {
    version: 2,
    acquiredAt: record['acquiredAt'],
    hostname: record['hostname'],
    ownerId: record['ownerId'],
    pid: record['pid'],
    stateRoot: record['stateRoot'],
    // 포트는 listen 뒤에 붙으므로 없을 수 있다. 있으면 유효한 값만 통과시킨다 —
    // 손상된 값을 접속 지점으로 돌려주면 CLI가 잘못된 주소를 연다.
    ...(isValidPort(port) ? { port } : {}),
  };
}

function isValidPort(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= 65_535
  );
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
