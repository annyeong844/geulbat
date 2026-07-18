import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { HttpMetadataProbeRequestTransport } from '../network/http-metadata-probe.js';
import { createSandboxAttemptStore } from '../sandbox/attempt-store.js';
import type { ReactBundleDependencyNetworkProbeCandidate } from './react-bundle-dependency-network-probe-candidate.js';
import { probeReactBundleExplicitCdnDependencies } from './react-bundle-dependency-network-probe.js';
import {
  prepareReactBundleExplicitCdnDependencies,
  type ReactBundleDependencyPrepareRequest,
  type ValidatedReactBundleDependencyPrepareRequest,
} from './react-bundle-dependency-prepare.js';

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

async function withInvalidTmpdir<T>(fn: () => Promise<T>): Promise<T> {
  const invalidTempRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-invalid-sandbox-parent-'),
  );
  const notDirectory = join(invalidTempRoot, 'not-a-directory');
  const previousTmpdir = process.env.TMPDIR;
  try {
    await writeFile(notDirectory, 'not a directory', 'utf8');
    process.env.TMPDIR = notDirectory;
    return await fn();
  } finally {
    if (previousTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTmpdir;
    }
    await rm(invalidTempRoot, { recursive: true, force: true });
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

function successfulCandidate(
  request: ValidatedReactBundleDependencyPrepareRequest,
): ReactBundleDependencyNetworkProbeCandidate {
  return {
    schemaVersion: 1,
    adapterKind: 'react_bundle_dependency_metadata_probe',
    inputHash: request.inputHash,
    probeMode: 'metadata',
    networkPolicy: 'allowlisted_metadata_probe',
    networkPolicyVersion: 1,
    allowlistId: 'react_bundle_dependency_cdn_v1',
    generatedAt: '2026-05-19T00:00:00.000Z',
    dependencyProbes: request.dependencyRefs.map((dependency) => ({
      kind: dependency.kind,
      ...(dependency.specifier ? { specifier: dependency.specifier } : {}),
      ...(dependency.packageName
        ? { packageName: dependency.packageName }
        : {}),
      ...(dependency.version ? { version: dependency.version } : {}),
      ok: true,
      requestedUrl: dependency.url,
      finalUrl: dependency.url,
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
    })),
    failures: [],
  };
}

void test('probeReactBundleExplicitCdnDependencies records successful metadata evidence', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-19T00:00:00.000Z',
    });

    const summary = await probeReactBundleExplicitCdnDependencies({
      workspaceRoot,
      store,
      request: BASE_REQUEST,
      timeoutMs: 1000,
      now: () => '2026-05-19T00:00:00.000Z',
      probeTransport: transport([200, 200]),
    });

    assert.equal(summary.ok, true);
    assert.equal(summary.probeMode, 'metadata');
    assert.equal(summary.networkPolicy, 'allowlisted_metadata_probe');
    assert.equal(summary.networkPolicyVersion, 1);
    assert.equal(summary.allowlistId, 'react_bundle_dependency_cdn_v1');
    assert.equal(summary.backend.kind, 'in_process_adapter');
    assert.equal(
      summary.backend.backendPolicyId,
      'react_bundle_dependency_metadata_probe_in_process_v1',
    );
    assert.equal(summary.allRequiredProbesOk, true);
    assert.equal(summary.dependencyCount, 2);
    assert.equal(summary.failedDependencyCount, 0);
    assert.equal(summary.dependencyProbes.length, 2);
    assert.deepEqual(
      summary.dependencyProbes.map((probe) => ({
        kind: probe.kind,
        specifier: probe.specifier ?? null,
        requestedUrl: probe.requestedUrl,
        ok: probe.ok,
      })),
      [
        {
          kind: 'esm_import',
          specifier: 'canvas-confetti',
          requestedUrl: 'https://esm.sh/canvas-confetti@1.9.3',
          ok: true,
        },
        {
          kind: 'stylesheet',
          specifier: null,
          requestedUrl:
            'https://cdn.jsdelivr.net/npm/water.css@2.0.0/out/water.css',
          ok: true,
        },
      ],
    );
    assert.equal(
      summary.dependencyProbes[0]?.finalUrl,
      'https://esm.sh/canvas-confetti@1.9.3',
    );
    assert.match(summary.evidenceRef, /^sandbox-output:/u);

    const attempt = store.getAttempt(summary.attemptId);
    assert.equal(attempt?.status, 'succeeded');
    assert.equal(attempt?.jobKind, 'react_bundle_dependency_network_probe');
    assert.equal(
      attempt?.adapterKind,
      'react_bundle_dependency_metadata_probe',
    );
    assert.equal(attempt?.outputRef?.evidenceRef, summary.evidenceRef);
    assert.deepEqual(attempt?.capability, {
      schemaVersion: 1,
      capabilityId: 'react_bundle_dependency_metadata_probe',
      capabilityClass: 'candidate_generation',
      executionClass: 'in_process_adapter',
      commitBehavior: 'not_applicable',
      policies: {
        backendPolicyId: summary.backend.backendPolicyId,
        networkPolicy: summary.networkPolicy,
        networkPolicyVersion: summary.networkPolicyVersion,
        allowlistId: summary.allowlistId,
      },
    });

    const candidateText = await readFile(
      join(attempt!.outputRef!.rootPath, 'candidate.json'),
      'utf8',
    );
    const candidate = JSON.parse(
      candidateText,
    ) as ReactBundleDependencyNetworkProbeCandidate;
    assert.equal(candidate.schemaVersion, 1);
    assert.equal(candidate.generatedAt, '2026-05-19T00:00:00.000Z');
    assert.equal(candidate.dependencyProbes.length, 2);
    const candidateRecord = JSON.parse(candidateText) as Record<
      string,
      unknown
    >;
    assert.equal(Object.hasOwn(candidateRecord, 'integrity'), false);
    assert.equal(Object.hasOwn(candidateRecord, 'digest'), false);
    assert.equal(Object.hasOwn(candidateRecord, 'contentHash'), false);
    assert.equal(Object.hasOwn(candidateRecord, 'lockfile'), false);
    assert.equal(Object.hasOwn(candidateRecord, 'browserEvaluation'), false);
  });
});

