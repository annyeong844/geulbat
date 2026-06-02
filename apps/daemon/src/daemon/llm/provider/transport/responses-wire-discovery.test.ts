import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertOAuthWireDiscoveryRecordIsSanitized,
  buildOAuthWireDiscoveryRecord,
  sanitizeOAuthWireDiscoveryEvent,
  sanitizeOAuthWireDiscoveryRequest,
} from './responses-wire-discovery.js';

const PRIVATE_PROMPT_PATH = ['', 'home', 'user', 'project', '.geulbat'].join(
  '/',
);

void test('sanitizeOAuthWireDiscoveryRequest redacts OAuth headers, session ids, prompt text, local paths, and non-structural strings', () => {
  const request = sanitizeOAuthWireDiscoveryRequest({
    headers: new Headers({
      Authorization: 'Bearer live-token-secret',
      'chatgpt-account-id': 'acct-secret',
      session_id: 'session-secret',
      'Content-Type': 'application/json',
    }),
    payload: {
      type: 'response.create',
      model: 'test-model',
      prompt_cache_key: 'session-secret',
      instructions: `private system prompt with ${PRIVATE_PROMPT_PATH}`,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'private user text' }],
        },
      ],
    },
  });

  const text = JSON.stringify(request);
  assert.doesNotMatch(text, /live-token-secret/u);
  assert.doesNotMatch(text, /acct-secret/u);
  assert.doesNotMatch(text, /session-secret/u);
  assert.doesNotMatch(text, /private system prompt/u);
  assert.doesNotMatch(text, /private user text/u);
  assert.doesNotMatch(text, /\.geulbat/u);
  assert.match(text, /\[redacted:oauth-header\]/u);
  assert.match(text, /\[redacted:prompt-text\]/u);
  assert.match(text, /\[redacted:provider-id\]/u);
  assert.match(text, /\[redacted:provider-text\]/u);
  assert.match(text, /\[redacted:provider-string\]/u);
});

void test('sanitizeOAuthWireDiscoveryEvent preserves event shape while redacting text and identifiers', () => {
  const event = sanitizeOAuthWireDiscoveryEvent({
    type: 'response.output_text.delta',
    item_id: 'item-secret',
    delta: 'private assistant text',
    response: {
      id: 'response-secret',
      output: [
        { content: [{ type: 'output_text', text: 'private output text' }] },
      ],
    },
  }) as Record<string, unknown>;

  assert.equal(event.type, 'response.output_text.delta');
  const text = JSON.stringify(event);
  assert.doesNotMatch(text, /item-secret/u);
  assert.doesNotMatch(text, /response-secret/u);
  assert.doesNotMatch(text, /private assistant text/u);
  assert.doesNotMatch(text, /private output text/u);
  assert.match(text, /\[redacted:provider-id\]/u);
  assert.match(text, /\[redacted:provider-text\]/u);
});

void test('buildOAuthWireDiscoveryRecord records sanitized snapshots and rejects unsanitized private markers', () => {
  const request = sanitizeOAuthWireDiscoveryRequest({
    headers: new Headers({ Authorization: 'Bearer live-token-secret' }),
    payload: {
      type: 'response.create',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
    },
  });
  const events = [
    sanitizeOAuthWireDiscoveryEvent({
      type: 'response.completed',
      response: { id: 'resp_123', usage: { input_tokens: 1 } },
    }),
  ];
  const record = buildOAuthWireDiscoveryRecord({
    capturedAt: '2026-05-27T00:00:00.000Z',
    request,
    events,
  });

  assert.equal(record.schemaVersion, 1);
  assert.equal(record.transport, 'chatgpt_codex_oauth_websocket');
  assert.equal(record.captureKind, 'request_response_shape');
  assert.doesNotThrow(() => assertOAuthWireDiscoveryRecordIsSanitized(record));
  assert.doesNotMatch(
    JSON.stringify(record),
    /live-token-secret|hello|resp_123/u,
  );
  assert.throws(
    () =>
      buildOAuthWireDiscoveryRecord({
        capturedAt: '2026-05-27T00:00:00.000Z',
        request: { leaked: 'Bearer live-token-secret' },
        events: [],
      }),
    /oauth wire discovery record contains private marker/u,
  );
});

void test('assertOAuthWireDiscoveryRecordIsSanitized rejects accidental raw leaks', () => {
  assert.throws(
    () =>
      assertOAuthWireDiscoveryRecordIsSanitized({
        schemaVersion: 1,
        transport: 'chatgpt_codex_oauth_websocket',
        captureKind: 'request_response_shape',
        capturedAt: '2026-05-27T00:00:00.000Z',
        request: { leaked: 'Bearer live-token-secret' },
        events: [],
      }),
    /oauth wire discovery record contains private marker/u,
  );
});
