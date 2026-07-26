import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyProcessBirthToken } from './process-identity.js';

// P7.5 spec v4 §6.1·§6.2·§6.4 — 소켓·lock은 stateRoot 아래가 아니라
// 런타임 디렉터리 + canonical stateRoot 해시로 양 플랫폼 대칭 구성한다.
// 해시는 경로 식별용일 뿐 identity가 아니다 — 진짜 identity는 initialize
// 핸드셰이크의 전체 fingerprint 대조다.

export interface CommandHostPaths {
  canonicalStateRoot: string;
  /** sha256(canonicalStateRoot) 전체 hex — initialize 대조용. */
  stateRootFingerprint: string;
  runtimeDir: string;
  socketPath: string;
  lockPath: string;
}

export async function resolveCommandHostPaths(
  stateRoot: string,
): Promise<CommandHostPaths> {
  if (process.platform === 'win32') {
    // spec §9.1 — Windows worker 모드는 Job Object + pipe ACL이 들어올
    // 때까지 비지원.
    throw new Error('command-host worker mode is not supported on Windows.');
  }
  const canonicalStateRoot = await realpath(stateRoot);
  const stateRootFingerprint = createHash('sha256')
    .update(canonicalStateRoot)
    .digest('hex');
  const base = process.env['XDG_RUNTIME_DIR']?.trim() || tmpdir();
  const runtimeDir = join(base, 'geulbat');
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const stats = await lstat(runtimeDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('command-host runtime directory must be a real directory.');
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(
      'command-host runtime directory is not owned by this user.',
    );
  }
  const socketPath = join(
    runtimeDir,
    `command-host-${stateRootFingerprint.slice(0, 32)}.sock`,
  );
  return {
    canonicalStateRoot,
    stateRootFingerprint,
    runtimeDir,
    socketPath,
    lockPath: `${socketPath}.lock`,
  };
}

export interface CommandHostLockRecord {
  lockFormatVersion: 1;
  ownerMode: 'worker' | 'inline';
  pid: number;
  birthTokenMs: number;
  /**
   * owner 프로세스의 커널 시작 시각 — pid 재사용을 구분한다(§6.2 stale 판정).
   * 검증 불가 플랫폼은 null이고, 그때는 pid 생존 검사만으로 판정한다.
   */
  birthToken?: string | null;
  workerInstanceId?: string;
  endpoint?: string;
  stateRootFingerprint: string;
}

type CommandHostLockOutcome =
  // release는 lockPath만 닫는 자립 클로저다 — 호출자가 나중에 부르려고
  // 들고 다니므로(this 없는) 함수 프로퍼티로 선언한다.
  | { ok: true; release: () => Promise<void> }
  | { ok: false; kind: 'held'; owner: CommandHostLockRecord }
  | { ok: false; kind: 'unparsable_fresh' };

/**
 * spec §6.2 — `open('wx')` 원자 획득. 기존 lock은 pid 생존 검사로 stale
 * 판정 후 교체하되, **신선하지만 파싱 불가능한 lock은 stale이 아니다**
 * (기록 전 창) — 호출자가 재시도한다.
 */
export async function acquireCommandHostLock(
  lockPath: string,
  record: Omit<CommandHostLockRecord, 'lockFormatVersion'>,
): Promise<CommandHostLockOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(
        JSON.stringify({ lockFormatVersion: 1, ...record }),
      );
      await handle.sync();
      return {
        ok: true,
        async release() {
          await unlink(lockPath).catch(() => undefined);
        },
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const existing = await readCommandHostLock(lockPath);
    if (existing === 'missing') {
      continue; // 획득 재시도
    }
    if (existing === 'unparsable') {
      return { ok: false, kind: 'unparsable_fresh' };
    }
    if (await isLockOwnerAlive(existing)) {
      return { ok: false, kind: 'held', owner: existing };
    }
    // stale — pid+birthToken 검증으로 죽었다고 판명된 owner의 lock만 교체한다.
    await unlink(lockPath).catch(() => undefined);
  }
  return { ok: false, kind: 'unparsable_fresh' };
}

export async function readCommandHostLock(
  lockPath: string,
): Promise<CommandHostLockRecord | 'missing' | 'unparsable'> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return 'missing';
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as CommandHostLockRecord).lockFormatVersion === 1 &&
      typeof (parsed as CommandHostLockRecord).pid === 'number'
    ) {
      return parsed as CommandHostLockRecord;
    }
  } catch {
    // fallthrough
  }
  return 'unparsable';
}

/**
 * §6.2 stale 판정 — pid가 살아 있고, 기록된 birthToken이 있다면 그 토큰까지
 * 일치할 때만 owner가 살아 있다고 본다. 토큰이 없으면(구 lock·검증 불가
 * 플랫폼) pid 생존만으로 판정한다.
 */
export async function isLockOwnerAlive(
  record: CommandHostLockRecord,
): Promise<boolean> {
  if (!isProcessAlive(record.pid)) {
    return false;
  }
  const birthToken = record.birthToken;
  if (birthToken === undefined || birthToken === null) {
    return true;
  }
  return await verifyProcessBirthToken(record.pid, birthToken);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
