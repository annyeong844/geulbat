import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

interface HomeStateRootResolutionInput {
  env: Readonly<NodeJS.ProcessEnv>;
  homeDirectory: string | undefined;
  platform: NodeJS.Platform;
}

export function resolveHomeStateRoot(
  input: HomeStateRootResolutionInput = {
    env: process.env,
    homeDirectory: homedir(),
    platform: process.platform,
  },
): string {
  const pathModule = input.platform === 'win32' ? win32 : posix;
  const configuredRoot = resolveAbsolutePath(
    pathModule,
    input.env['GEULBAT_HOME_STATE_ROOT'],
    'GEULBAT_HOME_STATE_ROOT',
  );
  if (configuredRoot !== undefined) {
    return configuredRoot;
  }

  if (input.platform === 'win32') {
    const localAppData = resolveAbsolutePath(
      pathModule,
      input.env['LOCALAPPDATA'],
      'LOCALAPPDATA',
    );
    if (localAppData !== undefined) {
      return pathModule.join(localAppData, 'Geulbat');
    }
    return pathModule.join(
      requireHomeDirectory(pathModule, input.homeDirectory),
      'AppData',
      'Local',
      'Geulbat',
    );
  }

  if (input.platform === 'darwin') {
    return pathModule.join(
      requireHomeDirectory(pathModule, input.homeDirectory),
      'Library',
      'Application Support',
      'Geulbat',
    );
  }

  const xdgStateHome = resolveAbsolutePath(
    pathModule,
    input.env['XDG_STATE_HOME'],
    'XDG_STATE_HOME',
  );
  if (xdgStateHome !== undefined) {
    return pathModule.join(xdgStateHome, 'geulbat');
  }
  return pathModule.join(
    requireHomeDirectory(pathModule, input.homeDirectory),
    '.local',
    'state',
    'geulbat',
  );
}

/**
 * 프로세스가 치명적으로 종료할 때 그 소유자를 남기는 곳. 죽음은 워크스페이스
 * 하나의 사건이 아니므로(데몬은 여러 워크스페이스를 서빙한다) Home state root에
 * 둔다.
 */
export function daemonFatalRecordPath(): string {
  return join(resolveHomeStateRoot(), 'daemon-fatal.jsonl');
}

/**
 * web shell 접속 토큰이 사는 곳. 워크스페이스가 아니라 Home state root에 두는
 * 이유는 데몬 하나가 여러 워크스페이스를 서빙하고, 토큰은 그 데몬의 것이기
 * 때문이다. 소스 체크아웃 안에 두면 설치된 배포에는 그 디렉터리가 없다.
 */
export function shellAccessTokenPath(): string {
  return join(resolveHomeStateRoot(), '.geulbat', 'shell-access-token');
}

function requireHomeDirectory(
  pathModule: typeof posix,
  homeDirectory: string | undefined,
): string {
  const resolvedHome = resolveAbsolutePath(
    pathModule,
    homeDirectory,
    'OS user home directory',
  );
  if (resolvedHome === undefined) {
    throw new Error(
      'Cannot resolve the Geulbat Home state root: no usable OS user home directory is available.',
    );
  }
  return resolvedHome;
}

function resolveAbsolutePath(
  pathModule: typeof posix,
  value: string | undefined,
  source: string,
): string | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === '') {
    return undefined;
  }
  if (!pathModule.isAbsolute(normalized)) {
    throw new Error(`${source} must be an absolute path.`);
  }
  return pathModule.resolve(normalized);
}
