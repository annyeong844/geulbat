import {
  decodeReactBundleInlineSourceInput,
  type ReactBundleInlineSourceInput,
  type ReactBundleRuntimeManifest,
} from '@geulbat/protocol/react-bundle-inline-compile';
import { isPlainRecord } from '@geulbat/protocol/runtime-utils';

import { validateReactBundleEntryUrl } from './entry-url-policy.js';
import type {
  ArtifactValidationFailure,
  ArtifactPolicyOrBootFailure,
  ArtifactValidationSuccess,
} from '../artifact-types.js';

type ReactBundleArtifactPayloadValidation =
  | ArtifactValidationSuccess<{ manifest: ReactBundleRuntimeManifest }>
  | ArtifactPolicyOrBootFailure;

type ReactBundleArtifactInputPayloadValidation =
  | ArtifactValidationSuccess<{
      kind: 'manifest';
      manifest: ReactBundleRuntimeManifest;
    }>
  | ArtifactValidationSuccess<{
      kind: 'inline_source';
      input: ReactBundleInlineSourceInput;
    }>
  | ArtifactValidationFailure<
      'boot_failed' | 'policy_blocked' | 'sanitize_rejected'
    >;

export function validateReactBundleArtifactPayload(
  payload: string,
): ReactBundleArtifactPayloadValidation {
  if (!payload.trim()) {
    return reject('react bundle artifact payload is empty');
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(payload);
  } catch {
    return reject('react bundle payload must be a JSON manifest object');
  }

  if (!isPlainRecord(manifest)) {
    return reject('react bundle payload must be a JSON manifest object');
  }

  if (looksLikeInlineSourceProjectManifest(manifest)) {
    return reject(
      'react bundle inline source manifests with files/entry are unsupported; current runtime requires {"entryUrl":"..."} for a prebuilt bundle',
    );
  }

  if (typeof manifest['entryUrl'] !== 'string') {
    return reject('react bundle manifest requires a string entryUrl');
  }

  const entryUrlValidation = validateReactBundleEntryUrl(manifest['entryUrl']);
  if (!entryUrlValidation.ok) {
    return entryUrlValidation;
  }

  return {
    ok: true,
    manifest: {
      entryUrl: entryUrlValidation.entryUrl,
    },
  };
}

export function readReactBundleArtifactInputPayload(
  payload: string,
): ReactBundleArtifactInputPayloadValidation {
  if (!payload.trim()) {
    return reject('react bundle artifact payload is empty');
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(payload);
  } catch {
    return reject('react bundle payload must be a JSON manifest object');
  }

  if (!isPlainRecord(manifest)) {
    return reject('react bundle payload must be a JSON manifest object');
  }

  const inlineInput = decodeReactBundleInlineSourceInput(manifest);
  if (inlineInput.ok) {
    return {
      ok: true,
      kind: 'inline_source',
      input: inlineInput.value,
    };
  }

  if (typeof manifest['entryUrl'] !== 'string') {
    return reject('react bundle manifest requires a string entryUrl');
  }

  const entryUrlValidation = validateReactBundleEntryUrl(manifest['entryUrl']);
  if (!entryUrlValidation.ok) {
    return entryUrlValidation;
  }

  return {
    ok: true,
    kind: 'manifest',
    manifest: {
      entryUrl: entryUrlValidation.entryUrl,
    },
  };
}

function looksLikeInlineSourceProjectManifest(
  manifest: Record<string, unknown>,
): boolean {
  return (
    isPlainRecord(manifest['files']) && typeof manifest['entry'] === 'string'
  );
}

function reject(detail: string): ArtifactPolicyOrBootFailure {
  return {
    ok: false,
    code: 'boot_failed',
    detail,
  };
}
