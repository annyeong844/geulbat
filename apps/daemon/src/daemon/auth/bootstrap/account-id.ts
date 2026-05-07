interface JwtPayloadAuthSection {
  chatgpt_account_id?: unknown;
}

interface JwtPayloadRecord {
  'https://api.openai.com/auth'?: JwtPayloadAuthSection;
  chatgpt_account_id?: unknown;
  account_id?: unknown;
}

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
    const payload = JSON.parse(
      decodeBase64Url(payloadPart),
    ) as JwtPayloadRecord;
    const namespaced =
      payload['https://api.openai.com/auth']?.chatgpt_account_id;
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
    return null;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}
