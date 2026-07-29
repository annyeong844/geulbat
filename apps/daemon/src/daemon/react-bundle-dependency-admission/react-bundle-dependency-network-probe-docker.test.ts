import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { HttpMetadataProbeRequestTransport } from '../network/http-metadata-probe.js';
import { createSandboxAttemptStore } from '../sandbox/attempt-store.js';
import type { ReactBundleDependencyNetworkProbeCandidate } from './react-bundle-dependency-network-probe-candidate.js';
import { probeReactBundleExplicitCdnDependencies } from './react-bundle-dependency-network-probe.js';
import type { ReactBundleDependencyPrepareRequest } from './react-bundle-dependency-prepare.js';

const BASE_REQUEST: ReactBundleDependencyPrepareRequest = {
  entryUrl: 'https://fixtures.geulbat.local/app.js',
  runtimeDependencies: {
    importMap: {
      imports: {
        'canvas-confetti': 'https://esm.sh/canvas-confetti@1.9.3',
      },
    },
    stylesheets: ['https://cdn.jsdelivr.net/npm/water.css@2.0.0/out/water.css'],
  },
  dependencyRefs: [
    {
      kind: 'esm_import',
      specifier: 'canvas-confetti',
      packageName: 'canvas-confetti',
      version: '1.9.3',
      provider: 'explicit_cdn',
      url: 'https://esm.sh/canvas-confetti@1.9.3',
    },
    {
      kind: 'stylesheet',
      packageName: 'water.css',
      version: '2.0.0',
      provider: 'explicit_cdn',
      url: 'https://cdn.jsdelivr.net/npm/water.css@2.0.0/out/water.css',
    },
  ],
};

async function withWorkspace<T>(
  fn: (workspaceRoot: string) => Promise<T>,
): Promise<T> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'geulbat-probe-'));
  try {
    return await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function transport(statuses: number[]): HttpMetadataProbeRequestTransport {
  let index = 0;
  return async (_url, options) => {
    const status = statuses[index++] ?? 200;
    return {
      status,
      location: null,
      contentType:
        options.method === 'HEAD' ? 'application/javascript' : 'text/plain',
      contentLength: 20,
      bytesRead: options.method === 'GET' ? 4 : 0,
    };
  };
}

void test('docker backend requires an explicit attempt timeout before availability checks', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-22T00:00:00.000Z',
    });
    let dockerCalls = 0;
    let transportCalls = 0;

    await assert.rejects(
      () =>
        probeReactBundleExplicitCdnDependencies({
          workspaceRoot,
          store,
          request: BASE_REQUEST,
          backend: {
            kind: 'docker_worker',
            imageRef: 'local/geulbat-metadata-probe:2026-05-22',
          },
          probeTransport: async () => {
            transportCalls += 1;
            return {
              status: 200,
              location: null,
              contentType: 'application/javascript',
              contentLength: 20,
              bytesRead: 0,
            };
          },
          dockerCommandRunner: async () => {
            dockerCalls += 1;
            return {
              kind: 'exit',
              exitCode: 0,
              stdout: 'Docker version 27.0.0',
              stderr: '',
            };
          },
        }),
      /docker probe requires explicit timeoutMs/u,
    );

    assert.equal(dockerCalls, 0);
    assert.equal(transportCalls, 0);
    const attempt = store.getAttempts().records[0];
    assert.equal(attempt?.status, 'crashed');
    assert.match(
      attempt?.diagnostics ?? '',
      /docker probe requires explicit timeoutMs/u,
    );
  });
});

void test('docker backend rejects output emitted by an availability command', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-22T00:00:00.000Z',
    });
    let dockerCalls = 0;

    await assert.rejects(
      () =>
        probeReactBundleExplicitCdnDependencies({
          workspaceRoot,
          store,
          request: BASE_REQUEST,
          timeoutMs: 1000,
          backend: {
            kind: 'docker_worker',
            imageRef: 'local/geulbat-metadata-probe:2026-05-22',
          },
          dockerCommandRunner: async (invocation) => {
            dockerCalls += 1;
            await invocation.writeOutput(
              'availability-output.json',
              '{"unexpected":true}',
            );
            return {
              kind: 'exit',
              exitCode: 0,
              stdout: 'Docker version 27.0.0',
              stderr: '',
            };
          },
        }),
      /unexpected docker output path: availability-output\.json/u,
    );

    assert.equal(dockerCalls, 1);
    const attempt = store.getAttempts().records[0];
    assert.equal(attempt?.status, 'failed');
    assert.equal(attempt?.outputRef, null);
    assert.equal(attempt?.diagnostics, 'sandbox_run_failed');
  });
});

