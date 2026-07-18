import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

// 컴퓨터 세션 루트/홈 자동 감지 — env 없이도 설치 직후 바로 동작하도록
// OS별 기본값을 잡는다. env(GEULBAT_COMPUTER_SESSION_ROOT/_HOME)가 있으면
// 그 값이 항상 우선하고, GEULBAT_COMPUTER_SESSION_DISABLED=1이면 끈다.

interface ComputerSessionDefaults {
  root: string;
  home?: string;
}

// Windows 시스템 프로필 — 실사용자 홈이 아니다
const WINDOWS_NON_USER_PROFILES = new Set([
  'All Users',
  'Default',
  'Default User',
  'Public',
  'WDAGUtilityAccount',
  'desktop.ini',
]);

export function detectComputerSessionDefaults(
  probe: {
    isDirectory?: (path: string) => boolean;
    listDirectory?: (path: string) => string[];
    exists?: (path: string) => boolean;
    homeDirectory?: () => string;
  } = {},
): ComputerSessionDefaults {
  const isDirectory = probe.isDirectory ?? defaultIsDirectory;
  const listDirectory = probe.listDirectory ?? defaultListDirectory;
  const exists = probe.exists ?? existsSync;
  const homeDirectory = probe.homeDirectory ?? homedir;
  const daemonHome = homeDirectory();

  // WSL: Windows C 드라이브가 마운트되어 있으면 그쪽이 사용자의 컴퓨터다
  if (isDirectory('/mnt/c')) {
    const usersRoot = '/mnt/c/Users';
    if (isDirectory(usersRoot)) {
      // 현재 WSL 사용자와 같은 이름의 Windows 프로필만 홈으로 채택한다.
      // /mnt/c/Users에는 실행 중 잠깐 나타나는 sandbox 프로필도 있으므로
      // 첫 NTUSER.DAT 프로필을 고르면 실제 사용자 바로가기가 오염된다.
      const currentUserName = basename(daemonHome).toLowerCase();
      const userHome = listDirectory(usersRoot)
        .filter((name) => !WINDOWS_NON_USER_PROFILES.has(name))
        .filter((name) => name.toLowerCase() === currentUserName)
        .map((name) => join(usersRoot, name))
        .find(
          (candidate) =>
            isDirectory(candidate) && exists(join(candidate, 'NTUSER.DAT')),
        );
      return userHome !== undefined
        ? { root: '/mnt/c', home: userHome }
        : { root: '/mnt/c' };
    }
    return { root: '/mnt/c' };
  }

  // 그 외(리눅스/맥 네이티브): 홈을 루트로 — 안전한 기본값
  return { root: daemonHome, home: daemonHome };
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultListDirectory(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
