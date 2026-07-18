import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProviderAuthStatusResponse } from '@geulbat/protocol/provider-auth';

import { ProviderAuthCard } from './ProviderAuthCard.js';

function statuses(
  openai: ProviderAuthStatusResponse | null,
  grok: ProviderAuthStatusResponse | null = null,
) {
  return {
    openai_codex_direct: openai,
    grok_oauth: grok,
  };
}

const noErrors = {
  openai_codex_direct: null,
  grok_oauth: null,
};

void test('ProviderAuthCard shows reconnect guidance for expired credentials', () => {
  const html = renderToStaticMarkup(
    <ProviderAuthCard
      statuses={statuses({
        state: 'expired',
        ready: false,
        lastErrorCode: 'provider_auth_session_expired',
        lastErrorMessage:
          'Saved provider credential has expired. Reconnect the provider.',
      })}
      busyProviderId={null}
      uiErrors={noErrors}
      onConnect={() => {}}
      onDisconnect={() => {}}
    />,
  );

  assert.match(html, /Grok/);
  assert.match(html, /Reconnect the provider/);
  assert.match(html, /Reconnect Provider/);
});

void test('ProviderAuthCard renders UI-level provider auth errors', () => {
  const html = renderToStaticMarkup(
    <ProviderAuthCard
      statuses={statuses(null)}
      busyProviderId={null}
      uiErrors={{
        openai_codex_direct:
          'Unable to load provider auth status. network down',
        grok_oauth: null,
      }}
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
      statuses={statuses({
        state: 'ready',
        ready: true,
        lastErrorCode: 'provider_auth_refresh_failed',
        lastErrorMessage: 'Provider token refresh failed. network down',
      })}
      busyProviderId={null}
      uiErrors={noErrors}
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
