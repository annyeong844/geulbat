import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { ensureShellAccessToken } from './shell-access-token.js';

async function createStateRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'geulbat-shell-token-'));
}

function tokenPathIn(stateRoot: string): string {
  return join(stateRoot, '.geulbat', 'shell-access-token');
}

void test('a first launch generates and stores a token the user never types', async () => {
  const stateRoot = await createStateRoot();
  try {
    const token = ensureShellAccessToken({
      tokenPath: tokenPathIn(stateRoot),
      env: {},
    });

    assert.ok(token.length >= 16);
    const stored = await readFile(tokenPathIn(stateRoot), 'utf8');
    assert.equal(stored.trim(), token);
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

void test('the stored token is not readable by other users', async () => {
  const stateRoot = await createStateRoot();
  try {
    ensureShellAccessToken({ tokenPath: tokenPathIn(stateRoot), env: {} });

    const stats = await stat(tokenPathIn(stateRoot));
    // 로컬 공유 비밀이므로 같은 머신의 다른 사용자가 읽을 수 없어야 한다.
    assert.equal(stats.mode & 0o077, 0);
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

void test('a second launch reuses the stored token so open sessions survive', async () => {
  const stateRoot = await createStateRoot();
  try {
    const first = ensureShellAccessToken({
      tokenPath: tokenPathIn(stateRoot),
      env: {},
    });
    const second = ensureShellAccessToken({
      tokenPath: tokenPathIn(stateRoot),
      env: {},
    });

    assert.equal(second, first);
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

void test('an operator-provided token wins over the stored one', async () => {
  const stateRoot = await createStateRoot();
  try {
    ensureShellAccessToken({ tokenPath: tokenPathIn(stateRoot), env: {} });
    const configured = ensureShellAccessToken({
      tokenPath: tokenPathIn(stateRoot),
      env: { GEULBAT_DEV_TOKEN: 'operator-provided-token-value' },
    });

    // 배포 플랫폼이 주입한 값이 파일보다 최신 의도다.
    assert.equal(configured, 'operator-provided-token-value');
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

void test('a too-short token is refused instead of silently accepted', async () => {
  const stateRoot = await createStateRoot();
  try {
    assert.throws(
      () =>
        ensureShellAccessToken({
          tokenPath: tokenPathIn(stateRoot),
          env: { GEULBAT_DEV_TOKEN: 'short' },
        }),
      /at least 16 characters/,
    );
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

void test('a blank stored token is replaced rather than used', async () => {
  const stateRoot = await createStateRoot();
  const tokenPath = tokenPathIn(stateRoot);
  try {
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, '\n', 'utf8');

    // 빈 파일을 토큰으로 받아들이면 인증이 조용히 무력해진다.
    assert.throws(() =>
      ensureShellAccessToken({ tokenPath: tokenPathIn(stateRoot), env: {} }),
    );
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});
