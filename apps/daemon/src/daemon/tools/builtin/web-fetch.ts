import { z } from 'zod';
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
  } = {},
) {
  const fetchWebUrl = deps.fetchWebUrl ?? defaultFetchWebUrl;
  return defineZodTool({
    name: 'fetch_url',
    description:
      'Fetch one public HTTP(S) URL as untrusted text. Does not search, browse with cookies, or fetch local/private network URLs.',
    argsSchema: webFetchArgsSchema,
    sideEffectLevel: 'read',
    mayMutateComputerFiles: false,
    requiresApproval: false,
    recoveryStrategy: 'replay_safe',
    exposure: {
      directHot: false,
      sdkVisible: true,
      inCellCallable: true,
      directOnly: false,
      approvalRequired: false,
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
      const output = await fetchWebUrl({
        url: args.url,
        extractMode: args.extractMode ?? 'text',
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
