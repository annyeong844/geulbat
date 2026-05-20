import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { HttpMetadataProbeRequestTransport } from '../network/http-metadata-probe.js';
import { createSandboxAttemptStore } from './attempt-store.js';
import {
  probeReactBundleExplicitCdnDependencies,
  type ReactBundleDependencyNetworkProbeCandidate,
} from './react-bundle-dependency-network-probe.js';
import {
  prepareReactBundleExplicitCdnDependencies,
  type ReactBundleDependencyPrepareRequest,
} from './react-bundle-dependency-prepare.js';

const BASE_REQUEST: ReactBundleDependencyPrepareRequest = {
  entryUrl: 'https://cdn.example.com/app.js',
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
    assert.equal(summary.allRequiredProbesOk, true);
    assert.equal(summary.dependencyCount, 2);
    assert.equal(summary.failedDependencyCount, 0);
    assert.match(summary.evidenceRef, /^sandbox-output:/u);

    const attempt = store.getAttempt(summary.attemptId);
    assert.equal(attempt?.status, 'succeeded');
    assert.equal(attempt?.jobKind, 'react_bundle_dependency_network_probe');
    assert.equal(
      attempt?.adapterKind,
      'react_bundle_dependency_metadata_probe',
    );
    assert.equal(attempt?.outputRef?.evidenceRef, summary.evidenceRef);

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
