import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectComputerSessionDefaults,
  discoverComputerSessionDefaults,
} from './computer-session-defaults.js';

const WINDOWS_USERS_ROOT = '/mnt/c/' + 'Users';

void test('WSL discovers the mounted Windows drives that actually exist instead of assuming C', () => {
  const usersRoot = '/mnt/f/Users';
  const detected = detectComputerSessionDefaults({
    isDirectory: (path) =>
      ['/mnt/f', '/mnt/z', usersRoot, `${usersRoot}/Writer`].includes(path),
    listDirectory: (path) => {
      if (path === '/mnt') {
        return ['z', 'f', 'not-a-drive'];
      }
      return path === usersRoot ? ['Writer'] : [];
    },
    exists: (path) => path === `${usersRoot}/Writer/NTUSER.DAT`,
    homeDirectory: () => '/workspace/Writer',
    environment: { WSL_DISTRO_NAME: 'Ubuntu' },
    readMountInfo: () =>
      [
        '130 80 0:68 / /mnt/f rw - 9p F: rw,aname=drvfs;path=F:',
        '131 80 0:69 / /mnt/z rw - 9p Z: rw,aname=drvfs;path=Z:',
      ].join('\n'),
  });

  assert.deepEqual(detected, {
    root: '/',
    home: `${usersRoot}/Writer`,
    browseLocations: [
      { label: 'Ubuntu (WSL)', path: '/' },
      { label: 'Windows (F:)', path: '/mnt/f' },
      { label: 'Windows (Z:)', path: '/mnt/z' },
    ],
  });
});

void test('WSL does not invent drive locations from folders that merely look like mounts', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: (path) => path === '/mnt/q',
    listDirectory: (path) => (path === '/mnt' ? ['q'] : []),
    homeDirectory: () => '/home/user',
    environment: { WSL_DISTRO_NAME: 'Ubuntu' },
    readMountInfo: () => '',
  });

  assert.deepEqual(detected, {
    root: '/',
    home: '/home/user',
    browseLocations: [{ label: 'Ubuntu (WSL)', path: '/' }],
  });
});

void test('WSL keeps the matching Windows profile as the start inside a global Computer scope', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: (path) =>
      [
        '/mnt/c',
        WINDOWS_USERS_ROOT,
        `${WINDOWS_USERS_ROOT}/CodexSandboxOffline`,
        `${WINDOWS_USERS_ROOT}/Writer`,
      ].includes(path),
    listDirectory: (path) =>
      path === WINDOWS_USERS_ROOT
        ? ['CodexSandboxOffline', 'Public', 'Writer']
        : [],
    exists: (path) =>
      [
        `${WINDOWS_USERS_ROOT}/CodexSandboxOffline/NTUSER.DAT`,
        `${WINDOWS_USERS_ROOT}/Writer/NTUSER.DAT`,
      ].includes(path),
    homeDirectory: () => '/workspace/Writer',
    environment: {},
    readMountInfo: () => '130 80 0:68 / /mnt/c rw - drvfs C: rw',
  });
  assert.deepEqual(detected, {
    root: '/',
    home: `${WINDOWS_USERS_ROOT}/Writer`,
    browseLocations: [
      { label: 'WSL', path: '/' },
      { label: 'Windows (C:)', path: '/mnt/c' },
    ],
  });
});

