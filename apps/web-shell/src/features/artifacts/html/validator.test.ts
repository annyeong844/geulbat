import test from 'node:test';
import assert from 'node:assert/strict';

import { validateHtmlArtifactPayload } from './validator.js';

void test('validateHtmlArtifactPayload accepts fragment-only href', () => {
  assert.deepEqual(
    validateHtmlArtifactPayload('<a href="#footnote">Jump</a>'),
    { ok: true },
  );
});

void test('validateHtmlArtifactPayload accepts scripts, stylesheet links, and ordinary URLs', () => {
  assert.deepEqual(
    validateHtmlArtifactPayload(
      [
        '<link rel="stylesheet" href="https://cdn.example.com/app.css" />',
        '<script src="https://cdn.example.com/app.js"></script>',
        '<button onclick="window.ready = true">Click</button>',
        '<a href="/docs/start">Docs</a>',
        '<img src="blob:https://example.com/id" />',
        '<img src="data:image/png;base64,abc" />',
        '<script src="data:text/javascript,window.ready=true"></script>',
      ].join(''),
    ),
    { ok: true },
  );
});

void test('validateHtmlArtifactPayload rejects disallowed tags', () => {
  assert.deepEqual(
    validateHtmlArtifactPayload('<iframe src="/preview"></iframe>'),
    {
      ok: false,
      code: 'sanitize_rejected',
      detail: 'disallowed html tag is present',
    },
  );
});

void test('validateHtmlArtifactPayload rejects javascript URLs', () => {
  assert.deepEqual(
    validateHtmlArtifactPayload('<a href="javascript:alert(1)">Docs</a>'),
    {
      ok: false,
      code: 'sanitize_rejected',
      detail: 'href uses a disallowed javascript: URL',
    },
  );
});

void test('validateHtmlArtifactPayload rejects file URLs', () => {
  assert.deepEqual(
    validateHtmlArtifactPayload('<img src="file:///tmp/secret.png" />'),
    {
      ok: false,
      code: 'sanitize_rejected',
      detail: 'src uses a disallowed file: URL',
    },
  );
});
