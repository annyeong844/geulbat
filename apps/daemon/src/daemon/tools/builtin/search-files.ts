import { z } from 'zod';
import { catchToolError } from '../result.js';
import { resolveSourceDirectoryTarget } from '../../files/file-platform.js';
import { createGlobMatcher, filenameSearch } from './search-files-filename.js';
import { resolveRipgrepPath, runRipgrep } from './search-files-ripgrep.js';
import { defineZodTool } from '../zod-tool.js';

const MAX_INCLUDE_GLOB_LENGTH = 256;

const searchFilesArgsSchema = z.strictObject({
  pattern: z
    .string()
    .min(1, 'pattern is required.')
    .describe(
      'The search pattern. For content search this is a regex; for file search this is a glob pattern.',
    ),
  path: z
    .string()
    .min(1, 'path must not be empty.')
    .refine((value) => value.trim().length > 0, {
      message: 'path must not be empty.',
    })
    .optional()
    .describe(
      'The directory to search in, relative to the workspace root. Defaults to workspace root.',
    ),
  type: z
    .enum(['content', 'filename'])
    .optional()
    .describe(
      'Whether to search file contents or filenames. Defaults to "content".',
    ),
  include: z
    .string()
    .max(
      MAX_INCLUDE_GLOB_LENGTH,
      `include glob is too long (max ${MAX_INCLUDE_GLOB_LENGTH} characters).`,
    )
    .regex(/^(?!!).*$/u, 'include glob must not start with "!".')
    .optional()
    .describe('Glob pattern to filter which files to search (e.g. "*.ts").'),
  maxResults: z
    .number()
    .int('maxResults must be a positive integer.')
    .min(1, 'maxResults must be a positive integer.')
    .optional()
    .describe(
      'Optional maximum number of result entries to return. Omit it to return all matches.',
    ),
});

export const searchFilesTool = defineZodTool({
  name: 'search_files',
  description:
    'Search for files matching a pattern or search for text content within files. Returns matching file paths and optionally matching lines.',
  argsSchema: searchFilesArgsSchema,
  sideEffectLevel: 'read',
  mayMutateWorkspaceFiles: false,
  requiresApproval: false,
  async executeParsed(args, ctx) {
    const query = args.pattern;
    const searchPath = args.path ?? '.';
    const searchType = args.type ?? 'content';
    const glob = args.include ? args.include : null;
    const maxResults = args.maxResults;

    try {
      const rootTarget = await resolveSourceDirectoryTarget(
        ctx.workspaceRoot,
        searchPath,
      );
      if (!rootTarget.exists) {
        return {
          ok: true,
          output: JSON.stringify({
            backend: searchType === 'filename' ? 'filename' : 'ripgrep',
            query,
            total: 0,
            truncated: false,
            results: [],
          }),
        };
      }

      const rootDir = rootTarget.canonicalAbsolutePath;

      if (searchType === 'filename') {
        const queryMatcher = createGlobMatcher(query);
        const includeMatcher = createGlobMatcher(glob);
        const filenameResult = await filenameSearch(
          rootDir,
          ctx.workspaceRoot,
          queryMatcher,
          includeMatcher,
          maxResults,
        );
        return { ok: true, output: JSON.stringify(filenameResult) };
      }

      const rgPath = await resolveRipgrepPath();
      const rgResult = await runRipgrep(
        rgPath,
        query,
        rootDir,
        glob,
        ctx.workspaceRoot,
        maxResults,
        ctx.signal,
      );
      return { ok: true, output: JSON.stringify(rgResult) };
    } catch (err: unknown) {
      return catchToolError(err);
    }
  },
});
