import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSandboxAttemptStore } from './attempt-store.js';
import {
  prepareReactBundleExplicitCdnDependencies,
  validateReactBundleDependencyPrepareRequest,
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

void test('validateReactBundleDependencyPrepareRequest accepts explicit CDN dependency input', () => {
  const validated = validateReactBundleDependencyPrepareRequest(BASE_REQUEST);

  assert.equal(validated.entryUrl, BASE_REQUEST.entryUrl);
  assert.deepEqual(
    validated.runtimeDependencies,
    BASE_REQUEST.runtimeDependencies,
  );
  assert.equal(validated.dependencyRefs.length, 2);
  assert.equal(validated.dependencyRefs[0]?.integrityStatus, 'missing_allowed');
  assert.equal(validated.networkPolicy, 'none');
  assert.equal(validated.lifecycleScripts, 'not_applicable');
});

void test('validateReactBundleDependencyPrepareRequest rejects ESM provenance that does not match import map', () => {
  assert.throws(
    () =>
      validateReactBundleDependencyPrepareRequest({
        ...BASE_REQUEST,
        dependencyRefs: [
          {
            kind: 'esm_import',
            specifier: 'lodash',
            packageName: 'lodash',
            version: '4.17.21',
            provider: 'explicit_cdn',
            url: 'https://esm.sh/lodash@4.17.21',
          },
        ],
      }),
    /missing dependency provenance for import-map specifier: canvas-confetti/,
  );
});

void test('validateReactBundleDependencyPrepareRequest rejects version ranges and latest tags', () => {
  for (const version of [
    'latest',
    '^1.9.3',
    '~1.9.3',
    '>=1.0.0',
    '1.x',
    '*',
    '',
    '18',
  ]) {
    assert.throws(
      () =>
        validateReactBundleDependencyPrepareRequest({
          ...BASE_REQUEST,
          dependencyRefs: [
            {
              kind: 'esm_import',
              specifier: 'canvas-confetti',
              packageName: 'canvas-confetti',
              version,
              provider: 'explicit_cdn',
              url: `https://esm.sh/canvas-confetti@${version || 'latest'}`,
            },
            BASE_REQUEST.dependencyRefs[1]!,
          ],
        }),
      /dependency version must be/,
      version,
    );
  }
});

void test('validateReactBundleDependencyPrepareRequest rejects stylesheet without provenance', () => {
  assert.throws(
    () =>
      validateReactBundleDependencyPrepareRequest({
        ...BASE_REQUEST,
        dependencyRefs: [BASE_REQUEST.dependencyRefs[0]!],
      }),
    /missing dependency provenance for stylesheet/,
  );
});

void test('validateReactBundleDependencyPrepareRequest rejects extra provenance not used by runtime dependencies', () => {
  assert.throws(
    () =>
      validateReactBundleDependencyPrepareRequest({
        ...BASE_REQUEST,
        dependencyRefs: [
          ...BASE_REQUEST.dependencyRefs,
          {
            kind: 'stylesheet',
            packageName: 'unused.css',
            version: '1.0.0',
            provider: 'explicit_cdn',
            url: 'https://cdn.jsdelivr.net/npm/unused.css@1.0.0/index.css',
          },
        ],
      }),
    /dependency provenance does not match stylesheets/,
  );
});

void test('validateReactBundleDependencyPrepareRequest rejects unsafe dependency URLs even without network I/O', () => {
  for (const url of [
    'ftp://example.com/app.js',
    'data:text/javascript,alert(1)',
    'javascript:alert(1)',
    'https://user:pass@example.com/pkg.js',
    'http://127.0.0.1/pkg.js',
    'http://localhost/pkg.js',
    'https://example.com/.geulbat/sandbox-outputs/pkg.js',
  ]) {
    assert.throws(
      () =>
        validateReactBundleDependencyPrepareRequest({
          ...BASE_REQUEST,
          runtimeDependencies: {
            importMap: { imports: { 'canvas-confetti': url } },
          },
          dependencyRefs: [
            {
              kind: 'esm_import',
              specifier: 'canvas-confetti',
              packageName: 'canvas-confetti',
              version: '1.9.3',
              provider: 'explicit_cdn',
              url,
            },
          ],
        }),
      /dependency URL/,
      url,
    );
  }
});

void test('prepareReactBundleExplicitCdnDependencies returns a candidate summary from imported evidence', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-react-bundle-deps-'),
  );
  try {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-18T00:00:00.000Z',
    });

    const summary = await prepareReactBundleExplicitCdnDependencies({
      workspaceRoot,
      store,
      request: BASE_REQUEST,
      timeoutMs: 1_000,
    });

    assert.equal(summary.ok, true);
    assert.equal(summary.manifest.entryUrl, BASE_REQUEST.entryUrl);
    assert.deepEqual(
      summary.manifest.runtimeDependencies,
      BASE_REQUEST.runtimeDependencies,
    );
    assert.match(summary.evidenceRef, /^sandbox-output:/);
    assert.equal(summary.provenanceSummary.networkPolicy, 'none');
    assert.equal(summary.provenanceSummary.lifecycleScripts, 'not_applicable');
    assert.equal(summary.provenanceSummary.dependencyCount, 2);
    assert.deepEqual(
      summary.provenanceSummary.dependencyEvidence.map(
        (dependency) => dependency.kind,
      ),
      ['esm_import', 'stylesheet'],
    );

    const attempt = store.getAttempt(summary.attemptId);
    assert.equal(attempt?.status, 'succeeded');
    assert.equal(attempt?.jobKind, 'react_bundle_dependency_prepare');
    assert.equal(
      attempt?.adapterKind,
      'react_bundle_explicit_cdn_dependency_prepare',
    );
    assert.equal(attempt?.outputRef?.evidenceRef, summary.evidenceRef);
    assert.ok(attempt?.outputRef?.rootPath);

    const candidate = JSON.parse(
      await readFile(
        join(attempt!.outputRef!.rootPath, 'candidate.json'),
        'utf8',
      ),
    ) as { provenance: { networkPolicy: string } };
    assert.equal(candidate.provenance.networkPolicy, 'none');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('prepareReactBundleExplicitCdnDependencies classifies process failures explicitly', async () => {
  for (const [kind, expectedStatus] of [
    ['timeout', 'timed_out'],
    ['cancelled', 'cancelled'],
    ['crash', 'crashed'],
    ['exit', 'failed'],
  ] as const) {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-react-bundle-deps-'),
    );
    try {
      const store = createSandboxAttemptStore({
        now: () => '2026-05-18T00:00:00.000Z',
      });

      await assert.rejects(
        () =>
          prepareReactBundleExplicitCdnDependencies({
            workspaceRoot,
            store,
            request: BASE_REQUEST,
            timeoutMs: 1_000,
            processRunner: async () =>
              kind === 'exit'
                ? { kind, exitCode: 2, stdout: '', stderr: 'bad input' }
                : { kind, stdout: '', stderr: `${kind} happened` },
          }),
        /react bundle dependency prepare failed/,
      );

      const attempts = store.getAttempts().records;
      assert.equal(attempts[0]?.status, expectedStatus);
      assert.equal(attempts[0]?.outputRef, null);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
});

void test('prepareReactBundleExplicitCdnDependencies rejects malformed imported candidate output', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-react-bundle-deps-'),
  );
  try {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-18T00:00:00.000Z',
    });

    await assert.rejects(
      () =>
        prepareReactBundleExplicitCdnDependencies({
          workspaceRoot,
          store,
          request: BASE_REQUEST,
          timeoutMs: 1_000,
          processRunner: async (args) => {
            await args.writeOutput(
              'candidate.json',
              JSON.stringify({ schemaVersion: 1, adapterKind: 'wrong' }),
            );
            return { kind: 'exit', exitCode: 0, stdout: 'ok', stderr: '' };
          },
        }),
      /candidate adapterKind mismatch/,
    );

    const attempt = store.getAttempts().records[0];
    assert.equal(attempt?.status, 'failed');
    assert.equal(attempt?.outputRef, null);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

void test('prepareReactBundleExplicitCdnDependencies records failed attempts when root creation fails', async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-react-bundle-deps-'),
  );
  try {
    const store = createSandboxAttemptStore({
      now: () => '2026-05-18T00:00:00.000Z',
    });

    await assert.rejects(
      () =>
        withInvalidTmpdir(() =>
          prepareReactBundleExplicitCdnDependencies({
            workspaceRoot,
            store,
            request: BASE_REQUEST,
            timeoutMs: 1_000,
          }),
        ),
      /sandbox_root_failed/,
    );

    const attempt = store.getAttempts().records[0];
    assert.equal(attempt?.status, 'failed');
    assert.match(attempt?.diagnostics ?? '', /sandbox_root_failed/u);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
