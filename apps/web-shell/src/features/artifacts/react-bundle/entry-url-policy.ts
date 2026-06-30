import {
  isReactBundleShellOwnedPrivilegedUrl,
  validateReactBundleRuntimeUrlPolicy,
} from '@geulbat/protocol/react-bundle-runtime-url-policy';

import type {
  ArtifactPolicyOrBootFailure,
  ArtifactValidationSuccess,
} from '../artifact-types.js';

type ReactBundleEntryUrlValidation =
  | ArtifactValidationSuccess<{ entryUrl: string }>
  | ArtifactPolicyOrBootFailure;

type ReactBundleUrlValidation =
  | ArtifactValidationSuccess<{ url: string }>
  | ArtifactPolicyOrBootFailure;

export function validateReactBundleEntryUrl(
  rawEntryUrl: string,
): ReactBundleEntryUrlValidation {
  const result = validateReactBundleRuntimeUrl(rawEntryUrl, {
    emptyDetail: 'react bundle manifest requires a non-empty entryUrl',
    malformedDetail: 'react bundle manifest entryUrl must be an absolute URL',
    unsupportedSchemeDetail:
      'react bundle manifest entryUrl must use http or https',
    privilegedDetail:
      'react bundle manifest entryUrl points at a shell-owned privileged path',
  });
  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    entryUrl: result.url,
  };
}

export function validateReactBundleDependencyUrl(
  rawUrl: string,
): ReactBundleUrlValidation {
  const url = rawUrl.trim();
  if (!url) {
    return reject('react bundle runtime dependency URL must be non-empty');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return reject(
      'react bundle runtime dependency URL must be an absolute URL',
    );
  }

  if (isReactBundleShellOwnedPrivilegedUrl(parsedUrl)) {
    return rejectPolicy(
      'react bundle runtime dependency URL points at a shell-owned privileged path',
    );
  }

  return {
    ok: true,
    url: parsedUrl.toString(),
  };
}

function validateReactBundleRuntimeUrl(
  rawUrl: string,
  messages: {
    emptyDetail: string;
    malformedDetail: string;
    unsupportedSchemeDetail: string;
    privilegedDetail: string;
  },
): ReactBundleUrlValidation {
  const result = validateReactBundleRuntimeUrlPolicy(rawUrl);
  if (!result.ok) {
    switch (result.reasonCode) {
      case 'empty':
        return reject(messages.emptyDetail);
      case 'malformed':
        return reject(messages.malformedDetail);
      case 'unsupported_scheme':
        return rejectPolicy(messages.unsupportedSchemeDetail);
      case 'shell_owned_privileged':
        return rejectPolicy(messages.privilegedDetail);
    }
  }

  return {
    ok: true,
    url: result.url,
  };
}

function reject(detail: string): ArtifactPolicyOrBootFailure {
  return {
    ok: false,
    code: 'boot_failed',
    detail,
  };
}

function rejectPolicy(detail: string): ArtifactPolicyOrBootFailure {
  return {
    ok: false,
    code: 'policy_blocked',
    detail,
  };
}
