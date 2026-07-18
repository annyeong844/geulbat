import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH } from '@geulbat/protocol/public-web-fixtures';
import { PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX } from '@geulbat/protocol/react-bundle-inline-compile';

import {
  GEULBAT_REACT_RUNTIME_GLOBAL,
  REACT_BUNDLE_RUNTIME_ENTRY_ROOT_ID,
  REACT_BUNDLE_RUNTIME_ROOT_ID,
  buildReactBundleArtifactRuntimePayload,
} from './document.js';
import { resolveReactBundleArtifactRuntimePreview } from './preview.js';
import type { ResolvedArtifactSourceRef } from '../../artifact-types.js';
import type { ArtifactRuntimeFrameRenderArgs } from '../types.js';
import { brandThreadId } from '../../../../lib/id-brand-helpers.js';

const REACT_BUNDLE_ENTRY_URL = `https://fixtures.geulbat.local${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`;
const PUBLIC_CDN_REACT_ENTRY_URL = 'https://cdn.example.com/react-entry.js';
const PRIVATE_LOCAL_REACT_ENTRY_URL = `https://192.168.0.1${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`;
const LOCAL_GENERATED_REACT_ENTRY_URL = `http://127.0.0.1:3456${PUBLIC_GENERATED_REACT_BUNDLE_INLINE_PATH_PREFIX}cache-key/entry.js`;

function createResolvedSourceRef(
  overrides: Partial<ResolvedArtifactSourceRef> = {},
): ResolvedArtifactSourceRef {
  return {
    kind: null,
    workingDirectory: '',
    threadId: null,
    runId: null,
    filePath: null,
    messageTimestamp: null,
    artifactId: null,
    artifactVersion: null,
    persistenceEpoch: null,
    ...overrides,
  };
}

function resolveRenderedReactBundlePreview(payload: string) {
  const runtimeFrameArgs: ArtifactRuntimeFrameRenderArgs[] = [];
  const preview = resolveReactBundleArtifactRuntimePreview({
    payload,
    digest: 'fixture-react-bundle',
    sourceRef: createResolvedSourceRef({
      workingDirectory: 'stories/sample',
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    }),
    renderRuntimeFrame(args) {
      runtimeFrameArgs.push(args);
      return createElement('iframe', {
        sandbox: args.sandbox,
        src: `http://127.0.0.1:3456/artifact-runtime/host?renderer=${args.renderer}&rev=fixture`,
      });
    },
  });

  assert.equal(preview.kind, 'rendered');
  assert.equal(runtimeFrameArgs.length, 1);
  assert.equal(runtimeFrameArgs[0]?.renderer, 'react_bundle');
  assert.equal(runtimeFrameArgs[0]?.title, 'react bundle artifact preview');
  assert.equal(
    runtimeFrameArgs[0]?.sandbox,
    'allow-scripts allow-forms allow-same-origin',
  );
  assert.equal(
    runtimeFrameArgs[0]?.sourceRef.threadId,
    brandThreadId('00000000-0000-4000-8000-000000000001'),
  );
  return renderToStaticMarkup(preview.node);
}

void test('resolveReactBundleArtifactRuntimePreview renders supported fixtures through the runtime frame', () => {
  const html = resolveRenderedReactBundlePreview(
    JSON.stringify({
      entryUrl: REACT_BUNDLE_ENTRY_URL,
    }),
  );

  assert.match(html, /<iframe/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.doesNotMatch(html, /allow-downloads/);
  assert.match(
    html,
    /src="http:\/\/127\.0\.0\.1:3456\/artifact-runtime\/host\?[^"]*rev=/,
  );
});

void test('resolveReactBundleArtifactRuntimePreview keeps public CDN manifest entry URLs rendered', () => {
  const html = resolveRenderedReactBundlePreview(
    JSON.stringify({
      entryUrl: PUBLIC_CDN_REACT_ENTRY_URL,
    }),
  );

  assert.match(html, /<iframe/);
  assert.doesNotMatch(html, /sanitize_rejected/);
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
});

void test('resolveReactBundleArtifactRuntimePreview keeps personal-local manifest entry URLs rendered', () => {
  for (const entryUrl of [
    PRIVATE_LOCAL_REACT_ENTRY_URL,
    LOCAL_GENERATED_REACT_ENTRY_URL,
  ]) {
    const html = resolveRenderedReactBundlePreview(
      JSON.stringify({ entryUrl }),
    );

    assert.match(html, /<iframe/);
    assert.doesNotMatch(html, /sanitize_rejected/);
    assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  }
});