void test('probeReactBundleExplicitCdnDependencies does not synthesize metadata probe timeouts', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-19T00:00:00.000Z',
    });
    let timeoutWasForwarded = false;

    const summary = await probeReactBundleExplicitCdnDependencies({
      workspaceRoot,
      store,
      request: BASE_REQUEST,
      now: () => '2026-05-19T00:00:00.000Z',
      probeTransport: async (_url, options) => {
        timeoutWasForwarded ||= 'timeoutMs' in options;
        return {
          status: 200,
          location: null,
          contentType: 'application/javascript',
          contentLength: 20,
          bytesRead: 0,
        };
      },
    });

    assert.equal(summary.ok, true);
    assert.equal(timeoutWasForwarded, false);
  });
});

void test('probeReactBundleExplicitCdnDependencies exposes requested URLs separately from final URLs', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-24T00:00:00.000Z',
    });

    const summary = await probeReactBundleExplicitCdnDependencies({
      workspaceRoot,
      store,
      request: {
        ...BASE_REQUEST,
        runtimeDependencies: {
          importMap: {
            imports: {
              'canvas-confetti': 'https://esm.sh/canvas-confetti@1.9.3',
            },
          },
        },
        dependencyRefs: [BASE_REQUEST.dependencyRefs[0]!],
      },
      timeoutMs: 1000,
      now: () => '2026-05-24T00:00:00.000Z',
      probeTransport: async (url) => {
        if (url.href === 'https://esm.sh/canvas-confetti@1.9.3') {
          return {
            status: 302,
            location: 'https://esm.sh/canvas-confetti@1.9.3?bundle',
            contentType: null,
            contentLength: null,
            bytesRead: 0,
          };
        }
        return {
          status: 200,
          location: null,
          contentType: 'application/javascript',
          contentLength: 20,
          bytesRead: 0,
        };
      },
    });

    assert.equal(summary.dependencyProbes.length, 1);
    assert.equal(
      summary.dependencyProbes[0]?.requestedUrl,
      'https://esm.sh/canvas-confetti@1.9.3',
    );
    assert.equal(
      summary.dependencyProbes[0]?.finalUrl,
      'https://esm.sh/canvas-confetti@1.9.3?bundle',
    );
  });
});

