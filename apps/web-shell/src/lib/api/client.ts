import { tryParseJson } from '../json.js';

import { buildShellAuthHeaders } from '../auth/shell-auth.js';

const BASE_URL = '';
type Validator<T> = (value: unknown) => value is T;

interface ApiOkResponse {
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

// blob 미리보기 물리 상한 — 브라우저 메모리에 통째로 올리는 경로라
// fail-closed. 이 크기를 넘는 미리보기는 명시적으로 거부한다(§6: 부분
// 성공 없음 — 잘린 blob을 렌더하지 않는다).
const MAX_PREVIEW_BLOB_BYTES = 32 * 1024 * 1024;

export class PreviewTooLargeError extends Error {
  constructor(totalSize: number) {
    super(`preview too large: ${totalSize} bytes`);
    this.name = 'PreviewTooLargeError';
  }
}

export async function apiFetchBlob(path: string): Promise<Blob> {
  // Range로 상한까지만 요청 — 서버가 총 크기를 Content-Range로 알려주면
  // 초과분은 전송 자체를 하지 않고 실패한다
  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: 'same-origin',
    headers: {
      ...buildShellAuthHeaders(),
      Range: `bytes=0-${MAX_PREVIEW_BLOB_BYTES - 1}`,
    },
  });
  if (!res.ok && res.status !== 206) {
    const text = await res.text();
    throw new ApiFetchError(res.status, text);
  }
  const contentRange = res.headers.get('content-range');
  const totalSize = contentRange
    ? Number(/\/(\d+)$/.exec(contentRange)?.[1] ?? Number.NaN)
    : Number.NaN;
  if (Number.isFinite(totalSize) && totalSize > MAX_PREVIEW_BLOB_BYTES) {
    // 초과 확정 — 남은 바디 전송도 끊는다
    void res.body?.cancel().catch(() => {});
    throw new PreviewTooLargeError(totalSize);
  }
  return res.blob();
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit | undefined,
  validate: Validator<T>,
): Promise<T> {
  const headers = new Headers(buildShellAuthHeaders());
  new Headers(options?.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers,
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