void test('WSL projects Windows-reported known folders without guessing localized directory names', () => {
  const usersRoot = '/mnt/f/Users';
  const powershell =
    '/mnt/f/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const detected = detectComputerSessionDefaults({
    isDirectory: (path) =>
      [
        '/mnt/f',
        usersRoot,
        `${usersRoot}/User`,
        `${usersRoot}/User/OneDrive/Arbeitsfläche`,
        `${usersRoot}/User/Downloads`,
      ].includes(path),
    listDirectory: (path) => (path === usersRoot ? ['User'] : []),
    exists: (path) =>
      path === `${usersRoot}/User/NTUSER.DAT` || path === powershell,
    homeDirectory: () => '/home/user',
    environment: { WSL_DISTRO_NAME: 'Ubuntu' },
    readMountInfo: () => '130 80 0:68 / /mnt/f rw - drvfs F: rw',
    readWindowsKnownFolderInfo: () =>
      JSON.stringify([
        {
          label: 'Desktop',
          path: 'F:\\Users\\User\\OneDrive\\Arbeitsfläche',
        },
        { label: 'Downloads', path: 'F:\\Users\\User\\Downloads' },
        { label: 'Missing', path: 'F:\\Users\\User\\Missing' },
        { label: 'Other drive', path: 'Q:\\Users\\User\\Downloads' },
      ]),
    readXdgUserDirectories: () => '',
  });

  assert.deepEqual(detected, {
    root: '/',
    home: `${usersRoot}/User`,
    browseLocations: [
      {
        label: 'Desktop',
        path: `${usersRoot}/User/OneDrive/Arbeitsfläche`,
      },
      { label: 'Downloads', path: `${usersRoot}/User/Downloads` },
      { label: 'Ubuntu (WSL)', path: '/' },
      { label: 'Windows (F:)', path: '/mnt/f' },
    ],
  });
});

void test('WSL does not guess a home from unrelated valid profiles', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: (path) =>
      [
        '/mnt/c',
        WINDOWS_USERS_ROOT,
        `${WINDOWS_USERS_ROOT}/Alice`,
        `${WINDOWS_USERS_ROOT}/Bob`,
      ].includes(path),
    listDirectory: () => ['Alice', 'Bob'],
    exists: (path) => path.endsWith('/NTUSER.DAT'),
    homeDirectory: () => '/workspace/daemon',
    environment: {},
    readMountInfo: () => '130 80 0:68 / /mnt/c rw - drvfs C: rw',
  });
  assert.deepEqual(detected, {
    root: '/',
    home: '/workspace/daemon',
    browseLocations: [
      { label: 'WSL', path: '/' },
      { label: 'Windows (C:)', path: '/mnt/c' },
    ],
  });
});

void test('WSL without a detectable Windows user starts from the Linux home', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: (path) => ['/mnt/c', WINDOWS_USERS_ROOT].includes(path),
    listDirectory: () => ['Public'],
    exists: () => false,
    homeDirectory: () => '/home/user',
    environment: {},
    readMountInfo: () => '130 80 0:68 / /mnt/c rw - drvfs C: rw',
  });
  assert.deepEqual(detected, {
    root: '/',
    home: '/home/user',
    browseLocations: [
      { label: 'WSL', path: '/' },
      { label: 'Windows (C:)', path: '/mnt/c' },
    ],
  });
});

void test('native POSIX platforms expose the global Computer scope and start at home', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: () => false,
    homeDirectory: () => '/workspace/runner-home',
    platform: () => 'linux',
    environment: {},
    readMountInfo: () => '',
  });
  assert.deepEqual(detected, {
    root: '/',
    home: '/workspace/runner-home',
    browseLocations: [{ label: 'Linux', path: '/' }],
  });
});

void test('native Linux reads existing user folders from XDG configuration', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: (path) =>
      ['/home/user/바탕 화면', '/data/writer-downloads'].includes(path),
    homeDirectory: () => '/home/user',
    platform: () => 'linux',
    environment: {},
    readMountInfo: () => '',
    readXdgUserDirectories: () =>
      [
        'XDG_DESKTOP_DIR="$HOME/바탕 화면"',
        'XDG_DOWNLOAD_DIR="/data/writer-downloads"',
        'XDG_DOCUMENTS_DIR="$HOME/없는 문서"',
      ].join('\n'),
  });

  assert.deepEqual(detected, {
    root: '/',
    home: '/home/user',
    browseLocations: [
      { label: '바탕 화면', path: '/home/user/바탕 화면' },
      { label: 'writer-downloads', path: '/data/writer-downloads' },
      { label: 'Linux', path: '/' },
    ],
  });
});

