import { DEV_TOKEN_HEADER_NAME } from '@geulbat/protocol/shell-auth';
import type { RunChannelClientMessage } from '@geulbat/protocol/run-channel';

export { DEV_TOKEN_HEADER_NAME };
export const COOKIE_AUTH_RUN_CHANNEL_TOKEN = 'cookie-auth';

export interface ShellAuthBootstrap {
  readonly mode: 'dev-cookie' | 'dev-token';
  readonly token?: string;
}

function getShellAuthBootstrap(): ShellAuthBootstrap {
  return {
    mode: 'dev-cookie',
  };
}

export function buildShellAuthHeaders(
  bootstrap: ShellAuthBootstrap = getShellAuthBootstrap(),
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(bootstrap.mode === 'dev-token' && typeof bootstrap.token === 'string'
      ? { [DEV_TOKEN_HEADER_NAME]: bootstrap.token }
      : {}),
  };
}

export function buildRunChannelAuthMessage(
  requestId: string,
  bootstrap: ShellAuthBootstrap = getShellAuthBootstrap(),
): RunChannelClientMessage {
  return {
    type: 'run.auth',
    requestId,
    token:
      bootstrap.mode === 'dev-token' && typeof bootstrap.token === 'string'
        ? bootstrap.token
        : COOKIE_AUTH_RUN_CHANNEL_TOKEN,
  };
}
