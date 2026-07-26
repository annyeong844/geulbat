import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform as hostPlatform } from 'node:os';
import { basename, isAbsolute, join, parse, posix, win32 } from 'node:path';

import { createLogger } from '@geulbat/structured-logger/logger';

// 컴퓨터 세션 루트/홈 자동 감지 — env 없이도 설치 직후 바로 동작하도록
// OS별 기본값을 잡는다. env(GEULBAT_COMPUTER_SESSION_ROOT/_HOME)가 있으면
// 그 값이 항상 우선하고, GEULBAT_COMPUTER_SESSION_DISABLED=1이면 끈다.

interface ComputerSessionDefaults {
  root: string;
  home?: string;
  browseLocations: Array<{ label: string; path: string }>;
}

type ComputerBrowseLocation =
  ComputerSessionDefaults['browseLocations'][number];

interface WindowsDriveMount {
  letter: string;
  path: string;
}

interface WindowsDriveLocation {
  path: string;
  label?: string;
}

interface ComputerSessionDiscoveryCommandPolicy {
  timeoutMs: number;
  maxBufferBytes: number;
}

export interface ComputerSessionDiscoveryCommandInvocation extends ComputerSessionDiscoveryCommandPolicy {
  executable: string;
  args: readonly string[];
  windowsHide: boolean;
}

export interface ComputerSessionDiscoveryCommandResult {
  error: Error | undefined;
  status: number | null;
  stdout: string;
}

type ComputerSessionDiscoveryCommandRunner = (
  invocation: ComputerSessionDiscoveryCommandInvocation,
) => ComputerSessionDiscoveryCommandResult;

export type ComputerSessionDiscoveryCommandRunnerAsync = (
  invocation: ComputerSessionDiscoveryCommandInvocation,
) => Promise<ComputerSessionDiscoveryCommandResult>;

const logger = createLogger('computer-session-defaults');

const COMPUTER_SESSION_DISCOVERY_TIMEOUT_MS_ENV =
  'GEULBAT_COMPUTER_SESSION_DISCOVERY_TIMEOUT_MS';
const COMPUTER_SESSION_DISCOVERY_MAX_BUFFER_BYTES_ENV =
  'GEULBAT_COMPUTER_SESSION_DISCOVERY_MAX_BUFFER_BYTES';
// 발견 명령 타임아웃은 "행이 걸린 프로세스를 죽이는 안전 상한"이다. 발견은
// 비동기 백그라운드에서 돌므로(computer-browse-discovery.ts) 이 값은 어떤
// 경로도 블로킹하지 않는다. 하한 근거: WSL→powershell.exe는 정상 상태에서도
// no-op이 2.6~3.0초, known-folder 스크립트는 2.8~4.0초 실측(2026-07-23) —
// 상한이 정상 분포(3~4초) 아래로 내려가면 정상 실행을 실패로 오판한다.
const DEFAULT_COMPUTER_SESSION_DISCOVERY_TIMEOUT_MS = 15_000;
const DEFAULT_COMPUTER_SESSION_DISCOVERY_MAX_BUFFER_BYTES = 1024 * 1024;

const WINDOWS_DRIVE_DISCOVERY_SCRIPT = String.raw`
$drives = @(
  [System.IO.DriveInfo]::GetDrives() |
    Where-Object { $_.IsReady } |
    ForEach-Object {
      [PSCustomObject]@{
        path = $_.RootDirectory.FullName
        label = $_.VolumeLabel
      }
    }
)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write((ConvertTo-Json -Compress -InputObject $drives))
`;

