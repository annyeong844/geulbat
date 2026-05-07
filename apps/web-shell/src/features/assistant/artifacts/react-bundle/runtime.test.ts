import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH } from '@geulbat/protocol/public-web-fixtures';

import {
  GEULBAT_REACT_RUNTIME_GLOBAL,
  REACT_BUNDLE_RUNTIME_ENTRY_ROOT_ID,
  REACT_BUNDLE_RUNTIME_ROOT_ID,
  buildReactBundleArtifactRuntimePayload,
} from './document.js';
import { resolveReactBundleArtifactRuntimePreview } from './runtime.js';
import type { ResolvedArtifactSourceRef } from '../../../artifacts/artifact-types.js';
import {
  brandProjectId,
  brandThreadId,
} from '../../../../lib/id-brand-helpers.js';

const REACT_BUNDLE_ENTRY_URL = `https://fixtures.geulbat.local${PUBLIC_WEB_REACT_BUNDLE_COUNTER_ENTRY_PATH}`;

function createResolvedSourceRef(
  overrides: Partial<ResolvedArtifactSourceRef> = {},
): ResolvedArtifactSourceRef {
  return {
    kind: null,
    projectId: null,
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
  const preview = resolveReactBundleArtifactRuntimePreview({
    payload,
    digest: 'fixture-react-bundle',
    sourceRef: createResolvedSourceRef({
      projectId: brandProjectId('workspace'),
      threadId: brandThreadId('00000000-0000-4000-8000-000000000001'),
    }),
  });

  assert.equal(preview.kind, 'rendered');
  return renderToStaticMarkup(preview.node);
}

void test('resolveReactBundleArtifactRuntimePreview renders the common runtime iframe', () => {
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
