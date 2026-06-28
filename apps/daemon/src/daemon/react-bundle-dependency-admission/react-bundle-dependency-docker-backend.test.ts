import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ReactBundleDependencyNetworkProbeCandidate } from './react-bundle-dependency-network-probe-candidate.js';
import {
  buildDockerMetadataProbeRunArgs,
  checkDockerMetadataProbeBackendAvailable,
  runDockerCommand,
  runDockerMetadataProbeProcess,
  type DockerCommandInvocation,
  type DockerMetadataProbeCommandInvocation,
} from './react-bundle-dependency-docker-backend.js';

const CANDIDATE: ReactBundleDependencyNetworkProbeCandidate = {
  schemaVersion: 1,
  adapterKind: 'react_bundle_dependency_metadata_probe',
  inputHash: 'input-hash',
  probeMode: 'metadata',
  networkPolicy: 'allowlisted_metadata_probe',
  networkPolicyVersion: 1,
  allowlistId: 'react_bundle_dependency_cdn_v1',
  generatedAt: '2026-05-22T00:00:00.000Z',
  dependencyProbes: [],
  failures: [],
};

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'geulbat-docker-backend-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test('buildDockerMetadataProbeRunArgs uses daemon-owned mounts and network none', () => {
  const args = buildDockerMetadataProbeRunArgs({
    imageRef: 'local/geulbat-metadata-probe:2026-05-22',
    inputDir: '/sandbox/in',
    outputDir: '/sandbox/out',
  });

  assert.deepEqual(args.slice(0, 2), ['run', '--rm']);
  assert.equal(args.includes('--pull'), true);
  assert.equal(args[args.indexOf('--pull') + 1], 'never');
  assert.equal(args.includes('--network'), true);
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args.includes('--cpus'), false);
  assert.equal(args.includes('--memory'), false);
  assert.equal(args.includes('--pids-limit'), false);
  assert.equal(
    args.includes('GEULBAT_REACT_BUNDLE_DEPENDENCY_METADATA_PROBE=1'),
    true,
  );
  assert.equal(
    args.includes('GEULBAT_PROBE_NETWORK_POLICY=allowlisted_metadata_probe'),
    true,
  );
  assert.equal(args.includes('GEULBAT_CONTAINER_NETWORK_MODE=none'), true);
  assert.equal(args.includes('-v'), true);
  assert.equal(
    args.some((item) => item.includes('/sandbox/in:/geulbat/input:ro')),
    true,
  );
  assert.equal(
    args.some((item) => item.includes('/sandbox/out:/geulbat/output')),
    true,
  );
  assert.equal(args.includes('/var/run/docker.sock'), false);
  assert.equal(
    args.some((item) => item.includes('/mnt/c')),
    false,
  );
});

void test('checkDockerMetadataProbeBackendAvailable reports docker absence visibly', async () => {
  await withTempRoot(async () => {
    const invocations: DockerCommandInvocation[] = [];
    const result = await checkDockerMetadataProbeBackendAvailable({
      dockerPath: 'docker',
      timeoutMs: 1000,
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        return {
          kind: 'exit',
          exitCode: 127,
          stdout: '',
          stderr: 'docker: command not found',
        };
      },
    });

    assert.equal(result.kind, 'crash');
    assert.match(result.stderr, /docker_unavailable/u);
    assert.deepEqual(invocations[0]?.args, ['--version']);
  });
});

void test('checkDockerMetadataProbeBackendAvailable checks the local image when provided', async () => {
  await withTempRoot(async () => {
    const invocations: DockerCommandInvocation[] = [];
    const result = await checkDockerMetadataProbeBackendAvailable({
      dockerPath: 'docker',
      imageRef: 'local/geulbat-metadata-probe:2026-05-22',
      timeoutMs: 1000,
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        if (invocation.args[0] === '--version') {
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: 'Docker version 27.0.0',
            stderr: '',
          };
        }
        return {
          kind: 'exit',
          exitCode: 1,
          stdout: '',
          stderr: 'No such image',
        };
      },
    });

    assert.equal(result.kind, 'crash');
    assert.match(result.stderr, /docker_unavailable/u);
    assert.match(result.stderr, /No such image/u);
    assert.deepEqual(
      invocations.map((invocation) => invocation.args),
      [
        ['--version'],
        ['image', 'inspect', 'local/geulbat-metadata-probe:2026-05-22'],
      ],
    );
  });
});