const WINDOWS_KNOWN_FOLDER_DISCOVERY_SCRIPT = String.raw`
$folders = @()
$shell = $null
try {
  $shell = New-Object -ComObject Shell.Application
} catch {}

function Add-KnownFolder {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [System.IO.Directory]::Exists($Path)) {
    return
  }
  $trimmedPath = $Path.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $leafName = [System.IO.Path]::GetFileName($trimmedPath)
  $displayName = $leafName
  if ($null -ne $shell) {
    try {
      $parentPath = [System.IO.Path]::GetDirectoryName($trimmedPath)
      $parentFolder = $shell.NameSpace($parentPath)
      $shellItem = $parentFolder.ParseName($leafName)
      if ($null -ne $shellItem -and -not [string]::IsNullOrWhiteSpace($shellItem.Name)) {
        $displayName = $shellItem.Name
      }
    } catch {}
  }
  $script:folders += [PSCustomObject]@{
    label = $displayName
    path = $trimmedPath
  }
}

Add-KnownFolder ([Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory))
$downloads = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -Name '{374DE290-123F-4565-9164-39C4925E467B}' -ErrorAction SilentlyContinue).'{374DE290-123F-4565-9164-39C4925E467B}'
if (-not [string]::IsNullOrWhiteSpace($downloads)) {
  Add-KnownFolder ([Environment]::ExpandEnvironmentVariables($downloads))
}
Add-KnownFolder ([Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments))
Add-KnownFolder ([Environment]::GetFolderPath([Environment+SpecialFolder]::MyPictures))
Add-KnownFolder ([Environment]::GetFolderPath([Environment+SpecialFolder]::MyMusic))
Add-KnownFolder ([Environment]::GetFolderPath([Environment+SpecialFolder]::MyVideos))

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write((ConvertTo-Json -Compress -InputObject $folders))
`;

// macOS의 사용자 폴더와 마운트 볼륨은 이름을 추측하지 않고 Foundation이
// 반환하는 실제 URL과 표시 이름을 사용한다. 출력은 외부 프로세스 경계에서
// 아래 parser가 다시 검증한다.
const MACOS_BROWSE_LOCATION_DISCOVERY_SCRIPT = String.raw`
ObjC.import('Foundation');

var manager = $.NSFileManager.defaultManager;
var locations = [];
var seenPaths = Object.create(null);

function addUrl(url) {
  if (url === undefined || url === null) {
    return;
  }
  var path = ObjC.unwrap(url.path);
  if (typeof path !== 'string' || path.length === 0 || seenPaths[path] === true) {
    return;
  }
  var displayName = ObjC.unwrap(manager.displayNameAtPath(path));
  locations.push({
    label: typeof displayName === 'string' && displayName.length > 0 ? displayName : path,
    path: path,
  });
  seenPaths[path] = true;
}

var userDirectoryKinds = [
  $.NSDesktopDirectory,
  $.NSDownloadsDirectory,
  $.NSDocumentDirectory,
  $.NSPicturesDirectory,
  $.NSMusicDirectory,
  $.NSMoviesDirectory,
];
for (var directoryIndex = 0; directoryIndex < userDirectoryKinds.length; directoryIndex += 1) {
  var urls = manager.URLsForDirectoryInDomains(
    userDirectoryKinds[directoryIndex],
    $.NSUserDomainMask,
  );
  if (urls !== undefined && urls !== null && Number(urls.count) > 0) {
    addUrl(urls.objectAtIndex(0));
  }
}

var volumeUrls = manager.mountedVolumeURLsIncludingResourceValuesForKeysOptions(
  [],
  $.NSVolumeEnumerationSkipHiddenVolumes,
);
if (volumeUrls !== undefined && volumeUrls !== null) {
  for (var volumeIndex = 0; volumeIndex < Number(volumeUrls.count); volumeIndex += 1) {
    addUrl(volumeUrls.objectAtIndex(volumeIndex));
  }
}

JSON.stringify(locations);
`;

