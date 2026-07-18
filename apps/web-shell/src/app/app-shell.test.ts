import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAppShellView,
  type CreateAppShellViewArgs,
} from './app-shell.js';

function createProviderAuthStub(): CreateAppShellViewArgs['providerAuth'] {
  return {
    providerAuthStatuses: {
      openai_codex_direct: {
        state: 'ready',
        ready: true,
      },
      grok_oauth: null,
    },
    providerAuthBusyProviderId: 'grok_oauth',
    providerAuthErrors: {
      openai_codex_direct: 'auth failed',
      grok_oauth: null,
    },
    providerAuthNotice: 'Provider auth refreshed.',
    handleConnectProvider: () => {},
    handleDisconnectProvider: () => {},
  };
}

void test('createAppShellView maps provider auth into the single Home shell', () => {
  const providerAuth = createProviderAuthStub();

  const shell = createAppShellView({
    providerAuth,
  });

  assert.equal(shell.providerAuthNotice, 'Provider auth refreshed.');
  assert.equal(
    shell.homeProps.providerAuthStatuses,
    providerAuth.providerAuthStatuses,
  );
  assert.equal(shell.homeProps.providerAuthBusyProviderId, 'grok_oauth');
  assert.equal(
    shell.homeProps.providerAuthErrors,
    providerAuth.providerAuthErrors,
  );
  assert.equal(
    shell.homeProps.onConnectProvider,
    providerAuth.handleConnectProvider,
  );
  assert.equal(
    shell.homeProps.onDisconnectProvider,
    providerAuth.handleDisconnectProvider,
  );
});
