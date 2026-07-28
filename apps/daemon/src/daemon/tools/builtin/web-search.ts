import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import https from 'node:https';

import { z } from 'zod';

import type { AgentRuntimeServices } from '../../daemon-runtime-contract.js';
import {
  guardedLookupPublicAddress,
  parseHttpUrl,
  type HttpLookup,
} from '../../network/http-url-guard.js';
import { runDetached } from '../../utils/run-detached.js';
import { defineZodTool } from '../zod-tool.js';

const DUCKDUCKGO_SEARCH_ENDPOINTS = [
  {
    variant: 'html',
    url: new URL('https://html.duckduckgo.com/html/'),
  },
  {
    variant: 'lite',
    url: new URL('https://lite.duckduckgo.com/lite/'),
  },
] as const;

const webSearchArgsSchema = z.strictObject({
  query: z
    .string()
    .min(1, 'query is required.')
    .refine((value) => value.trim().length > 0, {
      message: 'query is required.',
    })
    .describe(
      'Search terms for current public-web discovery. Use fetch_url with a selected result URL to read the page body.',
    ),
});

type WebSearchArgs = z.output<typeof webSearchArgsSchema>;
type WebSearchProvider = 'codex' | 'duckduckgo';
type NativeWebSearchRuntime = NonNullable<
  AgentRuntimeServices['provider']['nativeWebSearch']
>;
type DuckDuckGoVariant =
  (typeof DUCKDUCKGO_SEARCH_ENDPOINTS)[number]['variant'];

interface WebSearchResultCard {
  ref: `web_search_result:sha256:${string}`;
  title: string;
  url: string;
  snippet: string;
  source: string;
}

type WebSearchFailureReason =
  | 'provider_not_available'
  | 'provider_not_configured'
  | 'provider_unauthorized'
  | 'provider_rate_limited'
  | 'provider_error'
  | 'invalid_response'
  | 'network_error'
  | 'aborted';

interface WebSearchProviderAttempt {
  provider: WebSearchProvider;
  status: 'failed' | 'skipped';
  reasonCode: WebSearchFailureReason;
  message: string;
  endpoint?: DuckDuckGoVariant;
}

interface WebSearchSuccess {
  ok: true;
  provider: WebSearchProvider;
  providerVariant?: DuckDuckGoVariant;
  query: string;
  answer?: string;
  results: WebSearchResultCard[];
  resultCount: number;
  attempts: WebSearchProviderAttempt[];
  untrusted: true;
}

interface WebSearchFailure {
  ok: false;
  provider: WebSearchProvider;
  query: string;
  reasonCode: WebSearchFailureReason;
  message: string;
  attempts: WebSearchProviderAttempt[];
  untrusted: true;
}

type WebSearchOutput = WebSearchSuccess | WebSearchFailure;

interface WebSearchHttpResponse {
  status: number;
  body: Buffer;
}

interface WebSearchHttpRequest {
  url: URL;
  method: 'POST';
  headers: Record<string, string>;
  body: Buffer;
  lookup?: HttpLookup;
  signal?: AbortSignal;
}

type WebSearchHttpTransport = (
  args: WebSearchHttpRequest,
) => Promise<WebSearchHttpResponse>;

