import http from 'node:http';
import https from 'node:https';
import {
  guardedLookupPublicAddress,
  parseHttpUrl,
  type HttpLookup,
} from './http-url-guard.js';

export const REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID =
  'react_bundle_dependency_cdn_v1';
export const REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY =
  'allowlisted_metadata_probe';
export const REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION = 1;

const ALLOWED_HOSTS = new Set(['esm.sh', 'cdn.jsdelivr.net', 'unpkg.com']);

type HttpMetadataProbeReasonCode =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'disallowed_origin'
  | 'unsafe_url'
  | 'unsafe_redirect'
  | 'dns_blocked'
  | 'http_status'
  | 'timeout'
  | 'network_error';

// Production transports should throw this error so policy failures keep their
// classified reasonCode. The generic Error fallback is only for injected tests
// and unexpected runtime exceptions.
export class HttpMetadataProbeRuntimeError extends Error {
  constructor(
    readonly reasonCode: HttpMetadataProbeReasonCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpMetadataProbeRuntimeError';
  }
}

type HttpMetadataProbeMethod = 'HEAD' | 'GET';

interface HttpMetadataProbePolicy {
  name: typeof REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY;
  version: typeof REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION;
  allowlistId: typeof REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID;
}

interface HttpMetadataProbeRedirect {
  fromUrl: string;
  toUrl: string;
  status: number;
}

type HttpMetadataProbeTimingBucket =
  | 'lt_100ms'
  | 'lt_500ms'
  | 'lt_2s'
  | 'gte_2s';

export type HttpMetadataProbeResult =
  | {
      ok: true;
      requestedUrl: string;
      finalUrl: string;
      method: HttpMetadataProbeMethod;
      status: number;
      contentType: string | null;
      contentLength: number | null;
      bytesRead: number;
      timingBucket: HttpMetadataProbeTimingBucket;
      redirectChain: HttpMetadataProbeRedirect[];
      policy: HttpMetadataProbePolicy;
    }
  | {
      ok: false;
      requestedUrl: string;
      finalUrl?: string;
      method?: HttpMetadataProbeMethod;
      status?: number;
      contentType?: string | null;
      contentLength?: number | null;
      bytesRead?: number;
      timingBucket?: HttpMetadataProbeTimingBucket;
      redirectChain: HttpMetadataProbeRedirect[];
      reasonCode: HttpMetadataProbeReasonCode;
      message: string;
      policy: HttpMetadataProbePolicy;
    };

interface HttpMetadataProbeTransportResponse {
  status: number;
  location: string | null;
  contentType: string | null;
  contentLength: number | null;
  bytesRead: number;
}