void test('checkDockerMetadataProbeBackendAvailable does not clamp explicit timeout to a hidden short slice', async () => {
  await withTempRoot(async () => {
    const timeoutMs = 20_000;
    const invocations: DockerCommandInvocation[] = [];
    const result = await checkDockerMetadataProbeBackendAvailable({
      dockerPath: 'docker',
      imageRef: 'local/geulbat-metadata-probe:2026-05-22',
      timeoutMs,
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
        };
      },
    });

    assert.equal(result.kind, 'exit');
    assert.equal(result.exitCode, 0);
    assert.equal(invocations.length, 2);
    const versionInvocation = invocations[0];
    const imageInvocation = invocations[1];
    if (versionInvocation === undefined || imageInvocation === undefined) {
      assert.fail('expected version and image inspect invocations');
    }
    assert.equal(versionInvocation.timeoutMs, timeoutMs);
    if (imageInvocation.timeoutMs === undefined) {
      assert.fail('expected image inspect invocation to keep explicit timeout');
    }
    assert.equal(imageInvocation.timeoutMs > timeoutMs / 2, true);
  });
});

void test('checkDockerMetadataProbeBackendAvailable reports explicit timeout exhaustion without inventing a retry slice', async () => {
  const invocations: DockerCommandInvocation[] = [];
  const result = await checkDockerMetadataProbeBackendAvailable({
    dockerPath: 'docker',
    imageRef: 'local/geulbat-metadata-probe:2026-05-22',
    timeoutMs: 0,
    commandRunner: async (invocation) => {
      invocations.push(invocation);
      return {
        kind: 'exit',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
      };
    },
  });

  assert.equal(result.kind, 'timeout');
  assert.match(result.stderr, /explicit timeout window elapsed/u);
  assert.equal(invocations.length, 0);
});

void test('checkDockerMetadataProbeBackendAvailable preserves cancellation status', async () => {
  const result = await checkDockerMetadataProbeBackendAvailable({
    dockerPath: 'docker',
    timeoutMs: 1000,
    commandRunner: async () => ({
      kind: 'cancelled',
      stdout: '',
      stderr: 'cancelled by caller',
    }),
  });

  assert.equal(result.kind, 'cancelled');
  assert.equal(result.stderr, 'cancelled by caller');
});

void test('runDockerMetadataProbeProcess writes candidate input and accepts docker-written output', async () => {
  await withTempRoot(async (root) => {
    const outputDir = join(root, 'out');
    const invocations: DockerMetadataProbeCommandInvocation[] = [];
    const result = await runDockerMetadataProbeProcess({
      dockerPath: 'docker',
      imageRef: 'local/geulbat-metadata-probe:2026-05-22',
      rootPath: root,
      outputDir,
      candidate: CANDIDATE,
      timeoutMs: 1000,
      commandRunner: async (invocation) => {
        invocations.push(invocation);
        if (invocation.args[0] === '--version') {
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: 'Docker version 27.0.0',
            stderr: '',
          };
        }
        if (invocation.args[0] === 'image') {
          return {
            kind: 'exit',
            exitCode: 0,
            stdout: '[]',
            stderr: '',
          };
        }
        const inputText = await readFile(
          join(root, 'docker-input', 'candidate.json'),
          'utf8',
        );
        await assert.rejects(
          () => invocation.writeOutput('../escape.json', '{}'),
          /unexpected docker output path/u,
        );
        await invocation.writeOutput('candidate.json', inputText);
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'docker metadata probe ok',
          stderr: '',
        };
      },
    });

    assert.equal(result.kind, 'exit');
    assert.equal(result.exitCode, 0);
    assert.equal(invocations.length, 3);
    assert.equal(invocations[2]?.args.includes('--network'), true);
    assert.equal(
      invocations[2]?.args.some((item) =>
        item.includes(`${join(root, 'docker-input')}:/geulbat/input:ro`),
      ),
      true,
    );
    assert.equal(
      invocations[2]?.args.some((item) =>
        item.includes(`${outputDir}:/geulbat/output`),
      ),
      true,
    );
    assert.equal(
      await readFile(join(outputDir, 'candidate.json'), 'utf8'),
      JSON.stringify(CANDIDATE, null, 2) + '\n',
    );
  });
});