export async function searchWeb(args: {
  query: string;
  nativeSearch?: {
    model: string;
    runtime: NativeWebSearchRuntime;
    providerSessionId: string;
  };
  duckDuckGoRequest?: WebSearchHttpTransport;
  lookup?: HttpLookup;
  signal?: AbortSignal;
}): Promise<WebSearchOutput> {
  const query = args.query.trim();
  const attempts: WebSearchProviderAttempt[] = [];

  if (isSearchAborted(args.signal)) {
    return webSearchFailure({
      provider: args.nativeSearch === undefined ? 'duckduckgo' : 'codex',
      query,
      reasonCode: 'aborted',
      message: 'web_search was aborted.',
      attempts,
    });
  }

  if (args.nativeSearch === undefined) {
    attempts.push({
      provider: 'codex',
      status: 'skipped',
      reasonCode: 'provider_not_available',
      message:
        'Codex native web search is unavailable because the active run is not using the Codex OAuth provider.',
    });
  } else {
    const response = await args.nativeSearch.runtime.search({
      query,
      model: args.nativeSearch.model,
      providerSessionId: args.nativeSearch.providerSessionId,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    if (!response.ok) {
      if (response.reasonCode === 'aborted' || isSearchAborted(args.signal)) {
        return webSearchFailure({
          provider: 'codex',
          query,
          reasonCode: 'aborted',
          message: 'web_search was aborted.',
          attempts,
        });
      }
      attempts.push({
        provider: 'codex',
        status: 'failed',
        reasonCode: response.reasonCode,
        message: response.message,
      });
    } else {
      const results = response.results.flatMap((entry) => {
        const resultUrl = readPublicResultUrl(entry.url);
        if (resultUrl === undefined) {
          return [];
        }
        const title = normalizeSearchText(entry.title);
        return [
          createResultCard({
            url: resultUrl,
            title: title || resultUrl.hostname,
            snippet: normalizeSearchText(entry.snippet),
          }),
        ];
      });
      const answer = response.answer?.trim() ?? '';
      if (answer.length === 0 && results.length === 0) {
        attempts.push({
          provider: 'codex',
          status: 'failed',
          reasonCode: 'invalid_response',
          message:
            'Codex native web search returned no readable answer or source URLs.',
        });
      } else {
        return {
          ok: true,
          provider: 'codex',
          query,
          ...(answer.length === 0 ? {} : { answer }),
          results,
          resultCount: results.length,
          attempts,
          untrusted: true,
        };
      }
    }
  }

  const request = args.duckDuckGoRequest ?? requestPublicWebSearch;
  for (const endpoint of DUCKDUCKGO_SEARCH_ENDPOINTS) {
    let response: WebSearchHttpResponse;
    try {
      response = await request({
        url: endpoint.url,
        method: 'POST',
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'accept-encoding': 'identity',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'geulbat-web-search/1',
        },
        body: Buffer.from(new URLSearchParams({ q: query }).toString(), 'utf8'),
        ...(args.lookup === undefined ? {} : { lookup: args.lookup }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
      });
    } catch {
      if (isSearchAborted(args.signal)) {
        return webSearchFailure({
          provider: 'duckduckgo',
          query,
          reasonCode: 'aborted',
          message: 'web_search was aborted.',
          attempts,
        });
      }
      attempts.push({
        provider: 'duckduckgo',
        endpoint: endpoint.variant,
        status: 'failed',
        reasonCode: 'network_error',
        message: 'DuckDuckGo search request failed.',
      });
      continue;
    }

    const failure = classifyDuckDuckGoHttpFailure(response.status);
    if (failure !== undefined) {
      attempts.push({
        provider: 'duckduckgo',
        endpoint: endpoint.variant,
        status: 'failed',
        ...failure,
      });
      continue;
    }

    const results = readDuckDuckGoSearchCards(
      response.body.toString('utf8'),
      endpoint.url,
    );
    if (results.length === 0) {
      attempts.push({
        provider: 'duckduckgo',
        endpoint: endpoint.variant,
        status: 'failed',
        reasonCode: 'invalid_response',
        message: `DuckDuckGo ${endpoint.variant} search returned no readable public results.`,
      });
      continue;
    }

    return {
      ok: true,
      provider: 'duckduckgo',
      providerVariant: endpoint.variant,
      query,
      results,
      resultCount: results.length,
      attempts,
      untrusted: true,
    };
  }

  const terminal =
    attempts.at(-1) ??
    ({
      provider: 'duckduckgo',
      status: 'failed',
      reasonCode: 'provider_error',
      message: 'No web search provider completed the request.',
    } satisfies WebSearchProviderAttempt);
  return webSearchFailure({
    provider: 'duckduckgo',
    query,
    reasonCode: terminal.reasonCode,
    message: terminal.message,
    attempts,
  });
}

export function createWebSearchTool(
  deps: {
    searchWeb?: typeof searchWeb;
  } = {},
) {
  const runSearch = deps.searchWeb ?? searchWeb;

  return defineZodTool({
    name: 'web_search',
    description:
      'Search the current public web by query. Uses the active Codex OAuth session when available, then visibly falls back to keyless DuckDuckGo HTML search. Returns compact untrusted result cards with stable refs, titles, URLs, and snippets. Use fetch_url with a selected URL to read the full page text.',
    argsSchema: webSearchArgsSchema,
    sideEffectLevel: 'read',
    mayMutateComputerFiles: false,
    requiresApproval: false,
    recoveryStrategy: 'replay_safe',
    resultProjection: {
      exactDurableRecovery: true,
      modelProjection: 'runtime_summary',
      snapshotFailure: 'fail_closed',
    },
    catalogSearchMetadata: {
      family: 'network',
      searchHints: [
        'web search',
        'search internet',
        'find current information',
        'look up online',
      ],
      tags: ['network', 'web', 'search'],
      whenToUse:
        'Discover current public-web sources from search terms before opening selected pages.',
      notFor:
        'Opening a known URL, reading full page bodies, or searching local files.',
    },
    async executeParsed(args: WebSearchArgs, ctx) {
      const provider = ctx.runtimeServices?.provider;
      const selectedProvider = ctx.providerRunSelection?.providerModel;
      const nativeSearch =
        selectedProvider?.providerId !== 'openai_codex_direct' ||
        provider?.nativeWebSearch === undefined
          ? undefined
          : {
              model: selectedProvider.model,
              runtime: provider.nativeWebSearch,
              providerSessionId: ctx.runId ?? ctx.callId,
            };
      const output = await runSearch({
        query: args.query,
        ...(nativeSearch === undefined ? {} : { nativeSearch }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      if (!output.ok) {
        return {
          ok: false,
          output: JSON.stringify(output),
          errorCode: webSearchFailureToolErrorCode(output.reasonCode),
          error: output.message,
        };
      }
      return {
        ok: true,
        output: JSON.stringify(output),
      };
    },
  });
}

export const webSearchTool = createWebSearchTool();

function classifyDuckDuckGoHttpFailure(
  status: number,
): Pick<WebSearchProviderAttempt, 'reasonCode' | 'message'> | undefined {
  if (status === 429) {
    return {
      reasonCode: 'provider_rate_limited',
      message: 'DuckDuckGo search rate limit was reached.',
    };
  }
  if (status < 200 || status >= 300) {
    return {
      reasonCode: 'provider_error',
      message: `DuckDuckGo search returned HTTP ${status}.`,
    };
  }
  return undefined;
}

function readDuckDuckGoSearchCards(
  html: string,
  endpoint: URL,
): WebSearchResultCard[] {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/giu)];
  const results: WebSearchResultCard[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < anchors.length; index += 1) {
    const match = anchors[index];
    if (match === undefined) {
      continue;
    }
    const attributes = match[1] ?? '';
    const className = readHtmlAttribute(attributes, 'class') ?? '';
    const rel = readHtmlAttribute(attributes, 'rel') ?? '';
    if (
      !className.split(/\s+/u).includes('result__a') &&
      !rel.split(/\s+/u).includes('nofollow')
    ) {
      continue;
    }
    const href = readHtmlAttribute(attributes, 'href');
    const resultUrl =
      href === undefined ? undefined : readDuckDuckGoResultUrl(href, endpoint);
    if (resultUrl === undefined || seen.has(resultUrl.href)) {
      continue;
    }
    const title = normalizeSearchText(match[2] ?? '');
    if (title.length === 0) {
      continue;
    }
    const currentEnd = (match.index ?? 0) + match[0].length;
    let nextStart = html.length;
    for (
      let nextIndex = index + 1;
      nextIndex < anchors.length;
      nextIndex += 1
    ) {
      const nextMatch = anchors[nextIndex];
      if (nextMatch === undefined) {
        continue;
      }
      const nextAttributes = nextMatch[1] ?? '';
      const nextClassName = readHtmlAttribute(nextAttributes, 'class') ?? '';
      const nextRel = readHtmlAttribute(nextAttributes, 'rel') ?? '';
      if (
        nextClassName.split(/\s+/u).includes('result__a') ||
        nextRel.split(/\s+/u).includes('nofollow')
      ) {
        nextStart = nextMatch.index ?? html.length;
        break;
      }
    }
    const trailingHtml = html.slice(currentEnd, nextStart);
    const snippetMatch = trailingHtml.match(
      /<(?:a|div|td)\b[^>]*class=(?:"[^"]*(?:result__snippet|result-snippet)[^"]*"|'[^']*(?:result__snippet|result-snippet)[^']*')[^>]*>([\s\S]*?)<\/(?:a|div|td)>/iu,
    );
    seen.add(resultUrl.href);
    results.push(
      createResultCard({
        url: resultUrl,
        title,
        snippet: normalizeSearchText(snippetMatch?.[1] ?? ''),
      }),
    );
  }

  return results;
}

function readHtmlAttribute(
  attributes: string,
  name: string,
): string | undefined {
  const pattern = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'iu',
  );
  const match = attributes.match(pattern);
  return match?.[1] ?? match?.[2];
}

function readDuckDuckGoResultUrl(
  value: string,
  endpoint: URL,
): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(decodeSearchEntities(value), endpoint);
  } catch {
    return undefined;
  }
  if (
    parsed.hostname === 'duckduckgo.com' ||
    parsed.hostname.endsWith('.duckduckgo.com')
  ) {
    const redirected = parsed.searchParams.get('uddg');
    if (!redirected) {
      return undefined;
    }
    return readPublicResultUrl(redirected);
  }
  return readPublicResultUrl(parsed.href);
}

