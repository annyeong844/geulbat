import { DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN } from './artifact-runtime-host.js';
import { isPublicWebFixturePath } from './public-web-fixtures.js';
import { isPublicGeneratedReactBundleInlinePath } from './react-bundle-inline-compile.js';

const SHELL_OWNED_RUNTIME_HOST = new URL(DEFAULT_ARTIFACT_RUNTIME_HOST_ORIGIN);

export type ReactBundleRuntimeUrlPolicyFailureReason =
  | 'empty'
  | 'malformed'
  | 'unsupported_scheme'
  | 'shell_owned_privileged';

export type ReactBundleRuntimeUrlPolicyResult =
  | { ok: true; url: string }
  | { ok: false; reasonCode: ReactBundleRuntimeUrlPolicyFailureReason };

export function validateReactBundleRuntimeUrlPolicy(
  rawUrl: string,
): ReactBundleRuntimeUrlPolicyResult {
  const url = rawUrl.trim();
  if (!url) {
    return { ok: false, reasonCode: 'empty' };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, reasonCode: 'malformed' };
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ok: false, reasonCode: 'unsupported_scheme' };
  }

  if (isExplicitShellOwnedPrivilegedUrl(parsedUrl)) {
    return { ok: false, reasonCode: 'shell_owned_privileged' };
  }

  return {
    ok: true,
    url: parsedUrl.toString(),
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

type Ipv4Octets = readonly [number, number, number, number];
type Ipv6Segments = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

function parseIpv4(hostname: string): Ipv4Octets | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) {
    return null;
  }

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/u.test(part)) {
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
      if (!/^[0-9a-f]{1,4}$/u.test(part)) {
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

  const fill =
    doubleColonParts.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || (doubleColonParts.length === 1 && left.length !== 8)) {
    return null;
  }

  const segments = [...left, ...Array(fill).fill(0), ...right];
  if (segments.length !== 8) {
    return null;
  }

  const [first, second, third, fourth, fifth, sixth, seventh, eighth] =
    segments;
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    fifth === undefined ||
    sixth === undefined ||
    seventh === undefined ||
    eighth === undefined
  ) {
    return null;
  }

  return [first, second, third, fourth, fifth, sixth, seventh, eighth];
}

function isLoopbackIpv6(segments: Ipv6Segments): boolean {
  const isLoopback =
    segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1;
  if (isLoopback) {
    return true;
  }

  const isIpv4Mapped =
    segments.slice(0, 5).every((segment) => segment === 0) &&
    segments[5] === 0xffff;
  if (!isIpv4Mapped) {
    return false;
  }

  const first = segments[6] >> 8;
  const second = segments[6] & 0xff;
  const third = segments[7] >> 8;
  const fourth = segments[7] & 0xff;
  return isLoopbackIpv4([first, second, third, fourth]);
}