void test('native macOS uses Foundation-reported folders and mounted volumes without path guesses', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: (path) =>
      [
        '/',
        '/Users/writer/Schreibtisch',
        '/Users/writer/Downloads',
        '/Volumes/자료 보관함',
      ].includes(path),
    homeDirectory: () => '/Users/writer',
    platform: () => 'darwin',
    environment: {},
    readMountInfo: () => '',
    readMacBrowseLocationInfo: () =>
      JSON.stringify([
        { label: 'Schreibtisch', path: '/Users/writer/Schreibtisch' },
        { label: 'Downloads', path: '/Users/writer/Downloads' },
        { label: '자료 보관함', path: '/Volumes/자료 보관함' },
        { label: 'Macintosh HD', path: '/' },
        { label: 'duplicate', path: '/Volumes/자료 보관함/' },
        { label: 'relative', path: 'Users/writer/Desktop' },
        { label: 'missing', path: '/Volumes/missing' },
      ]),
    readXdgUserDirectories: () => '',
  });

  assert.deepEqual(detected, {
    root: '/',
    home: '/Users/writer',
    browseLocations: [
      { label: 'Schreibtisch', path: '/Users/writer/Schreibtisch' },
      { label: 'Downloads', path: '/Users/writer/Downloads' },
      { label: '자료 보관함', path: '/Volumes/자료 보관함' },
      { label: 'macOS', path: '/' },
    ],
  });
});

void test('native macOS keeps home and root browsing when host discovery is unavailable', () => {
  let observedPolicy:
    | { timeoutMs: number; maxBufferBytes: number; windowsHide: boolean }
    | undefined;
  const detected = detectComputerSessionDefaults({
    isDirectory: () => false,
    homeDirectory: () => '/Users/writer',
    platform: () => 'darwin',
    environment: {},
    readMountInfo: () => '',
    runDiscoveryCommand: (invocation) => {
      observedPolicy = {
        timeoutMs: invocation.timeoutMs,
        maxBufferBytes: invocation.maxBufferBytes,
        windowsHide: invocation.windowsHide,
      };
      return {
        error: new Error('osascript unavailable'),
        status: null,
        stdout: '',
      };
    },
    readXdgUserDirectories: () => '',
  });

  assert.deepEqual(detected, {
    root: '/',
    home: '/Users/writer',
    browseLocations: [{ label: 'macOS', path: '/' }],
  });
  assert.deepEqual(observedPolicy, {
    // 기본 타임아웃 15초 — WSL interop 실측(2.8~4.0초) 위로 보정된 공유
    // 정책이 macOS 발견에도 그대로 전달된다
    timeoutMs: 15_000,
    maxBufferBytes: 1024 * 1024,
    windowsHide: false,
  });
});

void test('other native POSIX hosts keep their real platform label', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: () => false,
    homeDirectory: () => '/home/writer',
    platform: () => 'freebsd',
    environment: {},
    readMountInfo: () => '',
    readXdgUserDirectories: () => '',
  });

  assert.deepEqual(detected, {
    root: '/',
    home: '/home/writer',
    browseLocations: [{ label: 'freebsd', path: '/' }],
  });
});

void test('native Windows uses only the drive roots reported by the operating system', () => {
  const detected = detectComputerSessionDefaults({
    isDirectory: (path) =>
      ['F:\\Users\\Writer\\Desktop', 'F:\\Users\\Writer\\Downloads'].includes(
        path,
      ),
    homeDirectory: () => 'F:\\Users\\Writer',
    platform: () => 'win32',
    environment: {},
    readMountInfo: () => '',
    readWindowsDriveInfo: () =>
      JSON.stringify([
        { path: 'F:\\', label: 'Archive' },
        { path: 'C:\\', label: '' },
        { path: 'F:\\', label: 'duplicate' },
        { path: 'relative-folder', label: 'not a drive' },
      ]),
    readWindowsKnownFolderInfo: () =>
      JSON.stringify([
        { label: 'Desktop', path: 'F:\\Users\\Writer\\Desktop' },
        { label: 'Downloads', path: 'F:\\Users\\Writer\\Downloads' },
      ]),
  });

  assert.deepEqual(detected, {
    root: 'F:\\',
    home: 'F:\\Users\\Writer',
    browseLocations: [
      { label: 'Desktop', path: 'F:\\Users\\Writer\\Desktop' },
      { label: 'Downloads', path: 'F:\\Users\\Writer\\Downloads' },
      { label: 'Windows (C:)', path: 'C:\\' },
      { label: 'Archive (F:)', path: 'F:\\' },
    ],
  });
});