export type HttpMetadataProbeRequestTransport = (
  url: URL,
  options: {
    method: HttpMetadataProbeMethod;
    lookup?: HttpLookup;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
) => Promise<HttpMetadataProbeTransportResponse>;

export async function probeHttpMetadata(args: {
  url: string;
  lookup?: HttpLookup;
  signal?: AbortSignal;
  now?: () => number;
  totalTimeoutMs?: number;
  transport?: HttpMetadataProbeRequestTransport;
}): Promise<HttpMetadataProbeResult> {
  const now = args.now ?? Date.now;
  const startedAtMs = now();
  return probeWithRedirects({
    requestedUrl: args.url,
    currentUrl: args.url,
    redirectChain: [],
    visitedRedirectUrls: new Set(),
    ...(args.totalTimeoutMs !== undefined
      ? { totalDeadlineMs: startedAtMs + args.totalTimeoutMs }
      : {}),
    startedAtMs,
    now,
    transport: args.transport ?? requestHttpMetadata,
    ...(args.lookup ? { lookup: args.lookup } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
}

async function probeWithRedirects(
  args: ProbeContext,
): Promise<HttpMetadataProbeResult> {
  const parsed = parseHttpUrl(args.currentUrl, {
    label: 'dependency metadata probe URL',
  });
  if (!parsed.ok) {
    return failure(args, {
      reasonCode:
        args.currentUrl === args.requestedUrl
          ? mapInitialUrlReason(parsed.reasonCode, parsed.message)
          : 'unsafe_redirect',
      message: parsed.message,
    });
  }

  if (!isAllowedProbeOrigin(parsed.url)) {
    return failure(args, {
      finalUrl: parsed.url.href,
      reasonCode: 'disallowed_origin',
      message: 'dependency metadata probe URL is outside the allowlist.',
    });
  }

  const headTimeoutMs = remainingTimeout(args);
  if (headTimeoutMs !== undefined && headTimeoutMs <= 0) {
    return failure(args, {
      finalUrl: parsed.url.href,
      reasonCode: 'timeout',
      message: 'dependency metadata probe total timeout exceeded.',
    });
  }

  const head = await requestProbe(args, parsed.url, 'HEAD', headTimeoutMs);
  if (!head.ok) {
    return head.result;
  }
  const headResponse = head.response;

  if (isRedirectStatus(headResponse.status) && headResponse.location) {
    return followRedirect(
      args,
      parsed.url,
      headResponse.status,
      headResponse.location,
    );
  }

  if (headResponse.status === 405) {
    const getTimeoutMs = remainingTimeout(args);
    if (getTimeoutMs !== undefined && getTimeoutMs <= 0) {
      return failure(args, {
        finalUrl: parsed.url.href,
        reasonCode: 'timeout',
        message: 'dependency metadata probe total timeout exceeded.',
      });
    }
    const get = await requestProbe(args, parsed.url, 'GET', getTimeoutMs);
    if (!get.ok) {
      return get.result;
    }
    if (isRedirectStatus(get.response.status) && get.response.location) {
      return followRedirect(
        args,
        parsed.url,
        get.response.status,
        get.response.location,
      );
    }
    return finalizeResponse(args, parsed.url, 'GET', get.response);
  }

  return finalizeResponse(args, parsed.url, 'HEAD', headResponse);
}

async function requestProbe(
  args: ProbeContext,
  url: URL,
  method: HttpMetadataProbeMethod,
  remainingTimeoutMs: number | undefined,
): Promise<
  | { ok: true; response: HttpMetadataProbeTransportResponse }
  | { ok: false; result: HttpMetadataProbeResult }
> {
  try {
    const response = await args.transport(url, {
      method,
      ...(args.lookup ? { lookup: args.lookup } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      ...(remainingTimeoutMs !== undefined
        ? { timeoutMs: remainingTimeoutMs }
        : {}),
    });
    return { ok: true, response };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      result: failure(args, {
        finalUrl: url.href,
        method,
        reasonCode:
          error instanceof HttpMetadataProbeRuntimeError
            ? error.reasonCode
            : message.includes('timeout')
              ? 'timeout'
              : 'network_error',
        message,
      }),
    };
  }
}

function followRedirect(
  args: ProbeContext,
  fromUrl: URL,
  status: number,
  location: string,
): Promise<HttpMetadataProbeResult> | HttpMetadataProbeResult {
  let toUrl: URL;
  try {
    toUrl = new URL(location, fromUrl);
  } catch {
    return failure(args, {
      finalUrl: fromUrl.href,
      reasonCode: 'unsafe_redirect',
      message: 'dependency metadata probe redirect target is invalid.',
    });
  }

  const parsedRedirect = parseHttpUrl(toUrl.href, {
    label: 'dependency metadata probe redirect URL',
  });
  if (!parsedRedirect.ok) {
    return failure(args, {
      finalUrl: fromUrl.href,
      reasonCode: 'unsafe_redirect',
      message: parsedRedirect.message,
    });
  }

  if (!isAllowedProbeOrigin(toUrl)) {
    return failure(args, {
      finalUrl: toUrl.href,
      reasonCode: 'disallowed_origin',
      message:
        'dependency metadata probe redirect target is outside the allowlist.',
    });
  }

  const visitedRedirectUrls = new Set(args.visitedRedirectUrls);
  visitedRedirectUrls.add(fromUrl.href);
  if (visitedRedirectUrls.has(toUrl.href)) {
    return failure(args, {
      finalUrl: toUrl.href,
      reasonCode: 'unsafe_redirect',
      message: 'dependency metadata probe redirect cycle detected.',
    });
  }

  return probeWithRedirects({
    ...args,
    currentUrl: toUrl.href,
    visitedRedirectUrls,
    redirectChain: [
      ...args.redirectChain,
      { fromUrl: fromUrl.href, toUrl: toUrl.href, status },
    ],
  });
}

function finalizeResponse(
  args: ProbeContext,
  url: URL,
  method: HttpMetadataProbeMethod,
  response: HttpMetadataProbeTransportResponse,
): HttpMetadataProbeResult {
  if (response.status < 200 || response.status > 299) {
    return {
      ok: false,
      requestedUrl: args.requestedUrl,
      finalUrl: url.href,
      method,
      status: response.status,
      contentType: response.contentType,
      contentLength: response.contentLength,
      bytesRead: response.bytesRead,
      timingBucket: timingBucket(args.now() - args.startedAtMs),
      redirectChain: args.redirectChain,
      reasonCode: 'http_status',
      message: `dependency metadata probe returned HTTP ${response.status}.`,
      policy: probePolicy(),
    };
  }

  return {
    ok: true,
    requestedUrl: args.requestedUrl,
    finalUrl: url.href,
    method,
    status: response.status,
    contentType: response.contentType,
    contentLength: response.contentLength,
    bytesRead: response.bytesRead,
    timingBucket: timingBucket(args.now() - args.startedAtMs),
    redirectChain: args.redirectChain,
    policy: probePolicy(),
  };
}

function failure(
  args: ProbeContext,
  failureArgs: {
    finalUrl?: string;
    method?: HttpMetadataProbeMethod;
    reasonCode: HttpMetadataProbeReasonCode;
    message: string;
  },
): HttpMetadataProbeResult {
  return {
    ok: false,
    requestedUrl: args.requestedUrl,
    ...(failureArgs.finalUrl ? { finalUrl: failureArgs.finalUrl } : {}),
    ...(failureArgs.method ? { method: failureArgs.method } : {}),
    timingBucket: timingBucket(args.now() - args.startedAtMs),
    redirectChain: args.redirectChain,
    reasonCode: failureArgs.reasonCode,
    message: failureArgs.message,
    policy: probePolicy(),
  };
}

function remainingTimeout(args: ProbeContext): number | undefined {
  return args.totalDeadlineMs === undefined
    ? undefined
    : args.totalDeadlineMs - args.now();
}

function isAllowedProbeOrigin(url: URL): boolean {
  return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname);
}

function mapInitialUrlReason(
  reasonCode: 'invalid_url' | 'unsafe_url',
  message: string,
): HttpMetadataProbeReasonCode {
  // parseHttpUrl intentionally keeps a shared invalid_url/unsafe_url seam.
  // Metadata probing bridges unsupported schemes until the neutral guard grows
  // a richer reason vocabulary.
  if (message.includes('only supports http and https')) {
    return 'unsupported_scheme';
  }
  return reasonCode;
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function timingBucket(elapsedMs: number): HttpMetadataProbeTimingBucket {
  if (elapsedMs < 100) {
    return 'lt_100ms';
  }
  if (elapsedMs < 500) {
    return 'lt_500ms';
  }
  if (elapsedMs < 2000) {
    return 'lt_2s';
  }
  return 'gte_2s';
}

function probePolicy(): HttpMetadataProbePolicy {
  return {
    name: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY,
    version: REACT_BUNDLE_DEPENDENCY_NETWORK_POLICY_VERSION,
    allowlistId: REACT_BUNDLE_DEPENDENCY_CDN_ALLOWLIST_ID,
  };
}

export function requestHttpMetadata(
  url: URL,
  options: {
    method: HttpMetadataProbeMethod;
    lookup?: HttpLookup;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<HttpMetadataProbeTransportResponse> {
  if (options.signal?.aborted) {
    return Promise.reject(
      new HttpMetadataProbeRuntimeError(
        'network_error',
        'dependency metadata probe aborted',
      ),
    );
  }

  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void, cleanup: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const request = client.request(
      url,
      {
        method: options.method,
        ...(options.timeoutMs !== undefined
          ? { timeout: options.timeoutMs }
          : {}),
        headers: {
          accept: '*/*',
          'accept-encoding': 'identity',
          'user-agent': 'geulbat-dependency-metadata-probe/1',
        },
        lookup(hostname, _lookupOptions, callback) {
          void guardedLookupPublicAddress(hostname, {
            ...(options.lookup ? { lookup: options.lookup } : {}),
            label: 'dependency metadata probe',
          })
            .then((record) => {
              callback(null, record.address, record.family);
            })
            .catch((error: unknown) => {
              const message =
                error instanceof Error ? error.message : String(error);
              callback(
                new HttpMetadataProbeRuntimeError('dns_blocked', message),
                '',
                4,
              );
            });
        },
      },
      (response) => {
        finish(() => {
          resolve({
            status: response.statusCode ?? 0,
            location: readHeader(response.headers.location),
            contentType: readHeader(response.headers['content-type']),
            contentLength: readContentLength(
              response.headers['content-length'],
            ),
            bytesRead: 0,
          });
          response.destroy();
        }, cleanup);
        response.on('error', (error) => finish(() => reject(error), cleanup));
      },
    );

    const abort = () =>
      request.destroy(
        new HttpMetadataProbeRuntimeError(
          'network_error',
          'dependency metadata probe aborted',
        ),
      );
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    request.on('timeout', () =>
      request.destroy(
        new HttpMetadataProbeRuntimeError(
          'timeout',
          'dependency metadata probe timeout',
        ),
      ),
    );
    request.on('error', (error) => finish(() => reject(error), cleanup));
    request.end();
  });
}

function readHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function readContentLength(
  value: string | string[] | undefined,
): number | null {
  const header = readHeader(value);
  if (!header) {
    return null;
  }
  const parsed = Number(header);
  return Number.isFinite(parsed) ? parsed : null;
}

interface ProbeContext {
  requestedUrl: string;
  currentUrl: string;
  redirectChain: HttpMetadataProbeRedirect[];
  visitedRedirectUrls: ReadonlySet<string>;
  totalDeadlineMs?: number;
  startedAtMs: number;
  now: () => number;
  transport: HttpMetadataProbeRequestTransport;
  lookup?: HttpLookup;
  signal?: AbortSignal;
}
