import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

import { readRunChannelUpgrade } from './run-channel-upgrade.js';

function createUpgradeRequest(args: {
  url?: string;
  origin?: string;
  host?: string;
  remoteAddress?: string | null;
  upgradeAuthorized?: boolean;
}): IncomingMessage {
  const headers: Record<string, string> = {
    host: args.host ?? '127.0.0.1:4312',
  };
  if (args.origin !== undefined) {
    headers['origin'] = args.origin;
  }
  if (args.upgradeAuthorized) {
    headers['x-geulbat-dev-token'] = 'test-token-123456';
  }

  return {
    url: args.url ?? '/api/ws',
    headers,
    socket: {
      remoteAddress: args.remoteAddress ?? '127.0.0.1',
    },
  } as IncomingMessage;
}

void test('readRunChannelUpgrade ignores non-run-channel upgrade paths', () => {
  const result = readRunChannelUpgrade(
    createUpgradeRequest({ url: '/api/other' }),
    new Set<string>(),
  );

  assert.deepEqual(result, {
    ok: false,
    kind: 'ignore',
  });
});

void test('readRunChannelUpgrade rejects disallowed origins', () => {
  const result = readRunChannelUpgrade(
    createUpgradeRequest({ origin: 'https://evil.example' }),
    new Set<string>(),
  );

  assert.deepEqual(result, {
    ok: false,
    kind: 'reject',
    statusCode: 403,
    statusText: 'Forbidden',
    body: 'origin not allowed',
  });
});

void test('readRunChannelUpgrade accepts allowed origins and returns upgrade metadata', () => {
  const previousDevToken = process.env['GEULBAT_DEV_TOKEN'];
  process.env['GEULBAT_DEV_TOKEN'] = 'test-token-123456';
  try {
    const result = readRunChannelUpgrade(
      createUpgradeRequest({
        origin: 'https://demo.trycloudflare.com',
        remoteAddress: '10.0.0.5',
        upgradeAuthorized: true,
      }),
      new Set<string>(['https://demo.trycloudflare.com']),
    );

    assert.deepEqual(result, {
      ok: true,
      upgradeAuthorized: true,
      remoteAddress: '10.0.0.5',
    });
  } finally {
    if (previousDevToken === undefined) {
      delete process.env['GEULBAT_DEV_TOKEN'];
    } else {
      process.env['GEULBAT_DEV_TOKEN'] = previousDevToken;
    }
  }
});
