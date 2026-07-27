import type { IncomingHttpHeaders } from 'node:http';
import { DEV_TOKEN_HEADER_NAME } from '@geulbat/protocol/shell-auth';
import { createLogger } from '@geulbat/structured-logger/logger';

import { getErrorMessage } from '../../../daemon/utils/error.js';

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

/**
 * 브라우저가 `<img>`, `<video>`, websocket upgrade처럼 임의 header를 붙일 수
 * 없는 same-origin 요청에도 shell 권한을 보낼 수 있게 하는 session cookie다.
 * 수명 숫자를 숨겨 두지 않고 browser session에 맡기며, 진입 문서를 다시
 * 받으면 current daemon token으로 교체된다.
 */
export function buildShellAuthCookieHeader(token: string): string {
  return [
    `${DEV_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
  ].join('; ');
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
