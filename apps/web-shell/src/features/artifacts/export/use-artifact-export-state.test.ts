import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPUTER_FILE_API_SCOPE,
  FileSaveConflictError,
  type FileApiScope,
} from '../../../lib/api/files.js';
import { createArtifactPaneViewModel } from '../../../test-support/create-artifact-pane-view-model.js';
import { renderHook } from '../../../test-support/hook-test.js';
import { useArtifactExportState } from './use-artifact-export-state.js';

void test('useArtifactExportState submits static markdown exports through a top-level run and closes the panel', async () => {
  const requests: unknown[] = [];
  const hook = await renderHook(useArtifactExportState, {
    viewModel: createArtifactPaneViewModel(),
    isRunning: false,
    onStartArtifactRun(request) {
      requests.push(request);
    },
  });

  await hook.run((current) => {
    current.handleToggleExport();
  });
  assert.equal(hook.result.current.exportExpanded, true);

  await hook.run((current) => {
    current.handleExportChange('exports/demo.md');
  });
  assert.equal(hook.result.current.canSubmitExport, true);

  await hook.run((current) => current.handleExportSubmit());

  assert.equal(requests.length, 1);
  assert.match(
    (requests[0] as { displayPrompt: string }).displayPrompt,
    /Export artifact to exports\/demo\.md/,
  );
  assert.equal(hook.result.current.exportExpanded, false);
  assert.equal(hook.result.current.exportTargetPath, '');
  hook.unmount();
});

void test('useArtifactExportState derives generated text export placeholders from runtime snapshots', async () => {
  const hook = await renderHook(useArtifactExportState, {
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'js',
        digest: 'fixture',
        payload: 'console.log("hello");',
        raw: 'console.log("hello");',
      },
      actions: {
        apply: { visible: false, enabled: false, reason: null },
        export: { visible: false, enabled: false, reason: null },
      },
      sourceRef: {
        filePath: 'notes/demo.js',
      },
    }),
    isRunning: false,
    onStartArtifactRun() {
      return;
    },
  });

  assert.equal(hook.result.current.showExport, false);

  await hook.run((current) => {
    current.onGeneratedTextExportSnapshotChange({
      content: '<section>Hello</section>',
      mimeType: 'text/html',
      fileNameHint: 'preview.html',
    });
  });

  assert.equal(hook.result.current.showExport, true);
  assert.equal(hook.result.current.exportPlaceholder, 'exports/preview.html');
  assert.equal(hook.result.current.canOpenExport, true);
  hook.unmount();
});

void test('useArtifactExportState keeps runtime export hidden when artifact session authority is incomplete', async () => {
  const hook = await renderHook(useArtifactExportState, {
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'js',
        digest: 'fixture',
        payload: 'console.log("hello");',
        raw: 'console.log("hello");',
      },
      actions: {
        apply: { visible: false, enabled: false, reason: null },
        export: { visible: false, enabled: false, reason: null },
      },
      sourceRef: {
        threadId: null,
        runId: null,
        filePath: 'notes/demo.js',
        messageTimestamp: null,
      },
    }),
    isRunning: false,
    onStartArtifactRun() {
      return;
    },
  });

  await hook.run((current) => {
    current.onGeneratedTextExportSnapshotChange({
      content: '<section>Hello</section>',
      mimeType: 'text/html',
      fileNameHint: 'preview.html',
    });
  });

  assert.equal(hook.result.current.showExport, false);
  assert.equal(hook.result.current.canOpenExport, false);
  hook.unmount();
});

