import { createLogger } from '@geulbat/structured-logger/logger';
import { isRecord } from '../../runtime-json.js';
import { getErrorMessage } from '../../utils/error.js';

const logger = createLogger('provider-auth');

interface ProviderIdentityInput {
  accountId?: string;
  idToken?: string;
  accessToken: string;
}

export function deriveProviderAccountId(
  input: ProviderIdentityInput,
): string | null {
  const explicit = input.accountId?.trim();
  if (explicit) {
    return explicit;
  }

  const fromIdToken = extractAccountIdFromJwt(input.idToken);
  if (fromIdToken) {
    return fromIdToken;
  }

  return extractAccountIdFromJwt(input.accessToken);
}

export function extractAccountIdFromJwt(
  token: string | undefined,
): string | null {
  if (!token) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const payloadPart = parts[1];
  if (!payloadPart) {
    return null;
  }

  try {
    const payload: unknown = JSON.parse(decodeBase64Url(payloadPart));
    if (!isRecord(payload)) {
      throw new TypeError('Provider account id JWT payload must be an object.');
    }

    const authSection = payload['https://api.openai.com/auth'];
    const namespaced = isRecord(authSection)
      ? authSection.chatgpt_account_id
      : undefined;
    if (typeof namespaced === 'string' && namespaced.trim()) {
      return namespaced.trim();
    }
    if (
      typeof payload.chatgpt_account_id === 'string' &&
      payload.chatgpt_account_id.trim()
    ) {
      return payload.chatgpt_account_id.trim();
    }
    if (typeof payload.account_id === 'string' && payload.account_id.trim()) {
      return payload.account_id.trim();
    }
    if (typeof payload.sub === 'string' && payload.sub.trim()) {
      return payload.sub.trim();
    }
    return null;
  } catch (error: unknown) {
    logger.warn(
      'provider account id jwt decode failed:',
      getErrorMessage(error),
    );
    return null;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}