void test('async discovery replays command results through the same projection', async () => {
  // 2-패스 발견 — 1패스가 기록한 호출을 비동기로 실행하고, 2패스가 결과를
  // 재생해 동기 감지와 같은 파서/투영을 통과시킨다. 성공 시 complete=true.
  const usersRoot = '/mnt/c/Users';
  const userHome = `${usersRoot}/Writer`;
  const powershell =
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const asyncExecutables: string[] = [];
  const outcome = await discoverComputerSessionDefaults({
    isDirectory: (path) =>
      [
        '/mnt/c',
        usersRoot,
        userHome,
        `${userHome}/Downloads`,
        `${userHome}/OneDrive/사진`,
      ].includes(path),
    listDirectory: (path) => (path === usersRoot ? ['Writer'] : []),
    exists: (path) => path === `${userHome}/NTUSER.DAT` || path === powershell,
    homeDirectory: () => '/home/writer',
    environment: { WSL_DISTRO_NAME: 'Ubuntu' },
    readMountInfo: () => '130 80 0:68 / /mnt/c rw - drvfs C: rw',
    readXdgUserDirectories: () => '',
    runDiscoveryCommandAsync: (invocation) => {
      asyncExecutables.push(invocation.executable);
      return Promise.resolve({
        error: undefined,
        status: 0,
        stdout: JSON.stringify([
          { label: '다운로드', path: 'C:\\Users\\Writer\\Downloads' },
          { label: '사진', path: 'C:\\Users\\Writer\\OneDrive\\사진' },
        ]),
      });
    },
  });

  assert.deepEqual(asyncExecutables, [powershell]);
  assert.equal(outcome.complete, true);
  assert.deepEqual(outcome.defaults.browseLocations, [
    { label: '다운로드', path: `${userHome}/Downloads` },
    { label: '사진', path: `${userHome}/OneDrive/사진` },
    { label: 'Ubuntu (WSL)', path: '/' },
    { label: 'Windows (C:)', path: '/mnt/c' },
  ]);
});

void test('async discovery reports incomplete on command failure without inventing locations', async () => {
  // 실패는 complete=false로 보고될 뿐이다 — 위치를 지어내지 않고, 재시도
  // 여부는 수명 주기(computer-browse-discovery)가 결정한다.
  const usersRoot = '/mnt/c/Users';
  const userHome = `${usersRoot}/Writer`;
  const powershell =
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const outcome = await discoverComputerSessionDefaults({
    isDirectory: (path) => ['/mnt/c', usersRoot, userHome].includes(path),
    listDirectory: (path) => (path === usersRoot ? ['Writer'] : []),
    exists: (path) => path === `${userHome}/NTUSER.DAT` || path === powershell,
    homeDirectory: () => '/home/writer',
    environment: { WSL_DISTRO_NAME: 'Ubuntu' },
    readMountInfo: () => '130 80 0:68 / /mnt/c rw - drvfs C: rw',
    readXdgUserDirectories: () => '',
    runDiscoveryCommandAsync: () =>
      Promise.resolve({
        error: new Error('interop timed out'),
        status: null,
        stdout: '',
      }),
  });

  assert.equal(outcome.complete, false);
  assert.deepEqual(outcome.defaults.browseLocations, [
    { label: 'Ubuntu (WSL)', path: '/' },
    { label: 'Windows (C:)', path: '/mnt/c' },
  ]);
});

