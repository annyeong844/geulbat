import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

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
