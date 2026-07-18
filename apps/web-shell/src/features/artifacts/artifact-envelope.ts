import {
  ARTIFACT_END_MARKER,
  ARTIFACT_START_PREFIX,
  isArtifactRenderer,
} from '@geulbat/protocol/artifacts';
import { isRecord, tryParseJson } from '@geulbat/protocol/runtime-utils';
import type { ArtifactParseResult } from './artifact-types.js';

export function parseArtifactEnvelope(raw: string): ArtifactParseResult {
  const startIndex = raw.indexOf(ARTIFACT_START_PREFIX);
  if (startIndex === -1) {
    return { kind: 'none', raw };
  }

  if (raw.slice(0, startIndex).trim()) {
    return fallback(raw, '', null, 'artifact prelude is not supported');
  }

  const headerEnd = raw.indexOf('-->', startIndex);
  if (headerEnd === -1) {
    return {
      kind: 'artifact',
      state: 'streaming',
      renderer: null,
      digest: null,
      payload: '',
      raw,
    };
  }

  const headerJson = raw
    .slice(startIndex + ARTIFACT_START_PREFIX.length, headerEnd)
    .trim();
  const header = parseHeader(headerJson);
  if (!header.ok) {
    return fallback(raw, '', null, header.issue);
  }

  const payloadStart = headerEnd + 3;
  const endIndex = raw.indexOf(ARTIFACT_END_MARKER, payloadStart);
  const nestedStart = raw.indexOf(ARTIFACT_START_PREFIX, payloadStart);
  if (nestedStart !== -1 && (endIndex === -1 || nestedStart < endIndex)) {
    return fallback(
      raw,
      '',
      header.value.renderer,
      'nested artifact envelope is not supported',
    );
  }

  if (endIndex === -1) {
    return {
      kind: 'artifact',
      state: 'streaming',
      renderer: header.value.renderer,
      digest: header.value.digest,
      payload: raw.slice(payloadStart),
      raw,
    };
  }

  const payload = raw.slice(payloadStart, endIndex);
  const suffix = raw.slice(endIndex + ARTIFACT_END_MARKER.length);
  if (suffix.trim()) {
    return fallback(
      raw,
      payload,
      header.value.renderer,
      'artifact suffix is not supported',
    );
  }
  if (!isArtifactRenderer(header.value.renderer)) {
    return fallback(
      raw,
      payload,
      header.value.renderer,
      'unsupported artifact renderer',
    );
  }

  return {
    kind: 'artifact',
    state: 'completed',
    renderer: header.value.renderer,
    digest: header.value.digest,
    payload,
    raw,
  };
}

export function settleArtifactParseResult(
  parsed: ArtifactParseResult,
  isRunning: boolean,
): ArtifactParseResult {
  if (parsed.kind !== 'artifact' || parsed.state !== 'streaming' || isRunning) {
    return parsed;
  }

  return fallback(
    parsed.raw,
    parsed.payload,
    parsed.renderer,
    'artifact envelope incomplete at stream end',
  );
}

function parseHeader(
  value: string,
):
  | { ok: true; value: { renderer: string; digest: string | null } }
  | { ok: false; issue: string } {
  const parsed = tryParseJson(value);
  if (!parsed.ok) {
    return { ok: false, issue: 'artifact header JSON parse failed' };
  }
  if (!isRecord(parsed.value)) {
    return { ok: false, issue: 'artifact header must be a JSON object' };
  }
  const candidate = parsed.value;
  if (typeof candidate.renderer !== 'string' || !candidate.renderer.trim()) {
    return { ok: false, issue: 'unsupported artifact renderer' };
  }
  return {
    ok: true,
    value: {
      renderer: candidate.renderer.trim(),
      digest:
        typeof candidate.digest === 'string' && candidate.digest.trim()
          ? candidate.digest.trim()
          : null,
    },
  };
}

function fallback(
  raw: string,
  payload: string,
  renderer: string | null,
  issue: string,
): ArtifactParseResult {
  return {
    kind: 'artifact',
    state: 'fallback',
    renderer,
    digest: null,
    payload,
    raw,
    issue,
  };
}
