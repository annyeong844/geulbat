import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProviderAuthCard } from './ProviderAuthCard.js';

void test('ProviderAuthCard shows reconnect guidance for expired credentials', () => {
  const html = renderToStaticMarkup(
    <ProviderAuthCard
      status={{
        state: 'expired',
        ready: false,
        lastErrorCode: 'provider_auth_session_expired',
        lastErrorMessage:
          'Saved provider credential has expired. Reconnect the provider.',
      }}
      busy={false}
      onConnect={() => {}}
      onDisconnect={() => {}}
    />,
  );

  assert.match(html, /Reconnect the provider/);
  assert.match(html, /Reconnect Provider/);
});

void test('ProviderAuthCard renders UI-level provider auth errors', () => {
  const html = renderToStaticMarkup(
    <ProviderAuthCard
      status={null}
      busy={false}
      uiError="Unable to load provider auth status. network down"
      onConnect={() => {}}
      onDisconnect={() => {}}
    />,
  );

  assert.match(html, /Unable to load provider auth status/);
  assert.match(html, /role="alert"/);
});

void test('ProviderAuthCard renders refresh warnings while a connected credential is still present', () => {
  const html = renderToStaticMarkup(
    <ProviderAuthCard
      status={{
        state: 'ready',
        ready: true,
        lastErrorCode: 'provider_auth_refresh_failed',
        lastErrorMessage: 'Provider token refresh failed. network down',
      }}
      busy={false}
      onConnect={() => {}}
      onDisconnect={() => {}}
    />,
  );

  assert.match(
    html,
    /Provider account is connected, but the latest token refresh did not complete cleanly/,
  );
  assert.match(html, /Provider token refresh failed\. network down/);
  assert.match(html, /role="alert"/);
});