const XDG_USER_DIRECTORY_KEYS = [
  'DESKTOP',
  'DOWNLOAD',
  'DOCUMENTS',
  'PICTURES',
  'MUSIC',
  'VIDEOS',
] as const;

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
    platform?: () => NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    readMountInfo?: () => string;
    readWindowsDriveInfo?: () => string;
    readWindowsKnownFolderInfo?: () => string;
    readMacBrowseLocationInfo?: () => string;
    readXdgUserDirectories?: () => string;
    runDiscoveryCommand?: ComputerSessionDiscoveryCommandRunner;
  } = {},
): ComputerSessionDefaults {
  const isDirectory = probe.isDirectory ?? defaultIsDirectory;
  const listDirectory = probe.listDirectory ?? defaultListDirectory;
  const exists = probe.exists ?? existsSync;
  const homeDirectory = probe.homeDirectory ?? homedir;
  const platform = probe.platform ?? hostPlatform;
  const environment = probe.environment ?? process.env;
  const readMountInfo = probe.readMountInfo ?? defaultReadMountInfo;
  const discoveryCommandPolicy =
    resolveComputerSessionDiscoveryCommandPolicy(environment);
  const runDiscoveryCommand =
    probe.runDiscoveryCommand ?? refuseCommandBackedDiscovery;
  const readWindowsDriveInfo =
    probe.readWindowsDriveInfo ??
    (() =>
      defaultReadWindowsDriveInfo({
        policy: discoveryCommandPolicy,
        runDiscoveryCommand,
      }));
  const daemonHome = homeDirectory();
  const currentPlatform = platform();
  const globalComputerRoot =
    currentPlatform === 'win32'
      ? win32.parse(daemonHome).root
      : parse(daemonHome).root;

  const mountInfoDrives = collectWslDriveMounts(readMountInfo());
  const isWsl =
    mountInfoDrives.length > 0 ||
    Boolean(environment['WSL_DISTRO_NAME']?.trim()) ||
    Boolean(environment['WSL_INTEROP']?.trim());
  const wslDrives = mountInfoDrives.filter((drive) => isDirectory(drive.path));
  const xdgUserDirectories = collectXdgUserDirectories({
    home: daemonHome,
    isDirectory,
    raw:
      probe.readXdgUserDirectories?.() ??
      defaultReadXdgUserDirectories(daemonHome, environment),
  });

  // WSL에서는 /가 Linux ext4와 /mnt 아래의 Windows 드라이브를 함께
  // 표현하는 공통 경로 기준점이다. Windows 프로필은 탐색 시작점일 뿐
  // 파일 권한이나 대화/run 저장소를 소유하지 않는다.
  if (isWsl) {
    const distroName = environment['WSL_DISTRO_NAME']?.trim();
    const userHome = findMatchingWindowsUserHome({
      daemonHome,
      drives: wslDrives,
      isDirectory,
      listDirectory,
      exists,
    });
    const windowsKnownFolders = readWindowsKnownFolderLocations({
      drives: wslDrives,
      isDirectory,
      readWindowsKnownFolderInfo: probe.readWindowsKnownFolderInfo,
      powershellExecutable: findWslWindowsPowerShell(wslDrives, exists),
      discoveryCommandPolicy,
      runDiscoveryCommand,
    });
    return {
      root: globalComputerRoot,
      home: userHome ?? daemonHome,
      browseLocations: [
        ...windowsKnownFolders,
        ...xdgUserDirectories,
        {
          label: distroName ? `${distroName} (WSL)` : 'WSL',
          path: globalComputerRoot,
        },
        ...wslDrives.map((drive) => ({
          label: `Windows (${drive.letter}:)`,
          path: drive.path,
        })),
      ],
    };
  }

  if (currentPlatform === 'win32') {
    let discoveredDrives: WindowsDriveLocation[] = [];
    try {
      discoveredDrives = parseWindowsDriveLocations(readWindowsDriveInfo());
    } catch {
      // 명령 실패·부팅 지연은 여기서 로그하지 않는다 — 발견 수명 주기
      // (computer-browse-discovery)가 재시도와 함께 단일 지점에서 보고한다.
      // 부팅은 명령을 일부러 미루므로 이 경로가 정상 흐름에서 매번 걸린다.
    }
    const driveLocations = discoveredDrives.map((drive) => ({
      label: formatWindowsDriveLabel(drive),
      path: drive.path,
    }));
    const windowsKnownFolders = readWindowsKnownFolderLocations({
      drives: [],
      isDirectory,
      readWindowsKnownFolderInfo: probe.readWindowsKnownFolderInfo,
      powershellExecutable: 'powershell.exe',
      discoveryCommandPolicy,
      runDiscoveryCommand,
    });
    return {
      root: globalComputerRoot,
      home: daemonHome,
      browseLocations:
        driveLocations.length > 0
          ? [...windowsKnownFolders, ...driveLocations]
          : [
              ...windowsKnownFolders,
              { label: 'Windows', path: globalComputerRoot },
            ],
    };
  }

  if (currentPlatform === 'darwin') {
    const macBrowseLocations = readMacBrowseLocations({
      isDirectory,
      readMacBrowseLocationInfo: probe.readMacBrowseLocationInfo,
      discoveryCommandPolicy,
      runDiscoveryCommand,
    }).filter((location) => location.path !== globalComputerRoot);
    return {
      root: globalComputerRoot,
      home: daemonHome,
      browseLocations: [
        ...macBrowseLocations,
        ...xdgUserDirectories,
        { label: 'macOS', path: globalComputerRoot },
      ],
    };
  }

  // 네이티브 환경도 Home은 시작점일 뿐이다. 파일 접근 권한은 현재 OS가
  // 결정하고, 볼륨 루트는 경로 좌표의 기준점으로만 사용한다.
  return {
    root: globalComputerRoot,
    home: daemonHome,
    browseLocations: [
      ...xdgUserDirectories,
      {
        label: currentPlatform === 'linux' ? 'Linux' : currentPlatform,
        path: globalComputerRoot,
      },
    ],
  };
}

