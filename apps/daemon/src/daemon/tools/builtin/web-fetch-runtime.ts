import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';
import {
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_MAX_RESPONSE_BYTES,
  WEB_FETCH_REQUEST_TIMEOUT_MS,
  WEB_FETCH_TOTAL_TIMEOUT_MS,
} from './web-fetch-policy.js';
import {
  guardedLookupPublicAddress,
  parseWebFetchHttpUrl,
} from './web-fetch-url-guard.js';
import type { WebFetchFailureReasonCode } from './web-fetch-result.js';
import {
  webFetchFailure,
  type WebFetchOutput,
  type WebFetchSuccess,
} from './web-fetch-result.js';
import type { WebFetchLookup } from './web-fetch-url-guard.js';

export interface WebFetchHttpResponse {
  status: number;
  location: string | null;
  contentType: string | null;
  body: Buffer;
}

export class WebFetchRuntimeError extends Error {
  constructor(
    readonly reasonCode: WebFetchFailureReasonCode,
    message: string,
  ) {
    super(message);
  }
}

export type WebFetchExtractMode = 'text' | 'markdown';

export type WebFetchTransport = (
  url: URL,
  options: {
    lookup?: WebFetchLookup;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
) => Promise<WebFetchHttpResponse>;

export async function fetchWebUrl(args: {
  url: string;
  extractMode: WebFetchExtractMode;
  maxChars: number;
  lookup?: WebFetchLookup;
  signal?: AbortSignal;
  now?: () => number;
  requestWebFetchUrl?: WebFetchTransport;
}): Promise<WebFetchOutput> {
  const now = args.now ?? Date.now;
  return fetchWebUrlWithRedirects({
    ...args,
    originalUrl: args.url,
    redirectsRemaining: WEB_FETCH_MAX_REDIRECTS,
    totalDeadlineMs: now() + WEB_FETCH_TOTAL_TIMEOUT_MS,
    now,
    requestWebFetchUrl: args.requestWebFetchUrl ?? requestWebFetchUrl,
  });
}

async function fetchWebUrlWithRedirects(args: {
  originalUrl: string;
  url: string;
  extractMode: WebFetchExtractMode;
  maxChars: number;
  redirectsRemaining: number;
  totalDeadlineMs: number;
  now: () => number;
  lookup?: WebFetchLookup;
  signal?: AbortSignal;
  requestWebFetchUrl: WebFetchTransport;
}): Promise<WebFetchOutput> {
  const remainingTimeoutMs = args.totalDeadlineMs - args.now();
  if (remainingTimeoutMs <= 0) {
    return webFetchFailure({
      url: args.originalUrl,
      finalUrl: args.url,
      reasonCode: 'timeout',
      message: 'web_fetch total timeout exceeded.',
    });
  }

  const parsed = parseWebFetchHttpUrl(args.url);
  if (!parsed.ok) {
    return webFetchFailure({
      url: args.originalUrl,
      finalUrl: args.url,
      reasonCode:
        args.url === args.originalUrl ? parsed.reasonCode : 'unsafe_redirect',
      message: parsed.message,
    });
  }

  let response: WebFetchHttpResponse;
  try {
    response = await args.requestWebFetchUrl(parsed.url, {
      ...(args.lookup ? { lookup: args.lookup } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      timeoutMs: Math.min(WEB_FETCH_REQUEST_TIMEOUT_MS, remainingTimeoutMs),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return webFetchFailure({
      url: args.originalUrl,
      finalUrl: parsed.url.href,
      reasonCode:
        error instanceof WebFetchRuntimeError
          ? error.reasonCode
          : message.includes('timeout')
            ? 'timeout'
            : 'network_error',
      message,
    });
  }

  if (isRedirectStatus(response.status) && response.location) {
    if (args.redirectsRemaining <= 0) {
      return webFetchFailure({
        url: args.originalUrl,
        finalUrl: parsed.url.href,
        reasonCode: 'redirect_limit_exceeded',
        message: 'web_fetch redirect count exceeded.',
      });
    }

    let nextUrl: string;
    try {
      nextUrl = new URL(response.location, parsed.url).href;
    } catch {
      return webFetchFailure({
        url: args.originalUrl,
        finalUrl: parsed.url.href,
        reasonCode: 'unsafe_redirect',
        message: 'web_fetch redirect target is not a valid URL.',
      });
    }

    return fetchWebUrlWithRedirects({
      ...args,
      url: nextUrl,
      redirectsRemaining: args.redirectsRemaining - 1,
    });
  }

  if (!isSupportedTextContentType(response.contentType)) {
    return webFetchFailure({
      url: args.originalUrl,
      finalUrl: parsed.url.href,
      reasonCode: 'unsupported_content_type',
      message: `web_fetch does not support content type: ${response.contentType ?? 'unknown'}.`,
    });
  }

  const rawText = response.body.toString('utf8');
  const text = extractResponseText(
    rawText,
    response.contentType,
    args.extractMode,
  );
  const content = text.slice(0, args.maxChars);
  const truncated = text.length > args.maxChars;
  const success: WebFetchSuccess = {
    ok: true,
    url: args.originalUrl,
    finalUrl: parsed.url.href,
    status: response.status,
    contentType: response.contentType,
    ...readHtmlTitle(rawText),
    content,
    truncated,
    ...(truncated ? { truncationReason: 'max_chars' as const } : {}),
    untrusted: true,
  };
  return success;
}

export function requestWebFetchUrl(
  url: URL,
  options: {
    lookup?: WebFetchLookup;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<WebFetchHttpResponse> {
  if (options.signal?.aborted) {
    return Promise.reject(
      new WebFetchRuntimeError('aborted', 'web_fetch aborted'),
    );
  }

  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void, cleanup: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const request = client.request(
      url,
      {
        method: 'GET',
        timeout: options.timeoutMs ?? WEB_FETCH_REQUEST_TIMEOUT_MS,
        headers: {
          accept:
            'text/html,text/plain,application/json,application/xml,application/xhtml+xml,application/rss+xml,application/atom+xml;q=0.9,*/*;q=0.1',
          'accept-encoding': 'identity',
          'user-agent': 'geulbat-web-fetch/1',
        },
        lookup(hostname, _lookupOptions, callback) {
          void guardedLookupPublicAddress(
            hostname,
            options.lookup ? { lookup: options.lookup } : {},
          )
            .then((record) => {
              callback(null, record.address, record.family);
            })
            .catch((error: unknown) => {
              callback(
                error instanceof Error ? error : new Error(String(error)),
                '',
                4,
              );
            });
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on('data', (chunk: Buffer) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > WEB_FETCH_MAX_RESPONSE_BYTES) {
            request.destroy(
              new WebFetchRuntimeError(
                'response_too_large',
                'web_fetch response byte budget exceeded',
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          finish(
            () =>
              resolve({
                status: response.statusCode ?? 0,
                location: readHeader(response.headers.location),
                contentType: readHeader(response.headers['content-type']),
                body: Buffer.concat(chunks),
              }),
            cleanup,
          );
        });
        response.on('error', (error) => {
          finish(() => reject(error), cleanup);
        });
      },
    );

    const abort = () =>
      request.destroy(new WebFetchRuntimeError('aborted', 'web_fetch aborted'));
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    request.on('timeout', () =>
      request.destroy(new WebFetchRuntimeError('timeout', 'web_fetch timeout')),
    );
    request.on('error', (error) => {
      finish(() => reject(error), cleanup);
    });
    request.end();
  });
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function isSupportedTextContentType(value: string | null): boolean {
  if (value === null) return false;
  const mediaType = value.split(';', 1)[0]?.trim().toLocaleLowerCase();
  return (
    mediaType === 'application/json' ||
    mediaType === 'application/xml' ||
    mediaType === 'application/xhtml+xml' ||
    mediaType === 'application/rss+xml' ||
    mediaType === 'application/atom+xml' ||
    mediaType === 'text/html' ||
    mediaType?.startsWith('text/') === true
  );
}

function extractResponseText(
  rawText: string,
  contentType: string | null,
  extractMode: WebFetchExtractMode,
): string {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLocaleLowerCase();
  if (mediaType !== 'text/html' && mediaType !== 'application/xhtml+xml') {
    return rawText;
  }

  // Both text and markdown modes use the same conservative first-slice HTML
  // extraction: no scripts, no subresource loads, no browser execution.
  void extractMode;
  return rawText
    .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
    .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replaceAll(/<[^>]+>/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

function readHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function readHtmlTitle(text: string): { title?: string } {
  const match = /<title[^>]*>([^<]*)<\/title>/iu.exec(text);
  const title = match?.[1]?.replaceAll(/\s+/gu, ' ').trim();
  return title ? { title } : {};
}
