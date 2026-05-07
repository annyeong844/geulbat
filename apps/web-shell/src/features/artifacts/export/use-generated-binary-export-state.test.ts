import test from 'node:test';
import assert from 'node:assert/strict';

import { FileSaveConflictError } from '../../../lib/api/files.js';
import { renderHook } from '../../../test-support/hook-test.js';
import {
  canOverwriteRememberedGeneratedBinaryExport,
  useGeneratedBinaryExportState,
} from './use-generated-binary-export-state.js';

void test('useGeneratedBinaryExportState remembers successful binary exports and disarms overwrite on path changes', async () => {
  const hook = await renderHook(useGeneratedBinaryExportState, {
    fileApi: {
      async saveBinaryFile(_projectId, path) {
        return {
          ok: true,
          path,
          versionToken: 'version-1',
          totalLines: 1,
        };
      },
    },
  });

  await hook.run((current) => {
    current.onGeneratedBinaryExportSnapshotChange({
      blob: new Blob(['png'], { type: 'image/png' }),
      fileNameHint: 'preview.png',
    });
  });
  await hook.run((current) =>
    current.submitGeneratedBinaryExport({
      projectId: 'workspace',
      targetPath: 'exports/preview.png',
    }),
  );

  assert.deepEqual(hook.result.current.rememberedGeneratedBinaryExportTarget, {
    path: 'exports/preview.png',
    versionToken: 'version-1',
  });
  assert.equal(
    canOverwriteRememberedGeneratedBinaryExport({
      rememberedTarget:
        hook.result.current.rememberedGeneratedBinaryExportTarget,
      targetPath: 'exports/preview.png',
    }),
    true,
  );

  await hook.run((current) => {
    current.handleToggleOverwrite(true);
    current.handleBinaryExportTargetPathChange('exports/other.png');
  });

  assert.equal(hook.result.current.generatedBinaryOverwriteArmed, false);
  assert.equal(hook.result.current.generatedBinaryExportError, null);
  hook.unmount();
});

void test('useGeneratedBinaryExportState clears remembered overwrite state after a conflict', async () => {
  const hook = await renderHook(useGeneratedBinaryExportState, {
    fileApi: {
      async saveBinaryFile(_projectId, path) {
        return {
          ok: true,
          path,
          versionToken: 'version-1',
          totalLines: 1,
        };
      },
      async replaceBinaryFile() {
        throw new FileSaveConflictError({ message: 'stale write' } as never);
      },
    },
  });

  await hook.run((current) => {
    current.onGeneratedBinaryExportSnapshotChange({
      blob: new Blob(['png'], { type: 'image/png' }),
      fileNameHint: 'preview.png',
    });
  });
  await hook.run((current) =>
    current.submitGeneratedBinaryExport({
      projectId: 'workspace',
      targetPath: 'exports/preview.png',
    }),
  );
  await hook.run((current) => {
    current.handleToggleOverwrite(true);
  });
  await hook.run((current) =>
    current.submitGeneratedBinaryExport({
      projectId: 'workspace',
      targetPath: 'exports/preview.png',
    }),
  );

  assert.equal(hook.result.current.generatedBinaryOverwriteArmed, false);
  assert.equal(hook.result.current.rememberedGeneratedBinaryExportTarget, null);
  assert.match(
    hook.result.current.generatedBinaryExportError ?? '',
    /Unable to export exports\/preview\.png: stale write/,
  );
  hook.unmount();
});

void test('useGeneratedBinaryExportState clears snapshot family state without touching pending session flags', async () => {
  const hook = await renderHook(useGeneratedBinaryExportState, {});

  await hook.run((current) => {
    current.onGeneratedBinaryExportSnapshotChange({
      blob: new Blob(['png'], { type: 'image/png' }),
      fileNameHint: 'preview.png',
    });
    current.handleToggleOverwrite(true);
  });

  assert.equal(
    hook.result.current.generatedBinaryExportSnapshot?.fileNameHint,
    'preview.png',
  );
  assert.equal(hook.result.current.generatedBinaryOverwriteArmed, true);

  await hook.run((current) => {
    current.clearGeneratedBinaryExportSnapshotState();
  });

  assert.equal(hook.result.current.generatedBinaryExportSnapshot, null);
  assert.equal(hook.result.current.rememberedGeneratedBinaryExportTarget, null);
  assert.equal(hook.result.current.generatedBinaryOverwriteArmed, false);
  assert.equal(hook.result.current.generatedBinaryExportError, null);
  hook.unmount();
});
