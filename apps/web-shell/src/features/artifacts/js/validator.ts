import type {
  ArtifactBootFailure,
  ArtifactValidationSuccess,
} from '../artifact-types.js';

type JsArtifactPayloadValidation =
  | ArtifactValidationSuccess<Record<never, never>>
  | ArtifactBootFailure;

export function validateJsArtifactPayload(
  payload: string,
): JsArtifactPayloadValidation {
  if (!payload.trim()) {
    return reject('js artifact payload is empty');
  }

  return { ok: true };
}

function reject(detail: string): ArtifactBootFailure {
  return {
    ok: false,
    code: 'boot_failed',
    detail,
  };
}