void test('probeReactBundleExplicitCdnDependencies fails all-required summary when one probe fails', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-19T00:00:00.000Z',
    });

    await assert.rejects(
      () =>
        probeReactBundleExplicitCdnDependencies({
          workspaceRoot,
          store,
          request: BASE_REQUEST,
          timeoutMs: 1000,
          probeTransport: transport([200, 404]),
        }),
      /dependency_probe_policy_failed/,
    );

    const attempts = store.getAttempts().records;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, 'failed');
    assert.equal(attempts[0]?.outputRef, null);
    assert.match(
      attempts[0]?.diagnostics ?? '',
      /dependency_probe_policy_failed/u,
    );
    assert.match(attempts[0]?.diagnostics ?? '', /sandbox-output:/u);
    assert.equal(
      attempts[0]?.capability?.capabilityId,
      'react_bundle_dependency_metadata_probe',
    );
    assert.equal(attempts[0]?.capability?.executionClass, 'in_process_adapter');
    assert.equal(attempts[0]?.capability?.commitBehavior, 'not_applicable');
    assert.equal(
      attempts[0]?.capability?.policies.networkPolicy,
      'allowlisted_metadata_probe',
    );
    assert.equal(
      attempts[0]?.capability?.policies.allowlistId,
      'react_bundle_dependency_cdn_v1',
    );
  });
});

void test('probeReactBundleExplicitCdnDependencies classifies injected process runner terminal statuses', async () => {
  for (const [kind, expectedStatus] of [
    ['timeout', 'timed_out'],
    ['cancelled', 'cancelled'],
    ['crash', 'crashed'],
  ] as const) {
    await withWorkspace(async (workspaceRoot) => {
      const store = createSandboxAttemptStore({
        now: () => '2026-05-19T00:00:00.000Z',
      });

      await assert.rejects(
        () =>
          probeReactBundleExplicitCdnDependencies({
            workspaceRoot,
            store,
            request: BASE_REQUEST,
            timeoutMs: 1000,
            processRunner: async () => ({
              kind,
              stdout: '',
              stderr: `simulated ${kind}`,
            }),
          }),
        new RegExp(expectedStatus),
      );

      const attempt = store.getAttempts().records[0];
      assert.equal(attempt?.status, expectedStatus);
      assert.equal(attempt?.outputRef, null);
    });
  }
});

void test('metadata probe does not replace no-network dependency prepare path', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-19T00:00:00.000Z',
    });

    const summary = await prepareReactBundleExplicitCdnDependencies({
      workspaceRoot,
      store,
      request: BASE_REQUEST,
      timeoutMs: 1000,
    });

    assert.equal(summary.provenanceSummary.networkPolicy, 'none');
    assert.equal(
      store.getAttempt(summary.attemptId)?.jobKind,
      'react_bundle_dependency_prepare',
    );
  });
});

void test('probeReactBundleExplicitCdnDependencies records failed attempts when root creation fails', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-19T00:00:00.000Z',
    });

    await assert.rejects(
      () =>
        withInvalidTmpdir(() =>
          probeReactBundleExplicitCdnDependencies({
            workspaceRoot,
            store,
            request: BASE_REQUEST,
            timeoutMs: 1000,
            probeTransport: transport([200, 200]),
          }),
        ),
      /sandbox_root_failed/,
    );

    const attempt = store.getAttempts().records[0];
    assert.equal(attempt?.status, 'failed');
    assert.match(attempt?.diagnostics ?? '', /sandbox_root_failed/u);
  });
});

