import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSandboxAttemptStore } from '../sandbox/attempt-store.js';
import {
  admitPtcExecutionProfile,
  createPtcLabLocalDockerPolicyProjection,
  type PtcLabAdmittedProfile,
  type PtcLabPolicyProjection,
} from './lab-profile.js';
import {
  importPtcLabArtifactWorkspaceFile,
  PTC_LAB_ARTIFACT_IMPORT_MAX_BYTES,
  type PtcLabArtifactWorkspaceSessionHandle,
} from './lab-artifact-workspace.js';
import {
  PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
  PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
} from './session-docker-contract.js';

const PRIVATE_TEST_PATH = '/tmp/geulbat-private/.geulbat/private';
const PRIVATE_TEST_HOME = '/tmp/geulbat-private';

async function withTempRoots<T>(
  fn: (roots: { workspaceRoot: string; artifactRoot: string }) => Promise<T>,
): Promise<T> {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-import-workspace-'),
  );
  const artifactRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-import-artifacts-'),
  );
  try {
    return await fn({ workspaceRoot, artifactRoot });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  }
}

function admittedLab(
  overrides: Partial<
    PtcLabPolicyProjection['mounts']['artifactWorkspace']
  > = {},
): PtcLabAdmittedProfile {
  const base = createPtcLabLocalDockerPolicyProjection();
  const labPolicy: PtcLabPolicyProjection = {
    ...base,
    mounts: {
      ...base.mounts,
      artifactWorkspace: {
        ...base.mounts.artifactWorkspace,
        ...overrides,
      },
    },
  };
  const admission = admitPtcExecutionProfile({
    requestedProfile: 'lab',
    labEnabled: true,
    reason: 'explicit_user_request',
    labPolicy,
  });
  assert.equal(admission.ok, true);
  return admission.ok ? admission.value : assert.fail('expected admission');
}

function session(
  artifactRootHostPath: string,
): PtcLabArtifactWorkspaceSessionHandle {
  return {
    profile: 'lab',
    policyId: 'ptc_lab_local_docker_policy_v1',
    labSessionId: 'ptc-lab-session-1',
    artifactRootHostPath,
    artifactRootContainerPath: PTC_SESSION_DOCKER_ARTIFACT_CONTAINER_ROOT,
    artifactWorkspaceMountPolicyId:
      PTC_SESSION_DOCKER_ARTIFACT_WORKSPACE_MOUNT_POLICY_ID,
  };
}

void test('importPtcLabArtifactWorkspaceFile imports one explicit file into sandbox evidence', async () => {
  await withTempRoots(async ({ workspaceRoot, artifactRoot }) => {
    await mkdir(join(artifactRoot, 'out'), { recursive: true });
    await writeFile(
      join(artifactRoot, 'out', 'result.txt'),
      'artifact bytes',
      'utf8',
    );
    const store = createSandboxAttemptStore({
      now: () => '2026-06-02T00:00:00.000Z',
    });

    const result = await importPtcLabArtifactWorkspaceFile({
      admission: admittedLab(),
      session: session(artifactRoot),
      workspaceRoot,
      attemptStore: store,
      request: { relativePath: 'out/result.txt', maxBytes: 1024 },
      now: () => '2026-06-02T00:00:01.000Z',
    });

    assert.equal(result.ok, true);
    assert.match(
      result.ok ? result.value.evidenceRef : '',
      /^sandbox-output:/u,
    );
    assert.equal(
      result.ok ? result.value.workspaceId : '',
      'ptc_lab_artifact_workspace_v1',
    );
    assert.equal(
      result.ok ? result.value.exportPolicyId : '',
      'ptc_lab_artifact_export_pending_v1',
    );
    assert.equal(
      result.ok ? result.value.artifactRelativePath : '',
      'out/result.txt',
    );
    assert.equal(
      result.ok ? result.value.totalBytes : 0,
      Buffer.byteLength('artifact bytes'),
    );
    assert.deepEqual(
      result.ok ? result.value.files.map((file) => file.relativePath) : [],
      ['out/result.txt'],
    );
    assert.equal(
      result.ok ? result.value.files[0]?.sha256 : '',
      createHash('sha256').update('artifact bytes').digest('hex'),
    );
    assert.equal(JSON.stringify(result).includes(artifactRoot), false);
    assert.equal(JSON.stringify(result).includes('.geulbat'), false);

    const attempts = store.getAttempts().records;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.jobKind, 'ptc_lab_artifact_workspace_import');
    assert.equal(attempts[0]?.adapterKind, 'ptc_lab_artifact_workspace');
    assert.equal(attempts[0]?.status, 'succeeded');
    assert.match(
      attempts[0]?.outputRef?.evidenceRef ?? '',
      /^sandbox-output:/u,
    );

    const copiedRoot = attempts[0]?.outputRef?.rootPath;
    assert.ok(copiedRoot);
    assert.equal(
      await readFile(join(copiedRoot, 'out', 'result.txt'), 'utf8'),
      'artifact bytes',
    );
  });
});