// ─── 비동기 발견 (2-패스) ───
// 회귀의 뿌리는 외부 명령(PowerShell/osascript)이 부팅 동기 경로에서 1회
// 실행되고, 그 실패가 데몬 수명 동안 동결되는 구조였다. 이 함수는 명령
// 실행을 이벤트 루프 밖(비동기)으로 옮긴다: 1패스는 명령을 실행하지 않고
// "이 플랫폼이 원하는 호출"만 기록하며, 호출을 비동기로 실행한 뒤 2패스가
// 그 결과를 재생해 기존 파서/투영 코드를 그대로 재사용한다. 실패는
// complete=false로 보고만 되고 결과를 동결시키지 않는다 — 재시도 수명
// 주기는 computer-browse-discovery.ts가 소유한다.

interface ComputerSessionDiscoveryOutcome {
  defaults: ComputerSessionDefaults;
  complete: boolean;
}

type ComputerSessionDetectionProbe = NonNullable<
  Parameters<typeof detectComputerSessionDefaults>[0]
>;

export async function discoverComputerSessionDefaults(
  probe: Omit<ComputerSessionDetectionProbe, 'runDiscoveryCommand'> & {
    /**
     * 발견 명령의 실행기. 기본값이 없는 것은 의도다 — 이 명령은 데몬의 자식이 아니라
     * command-host 세션에서 돌아야 하고(P7.6 item 4), 실행 위치는 조립이 정한다.
     */
    runDiscoveryCommandAsync: ComputerSessionDiscoveryCommandRunnerAsync;
  },
): Promise<ComputerSessionDiscoveryOutcome> {
  const { runDiscoveryCommandAsync: runAsync, ...baseProbe } = probe;

  const planned: ComputerSessionDiscoveryCommandInvocation[] = [];
  detectComputerSessionDefaults({
    ...baseProbe,
    runDiscoveryCommand: (invocation) => {
      planned.push(invocation);
      return {
        error: new Error('discovery deferred to the async pass'),
        status: null,
        stdout: '',
      };
    },
  });

  const replay = new Map<string, ComputerSessionDiscoveryCommandResult>();
  let complete = true;
  for (const invocation of planned) {
    const result = await runAsync(invocation);
    if (result.error !== undefined || result.status !== 0) {
      complete = false;
    }
    replay.set(discoveryInvocationKey(invocation), result);
  }

  const defaults = detectComputerSessionDefaults({
    ...baseProbe,
    runDiscoveryCommand: (invocation) =>
      replay.get(discoveryInvocationKey(invocation)) ?? {
        error: new Error('discovery result missing for replay'),
        status: null,
        stdout: '',
      },
  });
  return { defaults, complete };
}

