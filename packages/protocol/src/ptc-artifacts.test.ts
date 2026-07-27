import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPtcArtifactFileUrl,
  isPtcArtifactExportSettingsStatus,
  isPtcArtifactRelativePath,
  isPtcExecuteCodeArtifactExport,
} from './ptc-artifacts.js';

void test('PTC artifact protocol validates settings, relative paths, and result metadata', () => {
  assert.equal(
    isPtcArtifactExportSettingsStatus({
      state: 'ready',
      source: 'stored',
      policy: {
        maxFiles: 3,
        maxFileBytes: 1024,
        maxTotalBytes: 2048,
      },
    }),
    true,
  );
  assert.equal(isPtcArtifactRelativePath('reports/summary.json'), true);
  assert.equal(isPtcArtifactRelativePath('node_modules/report.json'), false);
  assert.equal(isPtcArtifactRelativePath('.geulbat/report.json'), false);
  assert.equal(isPtcArtifactRelativePath('../summary.json'), false);
  assert.equal(isPtcArtifactRelativePath('reports\\summary.json'), false);
  assert.equal(
    isPtcExecuteCodeArtifactExport({
      evidenceRef: 'sandbox-output:sandbox-evidence-1',
      files: [
        {
          relativePath: 'reports/summary.json',
          bytes: 12,
          sha256: 'a'.repeat(64),
        },
      ],
      totalBytes: 12,
    }),
    true,
  );
  assert.equal(
    buildPtcArtifactFileUrl({
      evidenceRef: 'sandbox-output:sandbox-evidence-1',
      relativePath: 'reports/summary.json',
      download: true,
    }),
    '/api/ptc-artifacts/file?evidenceRef=sandbox-output%3Asandbox-evidence-1&relativePath=reports%2Fsummary.json&download=1',
  );
});