function requestPublicWebSearch(
  args: WebSearchHttpRequest,
): Promise<WebSearchHttpResponse> {
  if (isSearchAborted(args.signal)) {
    return Promise.reject(new Error('web_search aborted'));
  }

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
    const request = https.request(
      args.url,
      {
        method: args.method,
        headers: args.headers,
        lookup(hostname, lookupOptions, callback) {
          runDetached('tools/web-search-lookup', () =>
            guardedLookupPublicAddress(hostname, {
              label: 'web_search provider',
              ...(args.lookup === undefined ? {} : { lookup: args.lookup }),
            })
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
              }),
          );
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
    const abort = () => request.destroy(new Error('web_search aborted'));
    const cleanup = () => {
      args.signal?.removeEventListener('abort', abort);
    };
    args.signal?.addEventListener('abort', abort, { once: true });
    request.on('error', (error) => {
      finish(() => reject(error), cleanup);
    });
    request.end(args.body);
  });
}

function readPublicResultUrl(value: string): URL | undefined {
  const parsed = parseHttpUrl(value, {
    label: 'web_search result URL',
    protocolLabel: 'web_search result',
  });
  return parsed.ok ? parsed.url : undefined;
}

function isSearchAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function createResultCard(args: {
  url: URL;
  title: string;
  snippet: string;
}): WebSearchResultCard {
  return {
    ref: createWebSearchResultRef(args.url.href),
    title: args.title,
    url: args.url.href,
    snippet: args.snippet,
    source: args.url.hostname,
  };
}

