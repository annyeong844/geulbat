import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadDaemonLocalEnv } from './env-local.js';

void test('loadDaemonLocalEnv keeps explicit env over file values', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'geulbat-env-local-'));
  const envFile = join(tempRoot, '.env.local');
  const previous = process.env['PROVIDER_AUTH_CLIENT_ID'];
  process.env['PROVIDER_AUTH_CLIENT_ID'] = 'explicit-client-id';
  await writeFile(envFile, 'PROVIDER_AUTH_CLIENT_ID=file-client-id\n', 'utf8');

  try {
    await loadDaemonLocalEnv({ candidateFiles: [envFile] });
    assert.equal(process.env['PROVIDER_AUTH_CLIENT_ID'], 'explicit-client-id');
  } finally {
    restoreEnv('PROVIDER_AUTH_CLIENT_ID', previous);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

void test('loadDaemonLocalEnv prefers app env over repo env', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'geulbat-env-local-'));
  const appEnvFile = join(tempRoot, 'app.env.local');
  const repoEnvFile = join(tempRoot, 'repo.env.local');
  const previous = process.env['PROVIDER_AUTH_CLIENT_ID'];
  delete process.env['PROVIDER_AUTH_CLIENT_ID'];
  await writeFile(
    appEnvFile,
    'PROVIDER_AUTH_CLIENT_ID=app-client-id\n',
    'utf8',
  );
  await writeFile(
    repoEnvFile,
    'PROVIDER_AUTH_CLIENT_ID=repo-client-id\n',
    'utf8',
  );

  try {
    await loadDaemonLocalEnv({ candidateFiles: [appEnvFile, repoEnvFile] });
    assert.equal(process.env['PROVIDER_AUTH_CLIENT_ID'], 'app-client-id');
  } finally {
    restoreEnv('PROVIDER_AUTH_CLIENT_ID', previous);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

void test('loadDaemonLocalEnv falls back to repo env when app env is absent', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'geulbat-env-local-'));
  const repoEnvFile = join(tempRoot, 'repo.env.local');
  const previous = process.env['PROVIDER_AUTH_CLIENT_ID'];
  delete process.env['PROVIDER_AUTH_CLIENT_ID'];
  await writeFile(
    repoEnvFile,
    'PROVIDER_AUTH_CLIENT_ID="repo-client-id"\n',
    'utf8',
  );

  try {
    await loadDaemonLocalEnv({
      candidateFiles: [join(tempRoot, 'missing.env.local'), repoEnvFile],
    });
    assert.equal(process.env['PROVIDER_AUTH_CLIENT_ID'], 'repo-client-id');
  } finally {
    restoreEnv('PROVIDER_AUTH_CLIENT_ID', previous);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

void test('loadDaemonLocalEnv unescapes double-quoted escape sequences', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'geulbat-env-local-'));
  const envFile = join(tempRoot, '.env.local');
  const previousMultiline = process.env['PROVIDER_AUTH_CLIENT_ID'];
  const previousTab = process.env['GEULBAT_TEST_TAB'];
  const previousLiteral = process.env['GEULBAT_TEST_LITERAL'];
  delete process.env['PROVIDER_AUTH_CLIENT_ID'];
  delete process.env['GEULBAT_TEST_TAB'];
  delete process.env['GEULBAT_TEST_LITERAL'];
  await writeFile(
    envFile,
    [
      'PROVIDER_AUTH_CLIENT_ID="line-1\\nline-2"',
      'GEULBAT_TEST_TAB="a\\tb"',
      "GEULBAT_TEST_LITERAL='keep\\\\nliteral'",
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    await loadDaemonLocalEnv({ candidateFiles: [envFile] });
    assert.equal(process.env['PROVIDER_AUTH_CLIENT_ID'], 'line-1\nline-2');
    assert.equal(process.env['GEULBAT_TEST_TAB'], 'a\tb');
    assert.equal(process.env['GEULBAT_TEST_LITERAL'], 'keep\\\\nliteral');
  } finally {
    restoreEnv('PROVIDER_AUTH_CLIENT_ID', previousMultiline);
    restoreEnv('GEULBAT_TEST_TAB', previousTab);
    restoreEnv('GEULBAT_TEST_LITERAL', previousLiteral);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}