function discoveryInvocationKey(
  invocation: ComputerSessionDiscoveryCommandInvocation,
): string {
  return [invocation.executable, ...invocation.args].join('\u001f');
}

function readWindowsKnownFolderLocations(args: {
  drives: readonly WindowsDriveMount[];
  isDirectory: (path: string) => boolean;
  readWindowsKnownFolderInfo: (() => string) | undefined;
  powershellExecutable: string | undefined;
  discoveryCommandPolicy: ComputerSessionDiscoveryCommandPolicy;
  runDiscoveryCommand: ComputerSessionDiscoveryCommandRunner;
}): ComputerBrowseLocation[] {
  if (
    args.readWindowsKnownFolderInfo === undefined &&
    args.powershellExecutable === undefined
  ) {
    return [];
  }
  try {
    let raw: string;
    if (args.readWindowsKnownFolderInfo !== undefined) {
      raw = args.readWindowsKnownFolderInfo();
    } else if (args.powershellExecutable !== undefined) {
      raw = defaultReadWindowsKnownFolderInfo(args.powershellExecutable, {
        policy: args.discoveryCommandPolicy,
        runDiscoveryCommand: args.runDiscoveryCommand,
      });
    } else {
      return [];
    }
    const locations = parseWindowsKnownFolderLocations(raw);
    const projected =
      args.drives.length === 0
        ? locations.filter((location) => args.isDirectory(location.path))
        : locations.flatMap((location) => {
            const path = projectWindowsPathToWsl(location.path, args.drives);
            return path !== undefined && args.isDirectory(path)
              ? [{ label: location.label, path }]
              : [];
          });
    return deduplicateKnownFolderLocations(projected);
  } catch {
    // 실패·부팅 지연 로그는 발견 수명 주기가 단일 지점에서 — 조용히 비운다
    return [];
  }
}

function parseWindowsKnownFolderLocations(
  raw: string,
): ComputerBrowseLocation[] {
  const parsed: unknown = JSON.parse(raw);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const locations: ComputerBrowseLocation[] = [];
  for (const value of values) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const label: unknown = Reflect.get(value, 'label');
    const path: unknown = Reflect.get(value, 'path');
    if (
      typeof label !== 'string' ||
      label.trim().length === 0 ||
      typeof path !== 'string' ||
      !win32.isAbsolute(path)
    ) {
      continue;
    }
    locations.push({ label: label.trim(), path: win32.normalize(path) });
  }
  return deduplicateKnownFolderLocations(locations);
}

function projectWindowsPathToWsl(
  path: string,
  drives: readonly WindowsDriveMount[],
): string | undefined {
  const match = /^([a-z]):(?:[\\/](.*))?$/iu.exec(path);
  if (match === null) {
    return undefined;
  }
  const drive = drives.find(
    (candidate) => candidate.letter === match[1]?.toUpperCase(),
  );
  if (drive === undefined) {
    return undefined;
  }
  const segments = (match[2] ?? '').split(/[\\/]+/u).filter(Boolean);
  return join(drive.path, ...segments);
}

function deduplicateKnownFolderLocations(
  locations: readonly ComputerBrowseLocation[],
): ComputerBrowseLocation[] {
  const found = new Map<string, ComputerBrowseLocation>();
  for (const location of locations) {
    const key = location.path.toLowerCase();
    if (!found.has(key)) {
      found.set(key, location);
    }
  }
  return [...found.values()];
}