function createWebSearchResultRef(
  url: string,
): `web_search_result:sha256:${string}` {
  return `web_search_result:sha256:${createHash('sha256')
    .update(url, 'utf8')
    .digest('hex')}`;
}

function normalizeSearchText(value: string): string {
  return decodeSearchEntities(value.replaceAll(/<[^>]*>/gu, ' '))
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

function decodeSearchEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#([0-9]+);/gu, (_match, decimal: string) =>
      readCodePoint(decimal, 10),
    )
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) =>
      readCodePoint(hex, 16),
    );
}

function readCodePoint(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff
  ) {
    return '';
  }
  return String.fromCodePoint(codePoint);
}

function webSearchFailure(args: {
  provider: WebSearchProvider;
  query: string;
  reasonCode: WebSearchFailureReason;
  message: string;
  attempts: WebSearchProviderAttempt[];
}): WebSearchFailure {
  return {
    ok: false,
    provider: args.provider,
    query: args.query,
    reasonCode: args.reasonCode,
    message: args.message,
    attempts: args.attempts,
    untrusted: true,
  };
}

function webSearchFailureToolErrorCode(
  reasonCode: WebSearchFailureReason,
):
  | 'provider_auth_not_configured'
  | 'unauthorized'
  | 'rate_limited'
  | 'aborted'
  | 'execution_failed' {
  switch (reasonCode) {
    case 'provider_not_configured':
      return 'provider_auth_not_configured';
    case 'provider_unauthorized':
      return 'unauthorized';
    case 'provider_rate_limited':
      return 'rate_limited';
    case 'aborted':
      return 'aborted';
    case 'provider_not_available':
    case 'provider_error':
    case 'invalid_response':
    case 'network_error':
      return 'execution_failed';
  }
}
