import type { Buffer } from 'node:buffer';
import { parseWebFetchHttpUrl } from './web-fetch-url-guard.js';
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
    requestWebFetchUrl: args.requestWebFetchUrl ?? unavailableWebFetchTransport,
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
        args.signal?.aborted === true
          ? 'aborted'
          : error instanceof WebFetchRuntimeError
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
  const content = normalizeLineEndings(text);
  const success: WebFetchSuccess = {
    ok: true,
    url: args.originalUrl,
    finalUrl: parsed.url.href,
    status: response.status,
    contentType: response.contentType,
    ...readHtmlTitle(rawText),
    content,
    contentFormat: 'line_preserved_text_v1',
    contentLineCount: countTextLines(content),
    untrusted: true,
  };
  return success;
}

function unavailableWebFetchTransport(): Promise<WebFetchHttpResponse> {
  return Promise.reject(
    new WebFetchRuntimeError(
      'network_error',
      'Host-routed public HTTP transport is unavailable.',
    ),
  );
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

  // Both text and markdown modes use the same conservative HTML extraction:
  // no scripts, no subresource loads, and no browser execution. Block
  // boundaries stay as lines so a caller can inspect the complete text in
  // source order instead of receiving one flattened paragraph.
  void extractMode;
  return normalizeHtmlTextLines(
    readHtmlBody(rawText)
      .replaceAll(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ')
      .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
      .replaceAll(/<br\b[^>]*\/?>/giu, '\n')
      .replaceAll(
        /<\/(?:address|article|aside|blockquote|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)>/giu,
        '\n',
      )
      .replaceAll(/<[^>]+>/gu, ' ')
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'"),
  );
}

function readHtmlBody(value: string): string {
  return /<body\b[^>]*>([\s\S]*?)<\/body>/iu.exec(value)?.[1] ?? value;
}

function normalizeHtmlTextLines(value: string): string {
  return normalizeLineEndings(value)
    .split('\n')
    .map((line) =>
      line
        .replaceAll(/[^\S\n]+/gu, ' ')
        .replaceAll(/\s+([,.;:!?])/gu, '$1')
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join('\n');
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll(/\r\n?/gu, '\n');
}

function countTextLines(value: string): number {
  return value.length === 0 ? 0 : value.split('\n').length;
}

function readHtmlTitle(text: string): { title?: string } {
  const match = /<title[^>]*>([^<]*)<\/title>/iu.exec(text);
  const title = match?.[1]?.replaceAll(/\s+/gu, ' ').trim();
  return title ? { title } : {};
}