void test('importPtcLabArtifactWorkspaceFile rejects policy and session mismatches before reading files', async () => {
  await withTempRoots(async ({ workspaceRoot, artifactRoot }) => {
    const store = createSandboxAttemptStore();
    const mismatch = await importPtcLabArtifactWorkspaceFile({
      admission: admittedLab(),
      session: {
        ...session(artifactRoot),
        artifactWorkspaceMountPolicyId: 'other_artifact_mount_policy',
      },
      workspaceRoot,
      attemptStore: store,
      request: { relativePath: 'out/result.txt' },
    });

    assert.equal(mismatch.ok, false);
    assert.equal(
      mismatch.ok ? '' : mismatch.reasonCode,
      'ptc_lab_artifact_policy_mismatch',
    );
    assert.equal(store.getAttempts().records.length, 0);
  });
});

void test('importPtcLabArtifactWorkspaceFile rejects invalid relative paths and maxBytes', async () => {
  await withTempRoots(async ({ workspaceRoot, artifactRoot }) => {
    const invalidCases = [
      { relativePath: '', reasonCode: 'ptc_lab_artifact_path_invalid' },
      {
        relativePath: '/absolute.txt',
        reasonCode: 'ptc_lab_artifact_path_invalid',
      },
      {
        relativePath: '/geulbat/artifacts/out.txt',
        reasonCode: 'ptc_lab_artifact_path_invalid',
      },
      {
        relativePath: '/geulbat/package-cache/npm/_cacache/index',
        reasonCode: 'ptc_lab_artifact_path_invalid',
      },
      {
        relativePath: '../escape.txt',
        reasonCode: 'ptc_lab_artifact_path_invalid',
      },
      {
        relativePath: 'out/../result.txt',
        reasonCode: 'ptc_lab_artifact_path_invalid',
      },
      {
        relativePath: 'package-cache/../out.txt',
        reasonCode: 'ptc_lab_artifact_path_invalid',
      },
      {
        relativePath: 'nested\\\\file.txt',
        reasonCode: 'ptc_lab_artifact_path_invalid',
      },
      {
        relativePath: '.geulbat/secret.txt',
        reasonCode: 'ptc_lab_artifact_path_invalid',
      },
      {
        relativePath: 'node_modules/pkg/index.js',
        reasonCode: 'ptc_lab_artifact_path_invalid',
      },
    ] as const;

    for (const item of invalidCases) {
      const result = await importPtcLabArtifactWorkspaceFile({
        admission: admittedLab(),
        session: session(artifactRoot),
        workspaceRoot,
        attemptStore: createSandboxAttemptStore(),
        request: { relativePath: item.relativePath },
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok ? '' : result.reasonCode, item.reasonCode);
    }

    const invalidBytes = await importPtcLabArtifactWorkspaceFile({
      admission: admittedLab(),
      session: session(artifactRoot),
      workspaceRoot,
      attemptStore: createSandboxAttemptStore(),
      request: {
        relativePath: 'out/result.txt',
        maxBytes: PTC_LAB_ARTIFACT_IMPORT_MAX_BYTES + 1,
      },
    });
    assert.equal(invalidBytes.ok, false);
    assert.equal(
      invalidBytes.ok ? '' : invalidBytes.reasonCode,
      'ptc_lab_artifact_request_invalid',
    );
  });
});

void test('importPtcLabArtifactWorkspaceFile rejects missing files, directories, oversized files, and symlinks', async () => {
  await withTempRoots(async ({ workspaceRoot, artifactRoot }) => {
    await mkdir(join(artifactRoot, 'out'), { recursive: true });
    await writeFile(join(artifactRoot, 'out', 'large.txt'), 'abcdef', 'utf8');
    await symlink(
      join(artifactRoot, 'out', 'large.txt'),
      join(artifactRoot, 'out', 'link.txt'),
    );
    const outsideRoot = await mkdtemp(
      join(tmpdir(), 'geulbat-ptc-import-outside-'),
    );
    await writeFile(join(outsideRoot, 'result.txt'), 'outside', 'utf8');
    await symlink(outsideRoot, join(artifactRoot, 'escaped-parent'));

    const missing = await importPtcLabArtifactWorkspaceFile({
      admission: admittedLab(),
      session: session(artifactRoot),
      workspaceRoot,
      attemptStore: createSandboxAttemptStore(),
      request: { relativePath: 'out/missing.txt' },
    });
    assert.equal(missing.ok, false);
    assert.equal(
      missing.ok ? '' : missing.reasonCode,
      'ptc_lab_artifact_file_missing',
    );

    const directory = await importPtcLabArtifactWorkspaceFile({
      admission: admittedLab(),
      session: session(artifactRoot),
      workspaceRoot,
      attemptStore: createSandboxAttemptStore(),
      request: { relativePath: 'out' },
    });
    assert.equal(directory.ok, false);
    assert.equal(
      directory.ok ? '' : directory.reasonCode,
      'ptc_lab_artifact_file_unsupported',
    );

    const oversized = await importPtcLabArtifactWorkspaceFile({
      admission: admittedLab(),
      session: session(artifactRoot),
      workspaceRoot,
      attemptStore: createSandboxAttemptStore(),
      request: { relativePath: 'out/large.txt', maxBytes: 3 },
    });
    assert.equal(oversized.ok, false);
    assert.equal(
      oversized.ok ? '' : oversized.reasonCode,
      'ptc_lab_artifact_file_too_large',
    );

    const link = await importPtcLabArtifactWorkspaceFile({
      admission: admittedLab(),
      session: session(artifactRoot),
      workspaceRoot,
      attemptStore: createSandboxAttemptStore(),
      request: { relativePath: 'out/link.txt' },
    });
    assert.equal(link.ok, false);
    assert.equal(
      link.ok ? '' : link.reasonCode,
      'ptc_lab_artifact_file_unsupported',
    );

    try {
      const parentLink = await importPtcLabArtifactWorkspaceFile({
        admission: admittedLab(),
        session: session(artifactRoot),
        workspaceRoot,
        attemptStore: createSandboxAttemptStore(),
        request: { relativePath: 'escaped-parent/result.txt' },
      });
      assert.equal(parentLink.ok, false);
      assert.match(
        parentLink.ok ? '' : parentLink.reasonCode,
        /^ptc_lab_artifact_(file_unsupported|path_invalid)$/u,
      );
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

void test('importPtcLabArtifactWorkspaceFile rejects package-cache-looking host roots', async () => {
  await withTempRoots(async ({ workspaceRoot, artifactRoot }) => {
    const packageCacheRoot = join(
      artifactRoot,
      '..',
      'ptc-package-caches',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    await mkdir(join(packageCacheRoot, 'out'), { recursive: true });
    await writeFile(join(packageCacheRoot, 'out', 'result.txt'), 'cache');

    const result = await importPtcLabArtifactWorkspaceFile({
      admission: admittedLab(),
      session: session(packageCacheRoot),
      workspaceRoot,
      attemptStore: createSandboxAttemptStore(),
      request: { relativePath: 'out/result.txt' },
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? '' : result.reasonCode,
      'ptc_lab_artifact_policy_mismatch',
    );
    assert.equal(JSON.stringify(result).includes('ptc-package-caches'), false);
    assert.equal(
      JSON.stringify(result).includes('/geulbat/package-cache'),
      false,
    );
  });
});

void test('importPtcLabArtifactWorkspaceFile keeps diagnostics sanitized on import failures', async () => {
  await withTempRoots(async ({ workspaceRoot, artifactRoot }) => {
    await mkdir(join(artifactRoot, 'out'), { recursive: true });
    await writeFile(join(artifactRoot, 'out', 'result.txt'), 'ok', 'utf8');
    const result = await importPtcLabArtifactWorkspaceFile({
      admission: admittedLab(),
      session: {
        ...session(artifactRoot),
        labSessionId: PRIVATE_TEST_PATH,
      },
      workspaceRoot,
      attemptStore: createSandboxAttemptStore(),
      request: { relativePath: 'out/result.txt' },
    });

    assert.equal(JSON.stringify(result).includes(PRIVATE_TEST_HOME), false);
    assert.equal(JSON.stringify(result).includes('/tmp/'), false);
    assert.equal(JSON.stringify(result).includes('.geulbat'), false);
    assert.equal(JSON.stringify(result).includes('/geulbat/artifacts'), false);
    assert.equal(
      JSON.stringify(result).includes('/geulbat/package-cache'),
      false,
    );
    assert.equal(JSON.stringify(result).includes('ptc-package-caches'), false);
    assert.equal(JSON.stringify(result).includes('callback.sock'), false);
  });
});