void test('probeReactBundleExplicitCdnDependencies preserves extra output files without a hidden collection budget', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-19T00:00:00.000Z',
    });

    const summary = await probeReactBundleExplicitCdnDependencies({
      workspaceRoot,
      store,
      request: BASE_REQUEST,
      timeoutMs: 1000,
      processRunner: async (args) => {
        const candidate: ReactBundleDependencyNetworkProbeCandidate = {
          schemaVersion: 1,
          adapterKind: 'react_bundle_dependency_metadata_probe',
          inputHash: args.request.inputHash,
          probeMode: 'metadata',
          networkPolicy: 'allowlisted_metadata_probe',
          networkPolicyVersion: 1,
          allowlistId: 'react_bundle_dependency_cdn_v1',
          generatedAt: '2026-05-19T00:00:00.000Z',
          dependencyProbes: args.request.dependencyRefs.map((dependency) => ({
            kind: dependency.kind,
            ...(dependency.specifier
              ? { specifier: dependency.specifier }
              : {}),
            ...(dependency.packageName
              ? { packageName: dependency.packageName }
              : {}),
            ...(dependency.version ? { version: dependency.version } : {}),
            ok: true,
            requestedUrl: dependency.url,
            finalUrl: dependency.url,
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
          })),
          failures: [],
        };
        await args.writeOutput(
          'candidate.json',
          JSON.stringify(candidate, null, 2) + '\n',
        );
        for (let index = 0; index < 9; index += 1) {
          await args.writeOutput(`extra-${index}.txt`, 'x');
        }
        return { kind: 'exit', exitCode: 0, stdout: 'ok', stderr: '' };
      },
    });

    const attempt = store.getAttempt(summary.attemptId);
    assert.equal(attempt?.status, 'succeeded');
    assert.equal(attempt?.outputRef?.files.length, 10);
    assert.ok(
      attempt?.outputRef?.files.some(
        (file) => file.relativePath === 'extra-8.txt',
      ),
    );
  });
});

