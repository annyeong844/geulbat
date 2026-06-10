import type { IncomingHttpHeaders } from 'node:http';
import { DEV_TOKEN_HEADER_NAME } from '@geulbat/protocol/shell-auth';
import { getErrorMessage } from '@geulbat/shared-utils/error';
import { createLogger } from '@geulbat/shared-utils/logger';

import { isValidDevToken } from './token.js';

const DEV_AUTH_COOKIE_NAME = 'geulbat_dev_auth';
export const INVALID_DEV_TOKEN_MESSAGE = `missing or invalid ${DEV_TOKEN_HEADER_NAME}`;
export const SHELL_AUTH_ALLOWED_HEADERS = `Content-Type, ${DEV_TOKEN_HEADER_NAME}`;

const DEV_TOKEN_HEADER_KEY = DEV_TOKEN_HEADER_NAME.toLowerCase();
const DEV_AUTH_COOKIE_PREFIX = `${DEV_AUTH_COOKIE_NAME}=`;
const logger = createLogger('shell-auth');

function readShellAuthHeader(headers: IncomingHttpHeaders): string | undefined {
  const value = headers[DEV_TOKEN_HEADER_KEY];
  return typeof value === 'string' ? value : undefined;
}

function readShellAuthCookie(headers: IncomingHttpHeaders): string | undefined {
  const rawCookieHeader = headers.cookie;
  const cookieHeader = Array.isArray(rawCookieHeader)
    ? rawCookieHeader.join('; ')
    : rawCookieHeader;
  if (typeof cookieHeader !== 'string' || cookieHeader.trim() === '') {
    return undefined;
  }

  for (const cookie of cookieHeader.split(';')) {
    const trimmed = cookie.trim();
    if (!trimmed.startsWith(DEV_AUTH_COOKIE_PREFIX)) {
      continue;
    }
    const encodedValue = trimmed.slice(DEV_AUTH_COOKIE_PREFIX.length);
    try {
      return decodeURIComponent(encodedValue);
    } catch (error: unknown) {
      logger.warn('shell auth cookie decode failed:', getErrorMessage(error));
      return undefined;
    }
  }

  return undefined;
}

export function isAuthorizedShellHeaders(
  headers: IncomingHttpHeaders,
): boolean {
  return (
    isValidDevToken(readShellAuthHeader(headers)) ||
    isValidDevToken(readShellAuthCookie(headers))
  );
}

export function isAuthorizedShellWebSocketToken(token: unknown): boolean {
  return isValidDevToken(token);
}
