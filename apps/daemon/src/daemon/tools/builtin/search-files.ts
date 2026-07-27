import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import { resolveSourceDirectoryTarget } from '../../files/file-platform.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
import { resolveToolLibraryProjectionBrowsePath } from '../tool-library-projection-browse.js';
import { createGlobMatcher, filenameSearch } from './search-files-filename.js';
import type { SearchFilesHostRouting } from './search-files-host-stream.js';
import { resolveRipgrepPath, runRipgrep } from './search-files-ripgrep.js';
import type { ToolExecutionContext } from '../types.js';
import { defineZodTool } from '../zod-tool.js';

/**
 * P7.6 item 4 — 검색 자식의 실행 위치. command-host 런타임과 state root가 없는
 * 호출은 데몬 직접 spawn으로 강등하지 않고 fail-closed한다. 페이지 상한은 조립이
 * 호스트를 구성할 때 쓴 inline 예산 그 값이다 — 추정하면 세션이
 * invalid_args로 거부한다(§4.2).
 */
function resolveSearchFilesHostRouting(
  ctx: Pick<ToolExecutionContext, 'runtimeServices' | 'stateRoot'>,
): SearchFilesHostRouting {
  const runtimeServices = ctx.runtimeServices;
  const stateRoot = ctx.stateRoot;
  if (runtimeServices === undefined || stateRoot === undefined) {
    throw Object.assign(
      new Error('search_files requires the daemon host command runtime.'),
      { code: 'execution_failed' },
    );
  }
  return {
    hostCommands: runtimeServices.hostCommands,
    stateRoot,
    pageLimitBytes: runtimeServices.hostCommandInlineMaxBytes,
  };
}

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
  consistency: z
    .enum(['filesystem_snapshot', 'eventual_index'])
    .optional()
    .describe(
      'Filename-search consistency. The default filesystem_snapshot scans the exposed filesystem for an exact total. eventual_index performs fast bounded basename-glob discovery through Windows Search, requires maxResults, and may omit new or unindexed files.',
    ),
});

export const searchFilesTool = defineZodTool({
  name: 'search_files',
  description:
    'Search filenames or file contents across the host filesystem. Relative paths start from the current directory; hidden and ignored files are included when the OS exposes them. In filename mode, a basename glob without a slash matches at any directory depth. Use explicit eventual_index consistency with maxResults for fast bounded basename discovery on indexed Windows paths; the default filesystem_snapshot mode returns an exact filesystem total.',
  argsSchema: searchFilesArgsSchema,
  sideEffectLevel: 'read',
  mayMutateComputerFiles: false,
  abortSettlement: 'await_execution',
  requiresApproval: false,
  recoveryStrategy: 'replay_safe',
  resultProjection: {
    exactDurableRecovery: true,
    modelProjection: 'search_files_summary',
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
    family: 'file',
    searchHints: ['grep text', 'rg pattern', 'find text', 'search files'],
    tags: ['file', 'search', 'computer'],
    whenToUse:
      'Find structured file paths or text matches without shell startup; use bounded eventual_index filename search for fast broad discovery on indexed Windows paths.',
    notFor: 'Reading a known file after you already have its path.',
  },
  async executeParsed(args, ctx) {
    const query = args.pattern;
    const searchPath = args.path ?? '.';
    const searchType = args.type ?? 'content';
    const glob = args.include ? args.include : null;
    const maxResults = args.maxResults;
    const consistency = args.consistency ?? 'filesystem_snapshot';

    if (consistency === 'eventual_index' && searchType !== 'filename') {
      return toolError(
        'invalid_args',
        'eventual_index consistency is available only for filename search.',
      );
    }
    if (consistency === 'eventual_index' && maxResults === undefined) {
      return toolError(
        'invalid_args',
        'eventual_index filename search requires maxResults.',
      );
    }
    if (consistency === 'eventual_index' && glob !== null) {
      return toolError(
        'invalid_args',
        'eventual_index filename search does not accept include.',
      );
    }

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
            backend:
              consistency === 'eventual_index'
                ? 'windows-search-index'
                : searchType === 'filename'
                  ? 'ripgrep-files'
                  : 'ripgrep',
            ...(searchType === 'filename'
              ? {
                  consistency,
                  totalRelation: 'exact' as const,
                }
              : {}),
            query,
            total: 0,
            truncated: false,
            results: [],
          }),
        };
      }

      const rootDir = rootTarget.canonicalAbsolutePath;
      // P7.6 item 4 — 모든 검색 자식과 Windows 실행파일 발견은 command-host
      // 워커의 system 세션에서만 돈다.
      const hostRouting = resolveSearchFilesHostRouting(ctx);

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
          {
            consistency,
            hostRouting,
          },
        );
        return {
          ok: true,
          output: JSON.stringify({ ...source, ...filenameResult }),
        };
      }

      const rgPath = await resolveRipgrepPath(rootDir, hostRouting);
      const rgResult = await runRipgrep(
        rgPath,
        query,
        rootDir,
        glob,
        filePath.absoluteRoot,
        maxResults,
        ctx.signal,
        hostRouting,
      );
      return {
        ok: true,
        output: JSON.stringify({ ...source, ...rgResult }),
      };
    } catch (err: unknown) {
      const failure = catchToolError(err);
      if (failure.ok || failure.diagnostics !== undefined) {
        return failure;
      }
      return {
        ...failure,
        diagnostics: {
          phase: searchType === 'content' ? 'content_scan' : 'filename_scan',
          reasonCode: 'search_failed',
          retryHint:
            searchType === 'content'
              ? 'Check the search pattern, include glob, and path, then retry.'
              : 'Check the filename glob and path, then retry.',
        },
      };
    }
  },
});