void test('probeReactBundleExplicitCdnDependencies rejects untrusted candidate contract drift', async (t) => {
  const cases: ReadonlyArray<{
    name: string;
    expected: RegExp;
    mutate(candidate: ReactBundleDependencyNetworkProbeCandidate): unknown;
  }> = [
    {
      name: 'candidate object',
      expected: /candidate must be an object/u,
      mutate: () => null,
    },
    {
      name: 'schema version',
      expected: /candidate schemaVersion must be 1/u,
      mutate: (candidate) => ({ ...candidate, schemaVersion: 2 }),
    },
    {
      name: 'adapter kind',
      expected: /candidate adapterKind mismatch/u,
      mutate: (candidate) => ({ ...candidate, adapterKind: 'other_adapter' }),
    },
    {
      name: 'input hash',
      expected: /candidate input hash mismatch/u,
      mutate: (candidate) => ({ ...candidate, inputHash: 'untrusted-hash' }),
    },
    {
      name: 'network policy',
      expected: /candidate networkPolicy mismatch/u,
      mutate: (candidate) => ({ ...candidate, networkPolicy: 'none' }),
    },
    {
      name: 'network policy version',
      expected: /candidate networkPolicyVersion mismatch/u,
      mutate: (candidate) => ({ ...candidate, networkPolicyVersion: 2 }),
    },
    {
      name: 'allowlist',
      expected: /candidate allowlistId mismatch/u,
      mutate: (candidate) => ({ ...candidate, allowlistId: 'other_allowlist' }),
    },
    {
      name: 'probe mode',
      expected: /candidate probeMode mismatch/u,
      mutate: (candidate) => ({ ...candidate, probeMode: 'content' }),
    },
    {
      name: 'generated timestamp',
      expected: /candidate generatedAt must be a string/u,
      mutate: (candidate) => ({ ...candidate, generatedAt: 0 }),
    },
    {
      name: 'dependency count',
      expected: /candidate dependency probe count mismatch/u,
      mutate: (candidate) => ({
        ...candidate,
        dependencyProbes: candidate.dependencyProbes.slice(1),
      }),
    },
    {
      name: 'dependency kind',
      expected: /candidate dependency probe kind mismatch/u,
      mutate: (candidate) => ({
        ...candidate,
        dependencyProbes: candidate.dependencyProbes.map((probe, index) =>
          index === 0 ? { ...probe, kind: 'stylesheet' } : probe,
        ),
      }),
    },
    {
      name: 'missing dependency projection',
      expected: /candidate dependency probe missing/u,
      mutate: (candidate) => ({
        ...candidate,
        dependencyProbes: [null, ...candidate.dependencyProbes.slice(1)],
      }),
    },
    {
      name: 'dependency requested URL',
      expected: /candidate dependency probe requestedUrl mismatch/u,
      mutate: (candidate) => ({
        ...candidate,
        dependencyProbes: candidate.dependencyProbes.map((probe, index) =>
          index === 0
            ? { ...probe, requestedUrl: 'https://untrusted.invalid/module.js' }
            : probe,
        ),
      }),
    },
    {
      name: 'dependency specifier',
      expected: /candidate dependency probe specifier mismatch/u,
      mutate: (candidate) => ({
        ...candidate,
        dependencyProbes: candidate.dependencyProbes.map((probe, index) =>
          index === 0 ? { ...probe, specifier: 'other-package' } : probe,
        ),
      }),
    },
    {
      name: 'dependency package name',
      expected: /candidate dependency probe packageName mismatch/u,
      mutate: (candidate) => ({
        ...candidate,
        dependencyProbes: candidate.dependencyProbes.map((probe, index) =>
          index === 0 ? { ...probe, packageName: 'other-package' } : probe,
        ),
      }),
    },
    {
      name: 'dependency version',
      expected: /candidate dependency probe version mismatch/u,
      mutate: (candidate) => ({
        ...candidate,
        dependencyProbes: candidate.dependencyProbes.map((probe, index) =>
          index === 0 ? { ...probe, version: '9.9.9' } : probe,
        ),
      }),
    },
    {
      name: 'successful dependency result shape',
      expected: /candidate dependency probe result mismatch at index 0/u,
      mutate: (candidate) => ({
        ...candidate,
        dependencyProbes: candidate.dependencyProbes.map((probe, index) =>
          index === 0 ? { ...probe, status: '200' } : probe,
        ),
      }),
    },
    {
      name: 'failed dependency result reason',
      expected: /candidate dependency probe result mismatch at index 0/u,
      mutate: (candidate) => ({
        ...candidate,
        dependencyProbes: candidate.dependencyProbes.map((probe, index) =>
          index === 0
            ? {
                ...probe,
                ok: false,
                reasonCode: 'untrusted_failure',
                message: 'failed',
              }
            : probe,
        ),
        failures: [
          {
            requestedUrl: candidate.dependencyProbes[0]?.requestedUrl ?? '',
            reasonCode: 'untrusted_failure',
            status: 200,
          },
        ],
      }),
    },
    {
      name: 'failure projection',
      expected: /candidate failures projection mismatch/u,
      mutate: (candidate) => ({
        ...candidate,
        failures: [
          {
            requestedUrl: candidate.dependencyProbes[0]?.requestedUrl ?? '',
            reasonCode: 'untrusted_failure',
          },
        ],
      }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await withWorkspace(async (workspaceRoot) => {
        const store = createSandboxAttemptStore({
          now: () => '2026-05-19T00:00:00.000Z',
        });

        await assert.rejects(
          () =>
            probeReactBundleExplicitCdnDependencies({
              workspaceRoot,
              store,
              request: BASE_REQUEST,
              timeoutMs: 1000,
              processRunner: async (args) => {
                const candidate = successfulCandidate(args.request);
                await args.writeOutput(
                  'candidate.json',
                  JSON.stringify(scenario.mutate(candidate), null, 2) + '\n',
                );
                return {
                  kind: 'exit',
                  exitCode: 0,
                  stdout: 'candidate emitted',
                  stderr: '',
                };
              },
            }),
          scenario.expected,
        );

        const attempt = store.getAttempts().records[0];
        assert.equal(attempt?.status, 'failed');
        assert.equal(attempt?.outputRef, null);
        assert.match(
          attempt?.diagnostics ?? '',
          /candidate_validation_failed/u,
        );
        assert.match(attempt?.diagnostics ?? '', scenario.expected);
        assert.match(attempt?.diagnostics ?? '', /sandbox-output:/u);
      });
    });
  }
});

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
