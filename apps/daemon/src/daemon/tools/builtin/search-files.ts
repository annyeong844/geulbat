import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import { resolveSourceDirectoryTarget } from '../../files/file-platform.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
import { resolveToolLibraryProjectionBrowsePath } from '../tool-library-projection-browse.js';
import { createGlobMatcher, filenameSearch } from './search-files-filename.js';
import { resolveRipgrepPath, runRipgrep } from './search-files-ripgrep.js';
import { defineZodTool } from '../zod-tool.js';

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
      'The host directory to search. Relative paths start from the current directory; absolute paths may address any location readable by the daemon process.',
    ),
  type: z
    .enum(['content', 'filename'])
    .optional()
    .describe(
      'Whether to search file contents or filenames. Defaults to "content".',
    ),
  include: z
    .string()
    .optional()
    .describe(
      'Glob pattern to include files (e.g. "*.ts") or exclude them with a leading "!" (e.g. "!**/*.test.ts").',
    ),
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
    'Search filenames or file contents across the host filesystem. Relative paths start from the current directory; hidden and ignored files are included when the OS exposes them.',
  argsSchema: searchFilesArgsSchema,
  sideEffectLevel: 'read',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  exposure: {
    directHot: true,
    sdkVisible: true,
    inCellCallable: true,
    directOnly: false,
    effectClass: 'readOnly',
  },
  catalogSearchMetadata: {
    family: 'file',
    searchHints: ['grep text', 'rg pattern', 'find text', 'search files'],
    tags: ['file', 'search', 'computer'],
    whenToUse:
      'Find file paths or text matches under a selected filesystem root.',
    notFor: 'Reading a known file after you already have its path.',
  },
  async executeParsed(args, ctx) {
    const query = args.pattern;
    const searchPath = args.path ?? '.';
    const searchType = args.type ?? 'content';
    const glob = args.include ? args.include : null;
    const maxResults = args.maxResults;

    try {
      const projectionPath = await resolveToolLibraryProjectionBrowsePath({
        ctx,
        inputPath: searchPath,
      });
      if (projectionPath.kind === 'failure') {
        return toolError('not_found', projectionPath.message);
      }
      if (projectionPath.kind === 'projection_path') {
        return toolError(
          'invalid_args',
          'search_files does not search the geulbat-sdk projection; use list_files and read_file.',
        );
      }
      const filePath = resolveComputerFileToolPath(ctx, searchPath);
      const rootTarget = await resolveSourceDirectoryTarget(
        filePath.absoluteRoot,
        filePath.path,
      );
      const source = {
        root: filePath.root,
        path: rootTarget.relativePath,
      };
      if (!rootTarget.exists) {
        return {
          ok: true,
          output: JSON.stringify({
            ...source,
            backend: searchType === 'filename' ? 'ripgrep-files' : 'ripgrep',
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
          filePath.absoluteRoot,
          query,
          queryMatcher,
          includeMatcher,
          maxResults,
          ctx.signal,
        );
        return {
          ok: true,
          output: JSON.stringify({ ...source, ...filenameResult }),
        };
      }

      const rgPath = await resolveRipgrepPath(rootDir);
      const rgResult = await runRipgrep(
        rgPath,
        query,
        rootDir,
        glob,
        filePath.absoluteRoot,
        maxResults,
        ctx.signal,
      );
      return {
        ok: true,
        output: JSON.stringify({ ...source, ...rgResult }),
      };
    } catch (err: unknown) {
      return catchToolError(err);
    }
  },
});