void test('async discovery completes without commands on plain Linux', async () => {
  // 명령이 필요 없는 플랫폼(Linux/XDG)은 즉시 complete — 재시도 루프가
  // 헛돌지 않는다.
  const outcome = await discoverComputerSessionDefaults({
    isDirectory: () => false,
    homeDirectory: () => '/home/writer',
    platform: () => 'linux',
    environment: {},
    readMountInfo: () => '',
    readXdgUserDirectories: () => '',
    runDiscoveryCommandAsync: () =>
      Promise.reject(new Error('must not run any command on linux')),
  });

  assert.equal(outcome.complete, true);
  assert.deepEqual(outcome.defaults.browseLocations, [
    { label: 'Linux', path: '/' },
  ]);
});

void test('discovery default timeout stays above normal WSL interop latency', () => {
  // 회귀 잠금(2026-07-23): WSL→powershell.exe는 정상 상태에서도 no-op이
  // 2.6~3.0초, known-folder 스크립트는 2.8~4.0초 걸린다(실측). 기본
  // 타임아웃이 이 아래로 내려가면 정상 실행이 타임아웃으로 오판돼 빠른
  // 위치에서 다운로드·사진·음악이 사라지는 회귀가 재발한다.
  const usersRoot = '/mnt/c/Users';
  const powershell =
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const observedTimeouts: number[] = [];
  detectComputerSessionDefaults({
    isDirectory: (path) =>
      ['/mnt/c', usersRoot, `${usersRoot}/Writer`].includes(path),
    listDirectory: (path) => (path === usersRoot ? ['Writer'] : []),
    exists: (path) =>
      path === `${usersRoot}/Writer/NTUSER.DAT` || path === powershell,
    homeDirectory: () => '/home/writer',
    environment: { WSL_DISTRO_NAME: 'Ubuntu' },
    readMountInfo: () => '130 80 0:68 / /mnt/c rw - drvfs C: rw',
    readXdgUserDirectories: () => '',
    runDiscoveryCommand: (invocation) => {
      observedTimeouts.push(invocation.timeoutMs);
      return { error: undefined, status: 0, stdout: '[]' };
    },
  });

  assert.ok(observedTimeouts.length > 0, 'discovery command must run');
  for (const timeoutMs of observedTimeouts) {
    assert.ok(
      timeoutMs >= 10_000,
      `discovery timeout ${timeoutMs}ms must stay well above measured 2.8~4.0s interop latency`,
    );
  }
});

void test('native Windows bounds optional platform discovery commands', () => {
  const observedInvocations: Array<{
    executable: string;
    timeoutMs: number;
    maxBufferBytes: number;
    windowsHide: boolean;
  }> = [];
  const detected = detectComputerSessionDefaults({
    isDirectory: () => false,
    homeDirectory: () => 'F:\\Users\\Writer',
    platform: () => 'win32',
    environment: {
      GEULBAT_COMPUTER_SESSION_DISCOVERY_TIMEOUT_MS: '23',
      GEULBAT_COMPUTER_SESSION_DISCOVERY_MAX_BUFFER_BYTES: '4096',
    },
    readMountInfo: () => '',
    runDiscoveryCommand: (invocation) => {
      observedInvocations.push({
        executable: invocation.executable,
        timeoutMs: invocation.timeoutMs,
        maxBufferBytes: invocation.maxBufferBytes,
        windowsHide: invocation.windowsHide,
      });
      return { error: undefined, status: 0, stdout: '[]' };
    },
  });

  assert.deepEqual(detected, {
    root: 'F:\\',
    home: 'F:\\Users\\Writer',
    browseLocations: [{ label: 'Windows', path: 'F:\\' }],
  });
  assert.deepEqual(observedInvocations, [
    {
      executable: 'powershell.exe',
      timeoutMs: 23,
      maxBufferBytes: 4096,
      windowsHide: true,
    },
    {
      executable: 'powershell.exe',
      timeoutMs: 23,
      maxBufferBytes: 4096,
      windowsHide: true,
    },
  ]);
});
