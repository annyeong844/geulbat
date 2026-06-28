import { tryParseJson } from '@geulbat/protocol/runtime-utils';

import { buildShellAuthHeaders } from '../auth/shell-auth.js';

const BASE_URL = '';
type Validator<T> = (value: unknown) => value is T;

export interface ApiOkResponse {
  ok: true;
}

export class ApiFetchError extends Error {
  readonly status: number;
  readonly bodyText: string;
  readonly bodyJson?: unknown;

  constructor(status: number, bodyText: string) {
    super(`API ${status}: ${bodyText}`);
    this.name = 'ApiFetchError';
    this.status = status;
    this.bodyText = bodyText;
    const parsedBody = tryParseJson(bodyText);
    this.bodyJson = parsedBody.ok ? parsedBody.value : undefined;
  }
}

export class ApiShapeError extends Error {
  constructor(path: string) {
    super(`invalid API response shape for ${path}`);
    this.name = 'ApiShapeError';
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit | undefined,
  validate: Validator<T>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { ...buildShellAuthHeaders(), ...options?.headers },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiFetchError(res.status, text);
  }
  const body = (await res.json()) as unknown;
  if (!validate(body)) {
    throw new ApiShapeError(path);
  }
  return body;
}

export function isApiOkResponse(value: unknown): value is ApiOkResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { ok?: unknown }).ok === true
  );
}
