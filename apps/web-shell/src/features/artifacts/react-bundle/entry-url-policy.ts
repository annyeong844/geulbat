import { DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN } from '@geulbat/protocol/artifact-runtime-host';
import { isPublicWebFixturePath } from '@geulbat/protocol/public-web-fixtures';
import { isPublicGeneratedReactBundleInlinePath } from '@geulbat/protocol/react-bundle-inline-compile';

import type {
  ArtifactPolicyOrBootFailure,
  ArtifactValidationSuccess,
} from '../artifact-types.js';

const SHELL_OWNED_RUNTIME_HOST = new URL(DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN);

type ReactBundleEntryUrlValidation =
  | ArtifactValidationSuccess<{ entryUrl: string }>
  | ArtifactPolicyOrBootFailure;

export function validateReactBundleEntryUrl(
  rawEntryUrl: string,
): ReactBundleEntryUrlValidation {
  const entryUrl = rawEntryUrl.trim();
  if (!entryUrl) {
    return reject('react bundle manifest requires a non-empty entryUrl');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(entryUrl);
  } catch {
    return reject('react bundle manifest entryUrl must be an absolute URL');
  }

  if (isExplicitShellOwnedPrivilegedUrl(parsedUrl)) {
    return rejectPolicy(
      'react bundle manifest entryUrl points at a shell-owned privileged path',
    );
  }

  return accept(parsedUrl);
}

function accept(parsedUrl: URL): ReactBundleEntryUrlValidation {
  return {
    ok: true,
    entryUrl: parsedUrl.toString(),
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

function isExplicitShellOwnedPrivilegedUrl(parsedUrl: URL): boolean {
  return (
    isShellOwnedLoopbackOrigin(parsedUrl) &&
    !isPublicWebFixturePath(parsedUrl.pathname) &&
    !isPublicGeneratedReactBundleInlinePath(parsedUrl.pathname)
  );
}

function isShellOwnedLoopbackOrigin(parsedUrl: URL): boolean {
  return (
    parsedUrl.protocol === SHELL_OWNED_RUNTIME_HOST.protocol &&
    parsedUrl.port === SHELL_OWNED_RUNTIME_HOST.port &&
    isLoopbackHostname(parsedUrl.hostname)
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) {
    return false;
  }
  if (normalizedHostname === 'localhost') {
    return true;
  }

  const ipv4 = parseIpv4(normalizedHostname);
  if (ipv4) {
    return isLoopbackIpv4(ipv4);
  }

  const ipv6 = parseIpv6(normalizedHostname);
  if (ipv6) {
    return isLoopbackIpv6(ipv6);
  }

  return false;
}

function normalizeHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  while (normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1);
  }
  const zoneSeparatorIndex = normalized.indexOf('%');
  if (zoneSeparatorIndex !== -1) {
    normalized = normalized.slice(0, zoneSeparatorIndex);
  }
  return normalized;
}

function parseIpv4(hostname: string): Ipv4Octets | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return Number.NaN;
    }
    return Number(part);
  });
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }

  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

function isLoopbackIpv4(octets: Ipv4Octets): boolean {
  return octets[0] === 127;
}

function parseIpv6(hostname: string): Ipv6Segments | null {
  let source = normalizeHostname(hostname);
  if (!source.includes(':')) {
    return null;
  }

  if (source.includes('.')) {
    const lastColonIndex = source.lastIndexOf(':');
    if (lastColonIndex === -1) {
      return null;
    }
    const embeddedIpv4 = parseIpv4(source.slice(lastColonIndex + 1));
    if (!embeddedIpv4) {
      return null;
    }
    const [first, second, third, fourth] = embeddedIpv4;
    source = `${source.slice(0, lastColonIndex)}:${((first << 8) | second).toString(16)}:${((third << 8) | fourth).toString(16)}`;
  }

  const doubleColonParts = source.split('::');
  if (doubleColonParts.length > 2) {
    return null;
  }

  const parseParts = (segment: string): number[] | null => {
    if (segment === '') {
      return [];
    }
    const values = segment.split(':').map((part) => {
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return Number.NaN;
      }
      return Number.parseInt(part, 16);
    });
    if (
      values.some(
        (value) => !Number.isInteger(value) || value < 0 || value > 0xffff,
      )
    ) {
      return null;
    }
    return values;
  };

  const left = parseParts(doubleColonParts[0] ?? '');
  const right = parseParts(doubleColonParts[1] ?? '');
  if (!left || !right) {
    return null;
  }

  if (doubleColonParts.length === 1) {
    return left.length === 8 ? (left as Ipv6Segments) : null;
  }

  if (left.length + right.length >= 8) {
    return null;
  }

  return [
    ...left,
    ...new Array(8 - left.length - right.length).fill(0),
    ...right,
  ] as Ipv6Segments;
}

function isLoopbackIpv6(segments: Ipv6Segments): boolean {
  if (segments.length !== 8) {
    return false;
  }

  if (
    segments[0] === 0 &&
    segments[1] === 0 &&
    segments[2] === 0 &&
    segments[3] === 0 &&
    segments[4] === 0 &&
    segments[5] === 0xffff
  ) {
    return isLoopbackIpv4([
      segments[6] >> 8,
      segments[6] & 0xff,
      segments[7] >> 8,
      segments[7] & 0xff,
    ]);
  }

  return (
    segments[0] === 0 &&
    segments[1] === 0 &&
    segments[2] === 0 &&
    segments[3] === 0 &&
    segments[4] === 0 &&
    segments[5] === 0 &&
    segments[6] === 0 &&
    segments[7] === 1
  );
}

type Ipv4Octets = [number, number, number, number];
type Ipv6Segments = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
