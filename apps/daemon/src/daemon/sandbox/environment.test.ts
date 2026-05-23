import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSandboxEnvironment } from './environment.js';

void test('buildSandboxEnvironment starts from a minimal credential-free env', () => {
  const env = buildSandboxEnvironment({
    homeDir: '/tmp/geulbat-sandbox/home',
    tempDir: '/tmp/geulbat-sandbox/tmp',
    inheritedEnv: {
      PATH: '/usr/bin',
      HOME: '/tmp/inherited-home',
      GITHUB_TOKEN: 'secret',
      OPENAI_API_KEY: 'secret',
      NPM_TOKEN: 'secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      PROVIDER_AUTH_CONFIG: '/private/provider.json',
    },
  });

  assert.equal(env.HOME, '/tmp/geulbat-sandbox/home');
  assert.equal(env.TMPDIR, '/tmp/geulbat-sandbox/tmp');
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.TZ, 'UTC');
  assert.equal(env.PATH, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.PROVIDER_AUTH_CONFIG, undefined);
});

void test('buildSandboxEnvironment includes only adapter-declared env vars', () => {
  const env = buildSandboxEnvironment({
    homeDir: '/tmp/home',
    tempDir: '/tmp/tmp',
    adapterEnv: {
      GEULBAT_PROBE_MODE: '1',
    },
  });

  assert.equal(env.GEULBAT_PROBE_MODE, '1');
});
