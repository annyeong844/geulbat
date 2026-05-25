import { z } from 'zod';
import { defineZodTool } from '../zod-tool.js';
import {
  WEB_FETCH_MAX_CHARS,
  WEB_FETCH_MIN_CHARS,
  WEB_FETCH_TOTAL_TIMEOUT_MS,
} from './web-fetch-policy.js';
import {
  resolveWebFetchMaxChars,
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
  maxChars: z
    .number()
    .int()
    .min(WEB_FETCH_MIN_CHARS)
    .max(WEB_FETCH_MAX_CHARS)
    .optional()
    .describe('Maximum characters of fetched content to return.'),
});

type WebFetchArgs = z.output<typeof webFetchArgsSchema>;

export function createWebFetchTool(
  deps: {
    fetchWebUrl?: typeof defaultFetchWebUrl;
  } = {},
) {
  const fetchWebUrl = deps.fetchWebUrl ?? defaultFetchWebUrl;
  return defineZodTool({
    name: 'web_fetch',
    description:
      'Fetch one public HTTP(S) URL as untrusted text. Does not search, browse with cookies, or fetch local/private network URLs.',
    argsSchema: webFetchArgsSchema,
    sideEffectLevel: 'read',
    mayMutateWorkspaceFiles: false,
    timeoutMs: WEB_FETCH_TOTAL_TIMEOUT_MS,
    requiresApproval: false,
    async executeParsed(args: WebFetchArgs, ctx) {
      const output = await fetchWebUrl({
        url: args.url,
        extractMode: args.extractMode ?? 'text',
        maxChars: resolveWebFetchMaxChars(args.maxChars),
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

export const webFetchTool = createWebFetchTool();