void test('runDockerCommand waits for timeout termination before returning', async () => {
  const result = await runDockerCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 20,
  });

  assert.equal(result.kind, 'timeout');
});

void test('runDockerCommand preserves large stdout and stderr', async () => {
  const result = await runDockerCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.stdout.write("o".repeat(80 * 1024)); process.stderr.write("e".repeat(80 * 1024));',
    ],
    timeoutMs: 1000,
  });

  assert.equal(result.kind, 'exit');
  assert.equal(Buffer.byteLength(result.stdout, 'utf8'), 80 * 1024);
  assert.equal(Buffer.byteLength(result.stderr, 'utf8'), 80 * 1024);
  assert.doesNotMatch(result.stdout, /\[truncated\]/u);
  assert.doesNotMatch(result.stderr, /\[truncated\]/u);
});

void test('runDockerCommand waits for cancellation termination before returning', async () => {
  const controller = new AbortController();
  const resultPromise = runDockerCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 5_000,
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 20);

  const result = await resultPromise;
  assert.equal(result.kind, 'cancelled');
});

void test('runDockerCommand preserves Docker client environment without inheriting unrelated env', async () => {
  const previousDockerHost = process.env.DOCKER_HOST;
  const previousDockerContext = process.env.DOCKER_CONTEXT;
  const previousDockerConfig = process.env.DOCKER_CONFIG;
  const previousDockerTlsVerify = process.env.DOCKER_TLS_VERIFY;
  const previousGeulbatSecret = process.env.GEULBAT_TEST_SECRET;
  try {
    process.env.DOCKER_HOST = 'tcp://docker.example.test:2376';
    process.env.DOCKER_CONTEXT = 'remote-context';
    process.env.DOCKER_CONFIG = '/tmp/docker-config';
    process.env.DOCKER_TLS_VERIFY = '1';
    process.env.GEULBAT_TEST_SECRET = 'do-not-inherit';

    const result = await runDockerCommand({
      executable: process.execPath,
      args: [
        '-e',
        [
          'console.log(JSON.stringify({',
          'PATH: process.env.PATH,',
          'DOCKER_HOST: process.env.DOCKER_HOST,',
          'DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,',
          'DOCKER_CONFIG: process.env.DOCKER_CONFIG,',
          'DOCKER_TLS_VERIFY: process.env.DOCKER_TLS_VERIFY,',
          'GEULBAT_TEST_SECRET: process.env.GEULBAT_TEST_SECRET',
          '}));',
        ].join(''),
      ],
      timeoutMs: 1000,
    });

    assert.equal(result.kind, 'exit');
    if (result.kind === 'exit') {
      assert.equal(result.exitCode, 0);
    }
    const env = JSON.parse(result.stdout) as Record<string, string | undefined>;
    assert.equal(env.DOCKER_HOST, 'tcp://docker.example.test:2376');
    assert.equal(env.DOCKER_CONTEXT, 'remote-context');
    assert.equal(env.DOCKER_CONFIG, '/tmp/docker-config');
    assert.equal(env.DOCKER_TLS_VERIFY, '1');
    assert.equal(env.GEULBAT_TEST_SECRET, undefined);
    assert.equal(typeof env.PATH, 'string');
  } finally {
    restoreEnv('DOCKER_HOST', previousDockerHost);
    restoreEnv('DOCKER_CONTEXT', previousDockerContext);
    restoreEnv('DOCKER_CONFIG', previousDockerConfig);
    restoreEnv('DOCKER_TLS_VERIFY', previousDockerTlsVerify);
    restoreEnv('GEULBAT_TEST_SECRET', previousGeulbatSecret);
  }
});

void test('runDockerCommand rechecks abort after registering the listener', async () => {
  const controller = new AbortController();
  const originalAddEventListener = controller.signal.addEventListener.bind(
    controller.signal,
  );
  const signal = controller.signal as AbortSignal & {
    addEventListener: AbortSignal['addEventListener'];
  };
  signal.addEventListener = (type, listener, options): void => {
    if (type === 'abort') {
      controller.abort();
    }
    originalAddEventListener(type, listener, options);
  };

  const result = await runDockerCommand({
    executable: process.execPath,
    args: [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
    ],
    timeoutMs: 50,
    signal,
  });

  assert.equal(result.kind, 'cancelled');
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