void test('docker backend rejects a blank image reference before creating an attempt', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-22T00:00:00.000Z',
    });

    await assert.rejects(
      () =>
        probeReactBundleExplicitCdnDependencies({
          workspaceRoot,
          store,
          request: BASE_REQUEST,
          timeoutMs: 1000,
          backend: {
            kind: 'docker_worker',
            imageRef: '   ',
          },
        }),
      /docker metadata probe backend imageRef is required/u,
    );

    assert.equal(store.getAttempts().records.length, 0);
  });
});

void test('docker backend failure happens before metadata transport runs when docker is unavailable', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-22T00:00:00.000Z',
    });
    let transportCalls = 0;

    await assert.rejects(
      () =>
        probeReactBundleExplicitCdnDependencies({
          workspaceRoot,
          store,
          request: BASE_REQUEST,
          timeoutMs: 1000,
          backend: {
            kind: 'docker_worker',
            imageRef: 'local/geulbat-metadata-probe:2026-05-22',
          },
          probeTransport: async () => {
            transportCalls += 1;
            return {
              status: 200,
              location: null,
              contentType: 'application/javascript',
              contentLength: 20,
              bytesRead: 0,
            };
          },
          dockerCommandRunner: async () => ({
            kind: 'exit',
            exitCode: 127,
            stdout: '',
            stderr: 'docker: command not found',
          }),
        }),
      /docker_unavailable/,
    );

    assert.equal(transportCalls, 0);
    const attempt = store.getAttempts().records[0];
    assert.equal(attempt?.status, 'crashed');
    assert.equal(attempt?.outputRef, null);
    assert.match(attempt?.diagnostics ?? '', /docker_unavailable/u);
  });
});

void test('docker backend records docker metadata and still validates imported candidate bytes', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-22T00:00:00.000Z',
    });

    const summary = await probeReactBundleExplicitCdnDependencies({
      workspaceRoot,
      store,
      request: BASE_REQUEST,
      timeoutMs: 1000,
      now: () => '2026-05-22T00:00:00.000Z',
      backend: {
        kind: 'docker_worker',
        imageRef: 'local/geulbat-metadata-probe:2026-05-22',
      },
      probeTransport: transport([200, 200]),
      dockerCommandRunner: async (invocation) => {
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
        assert.equal(invocation.args.includes('--network'), true);
        assert.equal(
          invocation.args[invocation.args.indexOf('--network') + 1],
          'none',
        );
        assert.equal(invocation.args.includes('--pull'), true);
        assert.equal(
          invocation.args[invocation.args.indexOf('--pull') + 1],
          'never',
        );
        assert.equal(
          invocation.args.includes(
            'GEULBAT_PROBE_NETWORK_POLICY=allowlisted_metadata_probe',
          ),
          true,
        );
        assert.equal(
          invocation.args.includes('GEULBAT_CONTAINER_NETWORK_MODE=none'),
          true,
        );
        const inputArg = invocation.args.find((item) =>
          item.includes(':/geulbat/input:ro'),
        );
        assert.ok(inputArg);
        const inputDir = inputArg.split(':/geulbat/input:ro')[0]!;
        const candidateText = await readFile(
          join(inputDir, 'candidate.json'),
          'utf8',
        );
        await invocation.writeOutput('candidate.json', candidateText);
        return {
          kind: 'exit',
          exitCode: 0,
          stdout: 'docker metadata probe ok',
          stderr: '',
        };
      },
    });

    assert.equal(summary.backend.kind, 'docker_worker');
    if (summary.backend.kind === 'docker_worker') {
      assert.equal(
        summary.backend.backendPolicyId,
        'react_bundle_dependency_metadata_probe_docker_v1',
      );
      assert.equal(
        summary.backend.allowlistId,
        'react_bundle_dependency_cdn_v1',
      );
      assert.equal(summary.backend.containerNetworkMode, 'none');
      assert.equal(
        summary.backend.imageRef,
        'local/geulbat-metadata-probe:2026-05-22',
      );
    }
    assert.equal(summary.allRequiredProbesOk, true);

    const attempt = store.getAttempt(summary.attemptId);
    assert.equal(attempt?.status, 'succeeded');
    assert.equal(attempt?.outputRef?.evidenceRef, summary.evidenceRef);
    assert.deepEqual(attempt?.capability, {
      schemaVersion: 1,
      capabilityId: 'react_bundle_dependency_metadata_probe',
      capabilityClass: 'candidate_generation',
      executionClass: 'docker_worker',
      commitBehavior: 'not_applicable',
      policies: {
        backendPolicyId: 'react_bundle_dependency_metadata_probe_docker_v1',
        imagePolicyId: 'react_bundle_dependency_metadata_probe_image_v1',
        filesystemPolicyId: 'react_bundle_dependency_metadata_probe_fs_v1',
        networkPolicy: summary.networkPolicy,
        networkPolicyVersion: summary.networkPolicyVersion,
        allowlistId: summary.allowlistId,
        containerNetworkMode: 'none',
      },
    });
  });
});

