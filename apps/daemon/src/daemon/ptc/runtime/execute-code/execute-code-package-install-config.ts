import { PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM } from '../../lab/profile/lab-profile-contract.js';

export const PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV =
  'GEULBAT_PTC_PACKAGE_INSTALL_ENABLED' as const;
export const PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_MS_ENV =
  'GEULBAT_PTC_PACKAGE_INSTALL_MAX_MS' as const;
export const PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_PACKAGES_ENV =
  'GEULBAT_PTC_PACKAGE_INSTALL_MAX_PACKAGES' as const;
export const PTC_EXECUTE_CODE_PACKAGE_INSTALL_TMPFS_SIZE_ENV =
  'GEULBAT_PTC_PACKAGE_INSTALL_TMPFS_SIZE' as const;
export const PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDOUT_BYTES_ENV =
  'GEULBAT_PTC_PACKAGE_INSTALL_STDOUT_BYTES' as const;
export const PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDERR_BYTES_ENV =
  'GEULBAT_PTC_PACKAGE_INSTALL_STDERR_BYTES' as const;

// Overridable generous defaults, not product caps: slow live installs are
// awaited, not cut, and every limit stays operator-tunable via env.
export const PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_MAX_MS = 900_000;
export const PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_MAX_PACKAGES = 32;
export const PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_TMPFS_SIZE =
  '512m' as const;
export const PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_STDOUT_BYTES =
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM;
export const PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_STDERR_BYTES =
  PTC_LAB_LOCAL_DOCKER_BATCH_COMMAND_MAX_BUFFERED_BYTES_PER_STREAM;

type PtcExecuteCodePackageInstallEnvName =
  | typeof PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV
  | typeof PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_MS_ENV
  | typeof PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_PACKAGES_ENV
  | typeof PTC_EXECUTE_CODE_PACKAGE_INSTALL_TMPFS_SIZE_ENV
  | typeof PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDOUT_BYTES_ENV
  | typeof PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDERR_BYTES_ENV;

type PtcExecuteCodePackageInstallEnv = Readonly<
  Partial<Record<PtcExecuteCodePackageInstallEnvName, string | undefined>>
>;

export type PtcExecuteCodePackageInstallRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      maxInstallMs: number;
      maxPackages: number;
      tmpTmpfsSize: string;
      maxStdoutBytes: number;
      maxStderrBytes: number;
    };

export function resolvePtcExecuteCodePackageInstallConfigFromEnv(
  env: PtcExecuteCodePackageInstallEnv = process.env,
): PtcExecuteCodePackageInstallRuntimeConfig | undefined {
  const enabledRaw = env[PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV];
  const limitNames: PtcExecuteCodePackageInstallEnvName[] = [
    PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_MS_ENV,
    PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_PACKAGES_ENV,
    PTC_EXECUTE_CODE_PACKAGE_INSTALL_TMPFS_SIZE_ENV,
    PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDOUT_BYTES_ENV,
    PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDERR_BYTES_ENV,
  ];
  const hasLimitSettings = limitNames.some((name) => env[name] !== undefined);
  if (enabledRaw === undefined) {
    if (hasLimitSettings) {
      throw new Error(
        `PTC package install settings require ${PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV}=true`,
      );
    }
    return undefined;
  }

  const enabled = readPackageInstallBooleanEnv(
    PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV,
    enabledRaw,
  );
  if (!enabled) {
    if (hasLimitSettings) {
      throw new Error(
        `PTC package install settings require ${PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV}=true`,
      );
    }
    return Object.freeze({ enabled: false });
  }

  return Object.freeze({
    enabled: true,
    maxInstallMs: readPackageInstallIntegerEnv(
      PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_MS_ENV,
      env[PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_MS_ENV],
      PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_MAX_MS,
    ),
    maxPackages: readPackageInstallIntegerEnv(
      PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_PACKAGES_ENV,
      env[PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_PACKAGES_ENV],
      PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_MAX_PACKAGES,
    ),
    tmpTmpfsSize: readPackageInstallTmpfsSizeEnv(
      PTC_EXECUTE_CODE_PACKAGE_INSTALL_TMPFS_SIZE_ENV,
      env[PTC_EXECUTE_CODE_PACKAGE_INSTALL_TMPFS_SIZE_ENV],
      PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_TMPFS_SIZE,
    ),
    maxStdoutBytes: readPackageInstallIntegerEnv(
      PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDOUT_BYTES_ENV,
      env[PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDOUT_BYTES_ENV],
      PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_STDOUT_BYTES,
    ),
    maxStderrBytes: readPackageInstallIntegerEnv(
      PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDERR_BYTES_ENV,
      env[PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDERR_BYTES_ENV],
      PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_STDERR_BYTES,
    ),
  });
}

function readPackageInstallBooleanEnv(name: string, raw: string): boolean {
  const value = raw.trim();
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  throw new Error(`invalid ${name}: ${value || 'empty'}`);
}

function readPackageInstallIntegerEnv(
  name: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined) {
    return defaultValue;
  }
  const value = raw.trim();
  if (!/^\d+$/u.test(value)) {
    throw new Error(`invalid ${name}: ${value || 'empty'}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return parsed;
}

function readPackageInstallTmpfsSizeEnv(
  name: string,
  raw: string | undefined,
  defaultValue: string,
): string {
  if (raw === undefined) {
    return defaultValue;
  }
  const value = raw.trim();
  if (!/^[1-9]\d*[kmg]$/iu.test(value)) {
    throw new Error(`invalid ${name}: ${value || 'empty'}`);
  }
  return value;
}
