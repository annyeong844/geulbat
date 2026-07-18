import { Buffer } from 'node:buffer';
import http from 'node:http';
import https from 'node:https';
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

interface WebFetchHttpResponse {
  status: number;
  location: string | null;
  contentType: string | null;
  body: Buffer;
}

class WebFetchRuntimeError extends Error {
  constructor(
    readonly reasonCode: WebFetchFailureReasonCode,
    message: string,
  ) {
    super(message);
  }
}

type WebFetchExtractMode = 'text' | 'markdown';

type WebFetchTransport = (
  url: URL,
  options: {
    lookup?: WebFetchLookup;
    signal?: AbortSignal;
  },
) => Promise<WebFetchHttpResponse>;

export async function fetchWebUrl(args: {
  url: string;
  extractMode: WebFetchExtractMode;
  lookup?: WebFetchLookup;
  signal?: AbortSignal;
  requestWebFetchUrl?: WebFetchTransport;
}): Promise<WebFetchOutput> {
  return fetchWebUrlWithRedirects({
    ...args,
    originalUrl: args.url,
    visitedUrls: new Set<string>(),
    requestWebFetchUrl: args.requestWebFetchUrl ?? requestWebFetchUrl,
  });
}

async function fetchWebUrlWithRedirects(args: {
  originalUrl: string;
  url: string;
  extractMode: WebFetchExtractMode;
  visitedUrls: ReadonlySet<string>;
  lookup?: WebFetchLookup;
  signal?: AbortSignal;
  requestWebFetchUrl: WebFetchTransport;
}): Promise<WebFetchOutput> {
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

  if (args.visitedUrls.has(parsed.url.href)) {
    return webFetchFailure({
      url: args.originalUrl,
      finalUrl: parsed.url.href,
      reasonCode: 'redirect_loop_detected',
      message: 'fetch_url redirect loop detected.',
    });
  }
  const visitedUrls = new Set(args.visitedUrls);
  visitedUrls.add(parsed.url.href);

  let response: WebFetchHttpResponse;
  try {
    response = await args.requestWebFetchUrl(parsed.url, {
      ...(args.lookup ? { lookup: args.lookup } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
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
    let nextUrl: string;
    try {
      nextUrl = new URL(response.location, parsed.url).href;
    } catch {
      return webFetchFailure({
        url: args.originalUrl,
        finalUrl: parsed.url.href,
        reasonCode: 'unsafe_redirect',
        message: 'fetch_url redirect target is not a valid URL.',
      });
    }

    return fetchWebUrlWithRedirects({
      ...args,
      url: nextUrl,
      visitedUrls,
    });
  }

  if (!isSupportedTextContentType(response.contentType)) {
    return webFetchFailure({
      url: args.originalUrl,
      finalUrl: parsed.url.href,
      reasonCode: 'unsupported_content_type',
      message: `fetch_url does not support content type: ${response.contentType ?? 'unknown'}.`,
    });
  }

  const rawText = response.body.toString('utf8');
  const text = extractResponseText(
    rawText,
    response.contentType,
    args.extractMode,
  );
  const success: WebFetchSuccess = {
    ok: true,
    url: args.originalUrl,
    finalUrl: parsed.url.href,
    status: response.status,
    contentType: response.contentType,
    ...readHtmlTitle(rawText),
    content: text,
    untrusted: true,
  };
  return success;
}

export function requestWebFetchUrl(
  url: URL,
  options: {
    lookup?: WebFetchLookup;
    signal?: AbortSignal;
  },
): Promise<WebFetchHttpResponse> {
  if (options.signal?.aborted) {
    return Promise.reject(
      new WebFetchRuntimeError('aborted', 'fetch_url aborted'),
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
        method: 'GET',
        headers: {
          accept:
            'text/html,text/plain,application/json,application/xml,application/xhtml+xml,application/rss+xml,application/atom+xml;q=0.9,*/*;q=0.1',
          'accept-encoding': 'identity',
          'user-agent': 'geulbat-fetch-url/1',
        },
        lookup(hostname, lookupOptions, callback) {
          void guardedLookupPublicAddress(
            hostname,
            options.lookup ? { lookup: options.lookup } : {},
          )
            .then((record) => {
              if (lookupOptions.all) {
                callback(null, [record]);
                return;
              }
              callback(null, record.address, record.family);
            })
            .catch((error: unknown) => {
              const lookupError =
                error instanceof Error ? error : new Error(String(error));
              if (lookupOptions.all) {
                callback(lookupError, []);
                return;
              }
              callback(lookupError, '', 4);
            });
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
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
      request.destroy(new WebFetchRuntimeError('aborted', 'fetch_url aborted'));
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
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
  if (value === null) {
    return false;
  }
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
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function readHtmlTitle(text: string): { title?: string } {
  const match = /<title[^>]*>([^<]*)<\/title>/iu.exec(text);
  const title = match?.[1]?.replaceAll(/\s+/gu, ' ').trim();
  return title ? { title } : {};
}