function readMacBrowseLocations(args: {
  isDirectory: (path: string) => boolean;
  readMacBrowseLocationInfo: (() => string) | undefined;
  discoveryCommandPolicy: ComputerSessionDiscoveryCommandPolicy;
  runDiscoveryCommand: ComputerSessionDiscoveryCommandRunner;
}): ComputerBrowseLocation[] {
  try {
    const raw =
      args.readMacBrowseLocationInfo?.() ??
      defaultReadMacBrowseLocationInfo({
        policy: args.discoveryCommandPolicy,
        runDiscoveryCommand: args.runDiscoveryCommand,
      });
    return parseMacBrowseLocations(raw).filter((location) =>
      args.isDirectory(location.path),
    );
  } catch {
    // 실패·부팅 지연 로그는 발견 수명 주기가 단일 지점에서 — 조용히 비운다
    return [];
  }
}

function parseMacBrowseLocations(raw: string): ComputerBrowseLocation[] {
  const parsed: unknown = JSON.parse(raw);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const found = new Map<string, ComputerBrowseLocation>();
  for (const value of values) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const label: unknown = Reflect.get(value, 'label');
    const path: unknown = Reflect.get(value, 'path');
    if (
      typeof label !== 'string' ||
      label.trim().length === 0 ||
      typeof path !== 'string' ||
      !posix.isAbsolute(path)
    ) {
      continue;
    }
    const normalizedPath = posix.normalize(path);
    if (!found.has(normalizedPath)) {
      found.set(normalizedPath, {
        label: label.trim(),
        path: normalizedPath,
      });
    }
  }
  return [...found.values()];
}

function findWslWindowsPowerShell(
  drives: readonly WindowsDriveMount[],
  exists: (path: string) => boolean,
): string | undefined {
  for (const drive of drives) {
    const candidate = join(
      drive.path,
      'Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    if (exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function collectXdgUserDirectories(args: {
  home: string;
  isDirectory: (path: string) => boolean;
  raw: string;
}): Array<{ label: string; path: string }> {
  const configured = new Map<string, string>();
  for (const line of args.raw.split('\n')) {
    const match = /^XDG_([A-Z]+)_DIR=(.*)$/u.exec(line.trim());
    if (
      match === null ||
      !XDG_USER_DIRECTORY_KEYS.some((key) => key === match[1])
    ) {
      continue;
    }
    const path = resolveXdgUserDirectoryValue(match[2] ?? '', args.home);
    if (path !== undefined && args.isDirectory(path)) {
      configured.set(match[1]!, path);
    }
  }
  const locations: Array<{ label: string; path: string }> = [];
  for (const key of XDG_USER_DIRECTORY_KEYS) {
    const path = configured.get(key);
    if (path !== undefined) {
      locations.push({ label: basename(path), path });
    }
  }
  return locations;
}

function resolveXdgUserDirectoryValue(
  raw: string,
  home: string,
): string | undefined {
  let value = raw.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  value = value.replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  if (value === '$HOME' || value === '${HOME}') {
    return home;
  }
  if (value.startsWith('$HOME/')) {
    return join(home, value.slice('$HOME/'.length));
  }
  if (value.startsWith('${HOME}/')) {
    return join(home, value.slice('${HOME}/'.length));
  }
  return isAbsolute(value) ? value : undefined;
}

function parseWindowsDriveLocations(raw: string): WindowsDriveLocation[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Windows drive discovery did not return an array');
  }
  const found = new Map<string, WindowsDriveLocation>();
  for (const value of parsed) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const record = value as { path?: unknown; label?: unknown };
    if (typeof record.path !== 'string' || !win32.isAbsolute(record.path)) {
      continue;
    }
    const path = win32.normalize(record.path);
    if (!found.has(path.toLowerCase())) {
      found.set(path.toLowerCase(), {
        path,
        ...(typeof record.label === 'string' && record.label.trim().length > 0
          ? { label: record.label.trim() }
          : {}),
      });
    }
  }
  return [...found.values()].sort((left, right) =>
    left.path.localeCompare(right.path, 'en'),
  );
}