void test('useArtifactExportState remembers successful binary exports and only offers overwrite for the same path', async () => {
  const saveCalls: Array<{ scope: FileApiScope; path: string; blob: Blob }> =
    [];
  const hook = await renderHook(useArtifactExportState, {
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'js',
        digest: 'fixture',
        payload: 'console.log("hello");',
        raw: 'console.log("hello");',
      },
      actions: {
        apply: { visible: false, enabled: false, reason: null },
        export: { visible: false, enabled: false, reason: null },
      },
      sourceRef: {
        filePath: 'notes/demo.js',
      },
    }),
    isRunning: false,
    fileApi: {
      async saveBinaryFile(scope, path, blob) {
        saveCalls.push({ scope, path, blob });
        return {
          ok: true,
          path,
          versionToken: 'version-1',
          totalLines: 1,
        };
      },
    },
  });

  const blob = new Blob(['png'], { type: 'image/png' });
  await hook.run((current) => {
    current.onGeneratedBinaryExportSnapshotChange({
      blob,
      fileNameHint: 'preview.png',
    });
  });

  await hook.run((current) => {
    current.handleToggleExport();
    current.handleExportChange('exports/preview.png');
  });
  await hook.run((current) => current.handleExportSubmit());

  assert.equal(saveCalls.length, 1);
  assert.deepEqual(saveCalls[0], {
    scope: COMPUTER_FILE_API_SCOPE,
    path: 'exports/preview.png',
    blob,
  });
  assert.equal(hook.result.current.exportExpanded, false);

  await hook.run((current) => {
    current.handleToggleExport();
    current.handleExportChange('exports/preview.png');
  });
  assert.equal(hook.result.current.canOfferRememberedBinaryOverwrite, true);

  await hook.run((current) => {
    current.handleToggleOverwrite(true);
    current.handleExportChange('exports/other.png');
  });
  assert.equal(hook.result.current.canOfferRememberedBinaryOverwrite, false);
  assert.equal(hook.result.current.generatedBinaryOverwriteArmed, false);
  hook.unmount();
});

void test('useArtifactExportState clears remembered binary overwrite state after a conflict', async () => {
  const hook = await renderHook(useArtifactExportState, {
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'js',
        digest: 'fixture',
        payload: 'console.log("hello");',
        raw: 'console.log("hello");',
      },
      actions: {
        apply: { visible: false, enabled: false, reason: null },
        export: { visible: false, enabled: false, reason: null },
      },
      sourceRef: {
        filePath: 'notes/demo.js',
      },
    }),
    isRunning: false,
    fileApi: {
      async saveBinaryFile(_scope, path) {
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
    current.handleToggleExport();
    current.handleExportChange('exports/preview.png');
  });
  await hook.run((current) => current.handleExportSubmit());

  await hook.run((current) => {
    current.handleToggleExport();
    current.handleExportChange('exports/preview.png');
  });
  assert.equal(hook.result.current.canOfferRememberedBinaryOverwrite, true);

  await hook.run((current) => {
    current.handleToggleOverwrite(true);
  });
  assert.equal(hook.result.current.generatedBinaryOverwriteArmed, true);

  await hook.run((current) => current.handleExportSubmit());

  assert.equal(hook.result.current.generatedBinaryOverwriteArmed, false);
  assert.equal(hook.result.current.canOfferRememberedBinaryOverwrite, false);
  assert.match(
    hook.result.current.generatedBinaryExportError ?? '',
    /Unable to export exports\/preview\.png: stale write/,
  );
  hook.unmount();
});

void test('useArtifactExportState resets export state when the artifact session changes', async () => {
  const initialViewModel = createArtifactPaneViewModel({
    parsed: {
      kind: 'artifact',
      state: 'completed',
      renderer: 'js',
      digest: 'fixture',
      payload: 'console.log("hello");',
      raw: 'console.log("hello");',
    },
    actions: {
      apply: { visible: false, enabled: false, reason: null },
      export: { visible: false, enabled: false, reason: null },
    },
  });
  const hook = await renderHook(useArtifactExportState, {
    viewModel: initialViewModel,
    isRunning: false,
    onStartArtifactRun() {
      return;
    },
  });

  await hook.run((current) => {
    current.onGeneratedTextExportSnapshotChange({
      content: 'hello',
      mimeType: 'text/plain',
      fileNameHint: 'preview.txt',
    });
  });
  await hook.run((current) => {
    current.handleToggleExport();
    current.handleExportChange('exports/preview.txt');
  });
  assert.equal(hook.result.current.showExport, true);
  assert.equal(hook.result.current.exportExpanded, true);
  assert.equal(hook.result.current.exportTargetPath, 'exports/preview.txt');

  await hook.rerender({
    viewModel: createArtifactPaneViewModel({
      ...initialViewModel,
      sourceRef: {
        ...initialViewModel.sourceRef,
        messageTimestamp: '2026-04-04T00:01:00.000Z',
      },
    }),
    isRunning: false,
    onStartArtifactRun() {
      return;
    },
  });

  assert.equal(hook.result.current.exportExpanded, false);
  assert.equal(hook.result.current.exportTargetPath, '');
  assert.equal(hook.result.current.showExport, false);
  hook.unmount();
});