void test('docker backend rejects candidate output changed by the container', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-22T00:00:00.000Z',
    });

    await assert.rejects(
      () =>
        probeReactBundleExplicitCdnDependencies({
          workspaceRoot,
          store,
          request: BASE_REQUEST,
          timeoutMs: 1000,
          now: () => '2026-05-22T00:00:00.000Z',
          backend: {
            kind: 'docker_worker',
            imageRef: 'local/geulbat-metadata-probe:2026-05-22',
          },
          probeTransport: transport([200, 404]),
          dockerCommandRunner: async (invocation) => {
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

            const inputArg = invocation.args.find((item) =>
              item.includes(':/geulbat/input:ro'),
            );
            assert.ok(inputArg);
            const inputDir = inputArg.split(':/geulbat/input:ro')[0]!;
            const candidateText = await readFile(
              join(inputDir, 'candidate.json'),
              'utf8',
            );
            const candidate = JSON.parse(
              candidateText,
            ) as ReactBundleDependencyNetworkProbeCandidate;
            candidate.dependencyProbes = candidate.dependencyProbes.map(
              (probe) => ({
                ...probe,
                ok: true,
                finalUrl: probe.requestedUrl,
                method: 'HEAD',
                status: 200,
                contentType: 'application/javascript',
                contentLength: 20,
                bytesRead: 0,
                timingBucket: 'lt_100ms',
                redirectChain: [],
                policy: {
                  name: 'allowlisted_metadata_probe',
                  version: 1,
                  allowlistId: 'react_bundle_dependency_cdn_v1',
                },
              }),
            );
            candidate.failures = [];
            await invocation.writeOutput(
              'candidate.json',
              JSON.stringify(candidate, null, 2) + '\n',
            );
            return {
              kind: 'exit',
              exitCode: 0,
              stdout: 'docker metadata probe ok',
              stderr: '',
            };
          },
        }),
      /candidate content hash mismatch/,
    );

    const attempt = store.getAttempts().records[0];
    assert.equal(attempt?.status, 'failed');
    assert.equal(attempt?.outputRef, null);
    assert.match(attempt?.diagnostics ?? '', /candidate_validation_failed/u);
    assert.match(attempt?.diagnostics ?? '', /sandbox-output:/u);
  });
});

void test('docker backend availability consumes the attempt timeout before metadata transport runs', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-22T00:00:00.000Z',
    });
    let transportCalls = 0;

    await assert.rejects(
      () =>
        probeReactBundleExplicitCdnDependencies({
          workspaceRoot,
          store,
          request: BASE_REQUEST,
          timeoutMs: 10,
          backend: {
            kind: 'docker_worker',
            imageRef: 'local/geulbat-metadata-probe:2026-05-22',
          },
          probeTransport: async () => {
            transportCalls += 1;
            return {
              status: 200,
              location: null,
              contentType: 'application/javascript',
              contentLength: 20,
              bytesRead: 0,
            };
          },
          dockerCommandRunner: async (invocation) => {
            if (invocation.args[0] === '--version') {
              await new Promise((resolve) => setTimeout(resolve, 20));
              return {
                kind: 'exit',
                exitCode: 0,
                stdout: 'Docker version 27.0.0',
                stderr: '',
              };
            }
            if (invocation.args[0] === 'image') {
              if (invocation.timeoutMs === undefined) {
                assert.fail(
                  'expected image inspect invocation to keep explicit timeout',
                );
              }
              return invocation.timeoutMs <= 1
                ? {
                    kind: 'timeout',
                    stdout: '',
                    stderr: 'docker image inspect timeout',
                  }
                : {
                    kind: 'exit',
                    exitCode: 0,
                    stdout: '[]',
                    stderr: '',
                  };
            }
            return {
              kind: 'exit',
              exitCode: 0,
              stdout: 'docker metadata probe ok',
              stderr: '',
            };
          },
        }),
      /timed_out/,
    );

    assert.equal(transportCalls, 0);
    const attempt = store.getAttempts().records[0];
    assert.equal(attempt?.status, 'timed_out');
  });
});