function formatWindowsDriveLabel(drive: WindowsDriveLocation): string {
  const coordinate = drive.path.replace(/[\\/]+$/u, '');
  return drive.label
    ? `${drive.label} (${coordinate})`
    : `Windows (${coordinate})`;
}

function collectWslDriveMounts(mountInfo: string): WindowsDriveMount[] {
  const found: WindowsDriveMount[] = [];
  for (const line of mountInfo.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const separator = fields.indexOf('-');
    if (separator < 6) {
      continue;
    }
    const fileSystem = fields[separator + 1]?.toLowerCase();
    const source = fields[separator + 2] ?? '';
    const superOptions = fields[separator + 3] ?? '';
    if (
      fileSystem !== 'drvfs' &&
      !(fileSystem === '9p' && superOptions.includes('aname=drvfs'))
    ) {
      continue;
    }
    const letter =
      /(?:^|[;,])path=([a-z]):/i.exec(superOptions)?.[1] ??
      /^([a-z]):/i.exec(source)?.[1];
    const mountPath = fields[4];
    if (letter !== undefined && mountPath !== undefined) {
      found.push({
        letter: letter.toUpperCase(),
        path: unescapeMountInfoField(mountPath),
      });
    }
  }
  return deduplicateDriveMounts(found);
}

function deduplicateDriveMounts(
  drives: readonly WindowsDriveMount[],
): WindowsDriveMount[] {
  const byLetter = new Map<string, WindowsDriveMount>();
  for (const drive of drives) {
    if (!byLetter.has(drive.letter)) {
      byLetter.set(drive.letter, drive);
    }
  }
  return [...byLetter.values()].sort((left, right) =>
    left.letter.localeCompare(right.letter, 'en'),
  );
}

function unescapeMountInfoField(value: string): string {
  const escapes: Record<string, string> = {
    '040': ' ',
    '011': '\t',
    '012': '\n',
    '134': '\\',
  };
  return value.replace(
    /\\(040|011|012|134)/g,
    (match, code: string) => escapes[code] ?? match,
  );
}

