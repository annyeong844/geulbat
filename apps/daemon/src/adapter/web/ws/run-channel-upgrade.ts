import type { IncomingMessage } from 'node:http';

import { isAuthorizedShellHeaders } from '#web/auth/shell-auth.js';

import {
  getRequestUrl,
  isAllowedWebSocketOrigin,
} from './run-channel-socket.js';

const RUN_CHANNEL_PATH = '/api/ws';

interface IgnoredRunChannelUpgrade {
  ok: false;
  kind: 'ignore';
}

interface RejectedRunChannelUpgrade {
  ok: false;
  kind: 'reject';
  statusCode: number;
  statusText: string;
  body: string;
}

interface AcceptedRunChannelUpgrade {
  ok: true;
  upgradeAuthorized: boolean;
  remoteAddress: string | null;
}

type RunChannelUpgradeResult =
  | IgnoredRunChannelUpgrade
  | RejectedRunChannelUpgrade
  | AcceptedRunChannelUpgrade;

export function readRunChannelUpgrade(
  req: IncomingMessage,
  configuredAllowedOrigins: ReadonlySet<string>,
): RunChannelUpgradeResult {
  const url = getRequestUrl(req);
  if (url.pathname !== RUN_CHANNEL_PATH) {
    return { ok: false, kind: 'ignore' };
  }

  const origin =
    typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!isAllowedWebSocketOrigin(origin, configuredAllowedOrigins)) {
    return {
      ok: false,
      kind: 'reject',
      statusCode: 403,
      statusText: 'Forbidden',
      body: 'origin not allowed',
    };
  }

  return {
    ok: true,
    upgradeAuthorized: isAuthorizedShellHeaders(req.headers),
    remoteAddress: req.socket.remoteAddress ?? null,
  };
}
