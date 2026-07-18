import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_MAX_MS,
  PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_MAX_PACKAGES,
  PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_STDERR_BYTES,
  PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_STDOUT_BYTES,
  PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_TMPFS_SIZE,
  PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV,
  PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_MS_ENV,
  PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_PACKAGES_ENV,
  PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDERR_BYTES_ENV,
  PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDOUT_BYTES_ENV,
  PTC_EXECUTE_CODE_PACKAGE_INSTALL_TMPFS_SIZE_ENV,
  resolvePtcExecuteCodePackageInstallConfigFromEnv,
} from './execute-code-package-install-config.js';

void test('package install config stays absent when no env is set', () => {
  assert.equal(resolvePtcExecuteCodePackageInstallConfigFromEnv({}), undefined);
});

void test('package install config rejects limit knobs without the enable knob', () => {
  assert.throws(() =>
    resolvePtcExecuteCodePackageInstallConfigFromEnv({
      [PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_MS_ENV]: '1000',
    }),
  );
  assert.throws(() =>
    resolvePtcExecuteCodePackageInstallConfigFromEnv({
      [PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV]: 'false',
      [PTC_EXECUTE_CODE_PACKAGE_INSTALL_TMPFS_SIZE_ENV]: '512m',
    }),
  );
});

void test('package install config resolves generous defaults when enabled', () => {
  const config = resolvePtcExecuteCodePackageInstallConfigFromEnv({
    [PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV]: 'true',
  });
  assert.deepEqual(config, {
    enabled: true,
    maxInstallMs: PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_MAX_MS,
    maxPackages: PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_MAX_PACKAGES,
    tmpTmpfsSize: PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_TMPFS_SIZE,
    maxStdoutBytes: PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_STDOUT_BYTES,
    maxStderrBytes: PTC_EXECUTE_CODE_PACKAGE_INSTALL_DEFAULT_STDERR_BYTES,
  });
});

void test('package install config accepts explicit knob overrides', () => {
  const config = resolvePtcExecuteCodePackageInstallConfigFromEnv({
    [PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV]: '1',
    [PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_MS_ENV]: '1800000',
    [PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_PACKAGES_ENV]: '64',
    [PTC_EXECUTE_CODE_PACKAGE_INSTALL_TMPFS_SIZE_ENV]: '1g',
    [PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDOUT_BYTES_ENV]: '1048576',
    [PTC_EXECUTE_CODE_PACKAGE_INSTALL_STDERR_BYTES_ENV]: '2097152',
  });
  assert.deepEqual(config, {
    enabled: true,
    maxInstallMs: 1_800_000,
    maxPackages: 64,
    tmpTmpfsSize: '1g',
    maxStdoutBytes: 1_048_576,
    maxStderrBytes: 2_097_152,
  });
});

void test('package install config rejects invalid knob values instead of silently tightening', () => {
  for (const invalid of ['0', '-5', 'abc', '1.5', '']) {
    assert.throws(() =>
      resolvePtcExecuteCodePackageInstallConfigFromEnv({
        [PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV]: 'true',
        [PTC_EXECUTE_CODE_PACKAGE_INSTALL_MAX_MS_ENV]: invalid,
      }),
    );
  }
  for (const invalid of ['0m', 'lots', '512', '']) {
    assert.throws(() =>
      resolvePtcExecuteCodePackageInstallConfigFromEnv({
        [PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV]: 'true',
        [PTC_EXECUTE_CODE_PACKAGE_INSTALL_TMPFS_SIZE_ENV]: invalid,
      }),
    );
  }
  assert.throws(() =>
    resolvePtcExecuteCodePackageInstallConfigFromEnv({
      [PTC_EXECUTE_CODE_PACKAGE_INSTALL_ENABLED_ENV]: 'maybe',
    }),
  );
});
