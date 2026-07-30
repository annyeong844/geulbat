import { Buffer } from 'node:buffer';

import { z } from 'zod';

import type { PublicHttpReadRuntime } from '../../utils/public-http-read-port.js';
import { defineZodTool } from '../zod-tool.js';
import {
  stringifyWebFetchOutput,
  webFetchFailureToolErrorCode,
} from './web-fetch-result.js';
import { fetchWebUrl as defaultFetchWebUrl } from './web-fetch-runtime.js';

const webFetchArgsSchema = z.strictObject({
  url: z
    .string()
    .min(1, 'url is required.')
    .describe('Absolute http or https URL to fetch.'),
  extractMode: z
    .enum(['text', 'markdown'])
    .optional()
    .describe(
      'Extraction mode. Defaults to text. Markdown is best-effort text extraction in this slice.',
    ),
});

type WebFetchArgs = z.output<typeof webFetchArgsSchema>;

export function createFetchUrlTool(
  deps: {
    fetchWebUrl?: typeof defaultFetchWebUrl;
    publicHttpRead?: PublicHttpReadRuntime;
  } = {},
) {
  const fetchWebUrl = deps.fetchWebUrl ?? defaultFetchWebUrl;
  return defineZodTool({
    name: 'fetch_url',
    description:
      'Fetch one public HTTP(S) URL as complete untrusted text with HTML block boundaries preserved as lines. Large results use the shared durable output reference. Does not search, browse with cookies, or fetch local/private network URLs.',
    argsSchema: webFetchArgsSchema,
    sideEffectLevel: 'read',
    mayMutateComputerFiles: false,
    requiresApproval: false,
    recoveryStrategy: 'replay_safe',
    resultProjection: {
      exactDurableRecovery: true,
      modelProjection: 'fetch_url_summary',
      snapshotFailure: 'fail_closed',
    },
    exposure: {
      directHot: true,
      sdkVisible: true,
      inCellCallable: true,
      directOnly: false,
      effectClass: 'readOnly',
    },
    catalogSearchMetadata: {
      family: 'network',
      searchHints: ['open url', 'fetch url', 'curl url', 'read webpage'],
      tags: ['network', 'url', 'read'],
      whenToUse: 'Read one explicit public HTTP(S) URL.',
      notFor:
        'Query-based web search, browser automation, cookies, or private network URLs.',
    },
    async executeParsed(args: WebFetchArgs, ctx) {
      const runtimeServices = ctx.runtimeServices;
      const publicHttpRead =
        deps.publicHttpRead ?? runtimeServices?.publicHttpRead;
      const requestWebFetchUrl =
        publicHttpRead === undefined
          ? undefined
          : async (url: URL, options: { signal?: AbortSignal }) => {
              const response = await publicHttpRead.request({
                url: url.href,
                method: 'GET',
                headers: {
                  accept:
                    'text/html,text/plain,application/json,application/xml,application/xhtml+xml,application/rss+xml,application/atom+xml;q=0.9,*/*;q=0.1',
                  'accept-encoding': 'identity',
                  'user-agent': 'geulbat-fetch-url/1',
                },
                responseBodyMode: 'full',
                ...(options.signal === undefined
                  ? {}
                  : { signal: options.signal }),
              });
              if (!response.ok) {
                throw new Error(response.message);
              }
              return {
                status: response.status,
                location: response.location,
                contentType: response.contentType,
                body: Buffer.from(response.bodyBase64, 'base64'),
              };
            };
      const output = await fetchWebUrl({
        url: args.url,
        extractMode: args.extractMode ?? 'text',
        ...(requestWebFetchUrl === undefined ? {} : { requestWebFetchUrl }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (!output.ok) {
        return {
          ok: false,
          output: stringifyWebFetchOutput(output),
          errorCode: webFetchFailureToolErrorCode(output.reasonCode),
          error: output.message,
        };
      }
      return {
        ok: true,
        output: stringifyWebFetchOutput(output),
      };
    },
  });
}

export const fetchUrlTool = createFetchUrlTool();