void test('useArtifactExportState refuses to open static export controls when no run launcher is available', async () => {
  const hook = await renderHook(useArtifactExportState, {
    viewModel: createArtifactPaneViewModel(),
    isRunning: false,
  });

  assert.equal(hook.result.current.canOpenExport, false);

  await hook.run((current) => {
    current.handleToggleExport();
  });

  assert.equal(hook.result.current.exportExpanded, false);
  hook.unmount();
});

void test('useArtifactExportState clears remembered binary overwrite state when text snapshots replace binary exports', async () => {
  const hook = await renderHook(useArtifactExportState, {
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'js',
        digest: 'fixture',
        payload: 'console.log("hello");',
        raw: 'console.log("hello");',
      },
      actions: {
        apply: { visible: false, enabled: false, reason: null },
        export: { visible: false, enabled: false, reason: null },
      },
      sourceRef: {
        filePath: 'notes/demo.js',
      },
    }),
    isRunning: false,
    fileApi: {
      async saveBinaryFile(_scope, path) {
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
    current.handleToggleExport();
    current.handleExportChange('exports/preview.png');
  });
  await hook.run((current) => current.handleExportSubmit());
  await hook.run((current) => {
    current.handleToggleExport();
    current.handleExportChange('exports/preview.png');
  });

  assert.equal(hook.result.current.canOfferRememberedBinaryOverwrite, true);

  await hook.run((current) => {
    current.onGeneratedTextExportSnapshotChange({
      content: '<section>Hello</section>',
      mimeType: 'text/html',
      fileNameHint: 'preview.html',
    });
  });

  assert.equal(hook.result.current.canOfferRememberedBinaryOverwrite, false);
  assert.equal(hook.result.current.generatedBinaryOverwriteArmed, false);
  assert.equal(hook.result.current.generatedBinaryExportError, null);
  hook.unmount();
});

void test('useArtifactExportState keeps runtime snapshot callback identities stable for the same artifact session', async () => {
  const hook = await renderHook(useArtifactExportState, {
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'react_bundle',
        digest: 'fixture',
        payload:
          '{"entryUrl":"http://127.0.0.1:1455/public-generated/react-bundle-inline/hash/entry.js"}',
        raw: '{"entryUrl":"http://127.0.0.1:1455/public-generated/react-bundle-inline/hash/entry.js"}',
      },
    }),
    isRunning: false,
  });

  const initialTextSnapshotCallback =
    hook.result.current.onGeneratedTextExportSnapshotChange;
  const initialBinarySnapshotCallback =
    hook.result.current.onGeneratedBinaryExportSnapshotChange;

  await hook.rerender({
    viewModel: createArtifactPaneViewModel({
      parsed: {
        kind: 'artifact',
        state: 'completed',
        renderer: 'react_bundle',
        digest: 'fixture',
        payload:
          '{"entryUrl":"http://127.0.0.1:1455/public-generated/react-bundle-inline/hash/entry.js"}',
        raw: '{"entryUrl":"http://127.0.0.1:1455/public-generated/react-bundle-inline/hash/entry.js"}',
      },
    }),
    isRunning: false,
  });

  assert.equal(
    hook.result.current.onGeneratedTextExportSnapshotChange,
    initialTextSnapshotCallback,
  );
  assert.equal(
    hook.result.current.onGeneratedBinaryExportSnapshotChange,
    initialBinarySnapshotCallback,
  );
  hook.unmount();
});
