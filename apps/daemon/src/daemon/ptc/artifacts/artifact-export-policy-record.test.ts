import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  clearStoredPtcArtifactExportPolicy,
  PTC_ARTIFACT_EXPORT_MAX_FILES_ENV,
  PTC_ARTIFACT_EXPORT_MAX_FILE_BYTES_ENV,
  PTC_ARTIFACT_EXPORT_MAX_TOTAL_BYTES_ENV,
  PtcArtifactExportPolicyRecordError,
  resolvePtcArtifactExportPolicy,
  resolvePtcArtifactExportPolicyFromEnv,
  writeStoredPtcArtifactExportPolicy,
} from './artifact-export-policy-record.js';

void test('artifact export environment policy is all-or-none', () => {
  assert.deepEqual(
    resolvePtcArtifactExportPolicyFromEnv({
      [PTC_ARTIFACT_EXPORT_MAX_FILES_ENV]: '4',
      [PTC_ARTIFACT_EXPORT_MAX_FILE_BYTES_ENV]: '1048576',
      [PTC_ARTIFACT_EXPORT_MAX_TOTAL_BYTES_ENV]: '2097152',
    }),
    {
      maxFiles: 4,
      maxFileBytes: 1_048_576,
      maxTotalBytes: 2_097_152,
    },
  );
  assert.throws(
    () =>
      resolvePtcArtifactExportPolicyFromEnv({
        [PTC_ARTIFACT_EXPORT_MAX_FILES_ENV]: '4',
      }),
    PtcArtifactExportPolicyRecordError,
  );
});

void test('stored artifact export policy is used only when the environment does not own it', async () => {
  const homeStateRoot = await mkdtemp(
    join(tmpdir(), 'geulbat-ptc-artifact-policy-'),
  );
  try {
    const storedPolicy = {
      maxFiles: 3,
      maxFileBytes: 2_000_000,
      maxTotalBytes: 5_000_000,
    };
    await writeStoredPtcArtifactExportPolicy({
      homeStateRoot,
      policy: storedPolicy,
    });
    assert.deepEqual(
      resolvePtcArtifactExportPolicy({ homeStateRoot, env: {} }),
      { source: 'settings', policy: storedPolicy },
    );
    assert.equal(
      resolvePtcArtifactExportPolicy({
        homeStateRoot,
        env: {
          [PTC_ARTIFACT_EXPORT_MAX_FILES_ENV]: '1',
          [PTC_ARTIFACT_EXPORT_MAX_FILE_BYTES_ENV]: '10',
          [PTC_ARTIFACT_EXPORT_MAX_TOTAL_BYTES_ENV]: '10',
        },
      }).source,
      'environment',
    );

    await clearStoredPtcArtifactExportPolicy(homeStateRoot);
    assert.deepEqual(
      resolvePtcArtifactExportPolicy({ homeStateRoot, env: {} }),
      { source: 'disabled' },
    );
  } finally {
    await rm(homeStateRoot, { recursive: true, force: true });
  }
});