function findMatchingWindowsUserHome(args: {
  daemonHome: string;
  drives: readonly WindowsDriveMount[];
  isDirectory: (path: string) => boolean;
  listDirectory: (path: string) => string[];
  exists: (path: string) => boolean;
}): string | undefined {
  const currentUserName = basename(args.daemonHome).toLowerCase();
  for (const drive of args.drives) {
    const usersRoot = join(drive.path, 'Users');
    if (!args.isDirectory(usersRoot)) {
      continue;
    }
    const userHome = args
      .listDirectory(usersRoot)
      .filter((name) => !WINDOWS_NON_USER_PROFILES.has(name))
      .filter((name) => name.toLowerCase() === currentUserName)
      .map((name) => join(usersRoot, name))
      .find(
        (candidate) =>
          args.isDirectory(candidate) &&
          args.exists(join(candidate, 'NTUSER.DAT')),
      );
    if (userHome !== undefined) {
      return userHome;
    }
  }
  return undefined;
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

function defaultReadMountInfo(): string {
  try {
    return readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return '';
  }
}

function defaultReadWindowsDriveInfo(args: {
  policy: ComputerSessionDiscoveryCommandPolicy;
  runDiscoveryCommand: ComputerSessionDiscoveryCommandRunner;
}): string {
  return runWindowsPowerShellDiscovery(
    'powershell.exe',
    WINDOWS_DRIVE_DISCOVERY_SCRIPT,
    args,
  );
}

function defaultReadWindowsKnownFolderInfo(
  powershellExecutable: string,
  args: {
    policy: ComputerSessionDiscoveryCommandPolicy;
    runDiscoveryCommand: ComputerSessionDiscoveryCommandRunner;
  },
): string {
  return runWindowsPowerShellDiscovery(
    powershellExecutable,
    WINDOWS_KNOWN_FOLDER_DISCOVERY_SCRIPT,
    args,
  );
}

function defaultReadMacBrowseLocationInfo(args: {
  policy: ComputerSessionDiscoveryCommandPolicy;
  runDiscoveryCommand: ComputerSessionDiscoveryCommandRunner;
}): string {
  const result = args.runDiscoveryCommand({
    executable: '/usr/bin/osascript',
    args: ['-l', 'JavaScript', '-e', MACOS_BROWSE_LOCATION_DISCOVERY_SCRIPT],
    windowsHide: false,
    ...args.policy,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('macOS browse-location discovery command failed');
  }
  return result.stdout;
}

function runWindowsPowerShellDiscovery(
  powershellExecutable: string,
  script: string,
  args: {
    policy: ComputerSessionDiscoveryCommandPolicy;
    runDiscoveryCommand: ComputerSessionDiscoveryCommandRunner;
  },
): string {
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const result = args.runDiscoveryCommand({
    executable: powershellExecutable,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedCommand,
    ],
    windowsHide: true,
    ...args.policy,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('Windows PowerShell discovery command failed');
  }
  return result.stdout;
}

function resolveComputerSessionDiscoveryCommandPolicy(
  environment: NodeJS.ProcessEnv,
): ComputerSessionDiscoveryCommandPolicy {
  return {
    timeoutMs: readPositiveIntegerEnvironmentValue({
      environment,
      name: COMPUTER_SESSION_DISCOVERY_TIMEOUT_MS_ENV,
      fallback: DEFAULT_COMPUTER_SESSION_DISCOVERY_TIMEOUT_MS,
    }),
    maxBufferBytes: readPositiveIntegerEnvironmentValue({
      environment,
      name: COMPUTER_SESSION_DISCOVERY_MAX_BUFFER_BYTES_ENV,
      fallback: DEFAULT_COMPUTER_SESSION_DISCOVERY_MAX_BUFFER_BYTES,
    }),
  };
}

function readPositiveIntegerEnvironmentValue(args: {
  environment: NodeJS.ProcessEnv;
  name: string;
  fallback: number;
}): number {
  const raw = args.environment[args.name]?.trim();
  if (raw === undefined || raw === '') {
    return args.fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    logger.warn(
      `${args.name} must be a positive safe integer; using ${args.fallback}`,
    );
    return args.fallback;
  }
  return value;
}

function refuseCommandBackedDiscovery(
  invocation: ComputerSessionDiscoveryCommandInvocation,
): ComputerSessionDiscoveryCommandResult {
  // P7.6 item 4 — 이 동기 경로는 명령을 실행하지 않는다. 발견 명령은 데몬의 자식이
  // 아니라 command-host 세션에서 돌아야 하고(비동기), 그 배선은 조립이 소유한다.
  // 기본값이 자식을 낳을 수 있으면 주입을 잊은 호출자가 데몬 안에 조용히 자식을
  // 되돌려 놓는다 — 그래서 여기서는 거절만 하고, 결과는 명령 없는 기본값이 된다.
  return {
    error: new Error(
      `${invocation.executable} discovery requires the async command-backed pass`,
    ),
    status: null,
    stdout: '',
  };
}

function defaultReadXdgUserDirectories(
  home: string,
  environment: NodeJS.ProcessEnv,
): string {
  const configuredRoot = environment['XDG_CONFIG_HOME']?.trim();
  const configPath = join(
    configuredRoot && isAbsolute(configuredRoot)
      ? configuredRoot
      : join(home, '.config'),
    'user-dirs.dirs',
  );
  if (!existsSync(configPath)) {
    return '';
  }
  try {
    return readFileSync(configPath, 'utf8');
  } catch {
    logger.warn('XDG user-directory discovery failed');
    return '';
  }
}