void test('buildReactBundleArtifactRuntimePayload installs runtime globals and imports manifest entry modules', () => {
  const document = buildReactBundleArtifactRuntimePayload({
    entryUrl: REACT_BUNDLE_ENTRY_URL,
  });

  assert.match(document, /^\(async \(\) => \{/);
  assert.match(document, new RegExp(REACT_BUNDLE_RUNTIME_ROOT_ID));
  assert.match(document, new RegExp(REACT_BUNDLE_RUNTIME_ENTRY_ROOT_ID));
  assert.match(document, new RegExp(GEULBAT_REACT_RUNTIME_GLOBAL));
  assert.match(document, /react-dom\/client/);
  assert.match(document, /scheduler/);
  assert.match(document, /createRoot: __geulbatReactDomClient__\.createRoot/);
  assert.match(document, /const __geulbatStorageReady__ = Promise\.resolve\(/);
  assert.match(document, /storage: window\.storage/);
  assert.match(document, /storageReady: __geulbatStorageReady__/);
  assert.match(document, /const __geulbatEntryUrl__ = \(\(\) => \{/);
  assert.match(document, /new URL\("https:\/\/fixtures\.geulbat\.local/);
  assert.match(document, /await import\(__geulbatEntryUrl__\)/);
  assert.match(
    document,
    /await Promise\.resolve\(__geulbatBundleRegistration__\.mount\(\{/,
  );
  assert.match(document, /root: __geulbatEntryRoot__/);
  assert.match(
    document,
    /react bundle entry module must default export a bundle object/,
  );
  assert.match(
    document,
    /react bundle entry module must default export a callable mount\(args\)/,
  );
  assert.match(
    document,
    /react bundle manifest entryUrl points at the current shell origin outside the public fixture\/generated host/,
  );
  assert.match(document, /let __geulbatDidUnmount__ = false;/);
  assert.match(document, /if \(__geulbatDidUnmount__\) \{/);
  assert.match(document, /className = "geulbat-js-runtime-error"/);
  assert.doesNotMatch(document, /__GEULBAT_REACT_BUNDLE__/);
  assert.doesNotMatch(
    document,
    /await Promise\.resolve\(window\.__GEULBAT_RUNTIME_STORAGE_READY__\);/,
  );
});

void test('buildReactBundleArtifactRuntimePayload rejects non-http executable entry schemes before import', () => {
  assert.throws(
    () =>
      buildReactBundleArtifactRuntimePayload({
        entryUrl: 'data:text/javascript,export default {}',
      }),
    /react bundle manifest entryUrl must use http or https/,
  );
});

void test('buildReactBundleArtifactRuntimePayload injects runtime dependencies before entry import', () => {
  const document = buildReactBundleArtifactRuntimePayload({
    entryUrl: REACT_BUNDLE_ENTRY_URL,
    runtimeDependencies: {
      importMap: {
        imports: {
          'canvas-confetti': 'https://esm.sh/canvas-confetti@1.9.3',
        },
      },
      stylesheets: [
        'https://cdn.jsdelivr.net/npm/water.css@2/out/water.css',
        'https://cdn.example.com/theme.css',
      ],
    },
  });

  const importMapAppendIndex = document.indexOf(
    'document.head.appendChild(importMapScript)',
  );
  const stylesheetAppendIndex = document.indexOf(
    'document.head.appendChild(stylesheetLink)',
  );
  const entryImportIndex = document.indexOf(
    'await import(__geulbatEntryUrl__)',
  );
  const firstStylesheetIndex = document.indexOf(
    'https://cdn.jsdelivr.net/npm/water.css@2/out/water.css',
  );
  const secondStylesheetIndex = document.indexOf(
    'https://cdn.example.com/theme.css',
  );

  assert.notEqual(importMapAppendIndex, -1);
  assert.notEqual(stylesheetAppendIndex, -1);
  assert.notEqual(entryImportIndex, -1);
  assert.ok(importMapAppendIndex < entryImportIndex);
  assert.ok(stylesheetAppendIndex < entryImportIndex);
  assert.ok(firstStylesheetIndex < secondStylesheetIndex);
  assert.match(document, /importMapScript\.type = "importmap"/);
  assert.match(document, /"canvas-confetti"/);
});

void test('buildReactBundleArtifactRuntimePayload serializes runtime dependency JSON safely', () => {
  const document = buildReactBundleArtifactRuntimePayload({
    entryUrl: REACT_BUNDLE_ENTRY_URL,
    runtimeDependencies: {
      importMap: {
        imports: {
          danger:
            'https://cdn.example.com/</script><script>alert(1)</script>.js',
          line: `https://cdn.example.com/${'\u2028'}dep.js`,
        },
      },
    },
  });

  assert.doesNotMatch(document, /<\/script><script>/);
  assert.match(document, /\\u003C\/script>/);
  assert.match(document, /\\u2028/);
});

void test('buildReactBundleArtifactRuntimePayload does not add legacy global script fallbacks for import maps', () => {
  const document = buildReactBundleArtifactRuntimePayload({
    entryUrl: REACT_BUNDLE_ENTRY_URL,
    runtimeDependencies: {
      importMap: {
        imports: {
          'canvas-confetti': 'https://esm.sh/canvas-confetti@1.9.3',
        },
      },
    },
  });

  assert.doesNotMatch(document, /<script src=/);
  assert.doesNotMatch(document, /window\.canvasConfetti/);
});

void test('buildReactBundleArtifactRuntimePayload treats empty runtime dependencies like no dependencies', () => {
  const document = buildReactBundleArtifactRuntimePayload({
    entryUrl: REACT_BUNDLE_ENTRY_URL,
    runtimeDependencies: {
      importMap: {
        imports: {},
      },
      stylesheets: [],
    },
  });

  assert.match(document, /const __geulbatRuntimeDependencies__ = null;/);
  assert.doesNotMatch(document, /"imports":\{\}/);
  assert.doesNotMatch(document, /"stylesheets":\[\]/);
  assert.match(document, /await import\(__geulbatEntryUrl__\)/);
});
