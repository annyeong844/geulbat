import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';

// P7.5 spec v4 §5.2 — 기동 reap은 "birthToken 검증 성공분만" 프로세스 그룹을
// 종료한다. 토큰은 pid 재사용을 구분하는 커널 시각(프로세스 시작 시각)이며,
// 검증할 수 없는 플랫폼에서는 null을 돌려 kill을 금지시킨다(fail-closed).

/** 리눅스 /proc/<pid>/stat 의 22번째 필드(starttime). comm 필드는 공백·괄호를
 * 포함할 수 있으므로 마지막 ')' 뒤에서부터 센다. */
const LINUX_STARTTIME_INDEX_AFTER_COMM = 19;

export async function readProcessBirthToken(
  pid: number,
): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  switch (platform()) {
    case 'linux':
      return await readLinuxBirthToken(pid);
    case 'darwin':
      return await readDarwinBirthToken(pid);
    default:
      return null;
  }
}

/**
 * 기록된 토큰과 현재 pid의 토큰이 같을 때만 true. 어느 한쪽이라도 확인
 * 불가면 false — 호출자는 kill하지 않는다.
 */
export async function verifyProcessBirthToken(
  pid: number,
  expected: string | null,
): Promise<boolean> {
  if (expected === null) {
    return false;
  }
  const actual = await readProcessBirthToken(pid);
  return actual !== null && actual === expected;
}

async function readLinuxBirthToken(pid: number): Promise<string | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const commEnd = stat.lastIndexOf(')');
  if (commEnd < 0) {
    return null;
  }
  const fields = stat
    .slice(commEnd + 1)
    .trim()
    .split(/\s+/u);
  const startTime = fields[LINUX_STARTTIME_INDEX_AFTER_COMM];
  return startTime === undefined ? null : `linux:starttime:${startTime}`;
}

async function readDarwinBirthToken(pid: number): Promise<string | null> {
  // macOS에는 /proc이 없다. lstart는 초 단위 절대 시각이라 pid 재사용을
  // 실용적으로 구분한다.
  const started = await runExecFile('/bin/ps', [
    '-o',
    'lstart=',
    '-p',
    String(pid),
  ]);
  const trimmed = started?.trim();
  return trimmed === undefined || trimmed.length === 0
    ? null
    : `darwin:lstart:${trimmed}`;
}

async function runExecFile(
  file: string,
  args: string[],
): Promise<string | undefined> {
  return await new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8' }, (error, stdout) => {
      resolve(error === null ? stdout : undefined);
    });
  });
}
