const DISALLOWED_TAG_PATTERN = /<\s*(iframe|object|embed|base)\b/i;
const META_HTTP_EQUIV_PATTERN = /<\s*meta\b[^>]*http-equiv\b/i;
const URL_ATTR_PATTERN =
  /\b(href|src|action|formaction|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const EXPLICIT_URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const DISALLOWED_URL_SCHEMES = new Set(['javascript', 'file']);

import type {
  ArtifactSanitizeRejectedFailure,
  ArtifactValidationSuccess,
} from '../artifact-types.js';

type HtmlArtifactPayloadValidation =
  | ArtifactValidationSuccess<Record<never, never>>
  | ArtifactSanitizeRejectedFailure;

export function validateHtmlArtifactPayload(
  payload: string,
): HtmlArtifactPayloadValidation {
  if (DISALLOWED_TAG_PATTERN.test(payload)) {
    return reject('disallowed html tag is present');
  }
  if (META_HTTP_EQUIV_PATTERN.test(payload)) {
    return reject('meta http-equiv is not allowed');
  }

  for (const attribute of readUrlAttributes(payload)) {
    const issue = validateUrlAttribute(attribute.name, attribute.value);
    if (issue) {
      return issue;
    }
  }

  return { ok: true };
}

function* readUrlAttributes(
  payload: string,
): Generator<{ name: string; value: string }> {
  const pattern = new RegExp(URL_ATTR_PATTERN);
  for (const match of payload.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (!name || !value) {
      continue;
    }
    yield { name, value };
  }
}

function validateUrlAttribute(
  name: string,
  value: string,
): ArtifactSanitizeRejectedFailure | null {
  const normalized = value.trim();
  const lowerCased = normalized.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (lowerCased.startsWith('#')) {
    return null;
  }

  const schemeMatch = lowerCased.match(EXPLICIT_URL_SCHEME_PATTERN);
  if (!schemeMatch) {
    return null;
  }

  const scheme = schemeMatch[0].slice(0, -1);
  if (
    scheme === 'http' ||
    scheme === 'https' ||
    scheme === 'blob' ||
    scheme === 'data'
  ) {
    return null;
  }
  if (DISALLOWED_URL_SCHEMES.has(scheme)) {
    return reject(`${name} uses a disallowed ${scheme}: URL`);
  }
  return reject(`${name} uses a disallowed ${scheme}: URL`);
}

function reject(detail: string): ArtifactSanitizeRejectedFailure {
  return { ok: false, code: 'sanitize_rejected', detail };
}
