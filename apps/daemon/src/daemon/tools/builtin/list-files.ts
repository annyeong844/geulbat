import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import {
  enumerateCanonicalChildren,
  resolveSourceDirectoryTarget,
  type SourceDirectoryTarget,
} from '../../files/file-platform.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
import { resolvePluginSkillDirectoryBrowsePath } from '../plugin-skill-browse.js';
import {
  resolveToolLibraryProjectionBrowsePath,
  TOOL_LIBRARY_MODEL_FACING_ROOT,
  type ToolLibraryProjectionBrowsePathResult,
} from '../tool-library-projection-browse.js';
import { defineZodTool } from '../zod-tool.js';

interface EntryInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

const listFilesArgsSchema = z
  .strictObject({
    path: z
      .string()
      .min(1, 'path must not be empty.')
      .refine((value) => value.trim().length > 0, {
        message: 'path must not be empty.',
      })
      .optional()
      .describe(
        'A host directory resolved from the current directory, a verified read-only geulbat-sdk directory, or an opaque geulbat-skill ref returned by skill_search. Absolute paths may address any location readable by the daemon process.',
      ),
    recursive: z
      .boolean()
      .optional()
      .describe('Whether to list files recursively. Defaults to false.'),
    maxDepth: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum returned depth when recursive is true. Direct children are depth 1. Omit for unbounded recursive traversal.',
      ),
    excludeNames: z
      .array(
        z
          .string()
          .min(1, 'excludeNames entries must not be empty.')
          .refine((value) => value.trim().length > 0, {
            message: 'excludeNames entries must not be empty.',
          }),
      )
      .optional()
      .describe(
        'Exact entry basenames to omit at every depth, including their descendants.',
      ),
    entryTypes: z
      .array(z.enum(['file', 'directory']))
      .min(1, 'entryTypes must contain at least one entry type.')
      .optional()
      .describe(
        'Entry types to return. Omit for both files and directories; use ["directory"] for a compact structural overview.',
      ),
  })
  .refine((args) => args.maxDepth === undefined || args.recursive === true, {
    path: ['maxDepth'],
    message: 'maxDepth requires recursive to be true.',
  });

export const listFilesTool = defineZodTool({
  name: 'list_files',
  description:
    'List the host filesystem, the verified read-only geulbat-sdk tree, or an enabled bundled/installed plugin skill tree. Relative paths start from the current directory; hidden entries and symlink aliases are included when the OS exposes them.',
  argsSchema: listFilesArgsSchema,
  sideEffectLevel: 'read',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  resultProjection: {
    exactDurableRecovery: true,
    modelProjection: 'list_files_summary',
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
    searchHints: ['ls folder', 'list directory', 'show files', 'tree'],
    tags: ['file', 'directory', 'computer'],
    whenToUse:
      'Explore a filesystem, geulbat-sdk, or bundled/installed plugin skill directory with structured entries and no shell startup.',
    notFor: 'Reading file contents or text search.',
  },
  async executeParsed(args, ctx) {
    const inputPath = args.path ?? '.';
    const recursive = args.recursive ?? false;
    const excludedNames = new Set(args.excludeNames ?? []);
    const includedTypes = new Set<EntryInfo['type']>(
      args.entryTypes ?? ['file', 'directory'],
    );

    try {
      const pluginSkillPath = await resolvePluginSkillDirectoryBrowsePath({
        ctx,
        inputPath,
        recursive,
      });
      if (pluginSkillPath.kind === 'failure') {
        return toolError('not_found', pluginSkillPath.message);
      }
      if (pluginSkillPath.kind === 'plugin_skill_directory') {
        const directory = pluginSkillPath.directory;
        const sourcePlugin = directory.skill.sourcePlugin;
        const entries = directory.entries.filter((entry) =>
          isListedEntrySelected({
            basePath: directory.logicalPath,
            entry,
            maxDepth: args.maxDepth,
            excludedNames,
            includedTypes,
          }),
        );
        return {
          ok: true,
          output: JSON.stringify({
            path: directory.logicalPath,
            total: entries.length,
            entries,
            source: 'plugin_skill',
            readOnly: true,
            skillRef: directory.skill.skillRef,
            skillName: directory.skill.name,
            instructionsRef: directory.skill.instructionsRef,
            allowImplicitInvocation: directory.skill.allowImplicitInvocation,
            pluginInstallationId: sourcePlugin.installationId,
            pluginName: sourcePlugin.name,
            pluginVersion: sourcePlugin.version,
            pluginContentDigest: sourcePlugin.contentDigest,
          }),
        };
      }
      const projectionPath = await resolveToolLibraryProjectionBrowsePath({
        ctx,
        inputPath,
      });
      if (projectionPath.kind === 'failure') {
        return toolError('not_found', projectionPath.message);
      }
      if (projectionPath.kind === 'projection_path') {
        const projectionEntries = listProjectionDirectory(
          projectionPath,
          recursive,
        );
        if (projectionEntries === null) {
          return toolError(
            'not_found',
            'The requested tool library directory is not projected',
          );
        }
        const entries = projectionEntries.filter((entry) =>
          isListedEntrySelected({
            basePath: projectionPath.logicalPath,
            entry,
            maxDepth: args.maxDepth,
            excludedNames,
            includedTypes,
          }),
        );
        return {
          ok: true,
          output: JSON.stringify({
            path: projectionPath.logicalPath,
            total: entries.length,
            entries,
            source: 'tool_library_projection',
            readOnly: true,
            sdkVersion: projectionPath.identity.sdkVersion,
            sdkProjectionHash: projectionPath.identity.sdkProjectionHash,
            policyId: projectionPath.identity.policyId,
            computerFileShadowIgnored: projectionPath.computerFileShadowIgnored,
          }),
        };
      }
      const filePath = resolveComputerFileToolPath(ctx, inputPath);
      const rootTarget = await resolveSourceDirectoryTarget(
        filePath.absoluteRoot,
        filePath.path,
      );

      const entries: EntryInfo[] = [];

      if (rootTarget.exists) {
        if (recursive) {
          await walkDirectory(
            rootTarget,
            entries,
            excludedNames,
            includedTypes,
            args.maxDepth,
          );
        } else {
          await listSingleDir(
            rootTarget,
            entries,
            excludedNames,
            includedTypes,
          );
        }
      }

      // Sort alphabetically by path
      entries.sort((a, b) => a.path.localeCompare(b.path));

      const output = {
        root: filePath.root,
        path: rootTarget.relativePath,
        total: entries.length,
        entries,
      };

      return { ok: true, output: JSON.stringify(output) };
    } catch (err: unknown) {
      return catchToolError(err);
    }
  },
});

function isListedEntrySelected(args: {
  basePath: string;
  entry: EntryInfo;
  maxDepth: number | undefined;
  excludedNames: ReadonlySet<string>;
  includedTypes: ReadonlySet<EntryInfo['type']>;
}): boolean {
  const prefix =
    args.basePath === '.' || args.basePath.length === 0
      ? ''
      : `${args.basePath.replace(/\/$/u, '')}/`;
  const relativePath = args.entry.path.startsWith(prefix)
    ? args.entry.path.slice(prefix.length)
    : args.entry.path;
  const segments = relativePath.split('/').filter((segment) => segment !== '');
  return (
    segments.length > 0 &&
    (args.maxDepth === undefined || segments.length <= args.maxDepth) &&
    !segments.some((segment) => args.excludedNames.has(segment)) &&
    args.includedTypes.has(args.entry.type)
  );
}

function listProjectionDirectory(
  projectionPath: Extract<
    ToolLibraryProjectionBrowsePathResult,
    { kind: 'projection_path' }
  >,
  recursive: boolean,
): EntryInfo[] | null {
  if (projectionPath.file !== undefined) {
    return null;
  }
  const prefix =
    projectionPath.relativePath.length === 0
      ? ''
      : `${projectionPath.relativePath}/`;
  const matchingFiles = projectionPath.files.filter((file) =>
    file.path.startsWith(prefix),
  );
  if (matchingFiles.length === 0 && prefix.length > 0) {
    return null;
  }

  const entriesByPath = new Map<string, EntryInfo>();
  for (const file of matchingFiles) {
    const remainder = file.path.slice(prefix.length);
    const segments = remainder.split('/');
    const visibleSegments = recursive ? segments : segments.slice(0, 1);
    for (let index = 0; index < visibleSegments.length; index += 1) {
      const relativeEntryPath = [
        ...(projectionPath.relativePath.length === 0
          ? []
          : projectionPath.relativePath.split('/')),
        ...visibleSegments.slice(0, index + 1),
      ].join('/');
      const isFile = recursive
        ? index === segments.length - 1
        : segments.length === 1;
      const logicalPath = `${TOOL_LIBRARY_MODEL_FACING_ROOT}/${relativeEntryPath}`;
      entriesByPath.set(logicalPath, {
        name: visibleSegments[index] ?? '',
        path: logicalPath,
        type: isFile ? 'file' : 'directory',
      });
      if (!recursive) {
        break;
      }
    }
  }
  return [...entriesByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

/** List a single directory (non-recursive) */
async function listSingleDir(
  target: SourceDirectoryTarget,
  results: EntryInfo[],
  excludedNames: ReadonlySet<string>,
  includedTypes: ReadonlySet<EntryInfo['type']>,
): Promise<void> {
  const dirEntries = await enumerateCanonicalChildren(target);

  for (const entry of dirEntries) {
    if (excludedNames.has(entry.name)) {
      continue;
    }
    if (entry.type === 'directory') {
      if (includedTypes.has('directory')) {
        results.push({
          name: entry.name,
          path: entry.relativePath,
          type: 'directory',
        });
      }
    } else {
      if (includedTypes.has('file')) {
        results.push({
          name: entry.name,
          path: entry.relativePath,
          type: 'file',
        });
      }
    }
  }
}

/** Recursively walk directories */
async function walkDirectory(
  target: SourceDirectoryTarget,
  results: EntryInfo[],
  excludedNames: ReadonlySet<string>,
  includedTypes: ReadonlySet<EntryInfo['type']>,
  maxDepth: number | undefined,
  visitedDirectories: Set<string> = new Set(),
  currentDepth = 1,
): Promise<void> {
  if (visitedDirectories.has(target.canonicalAbsolutePath)) {
    return;
  }
  visitedDirectories.add(target.canonicalAbsolutePath);
  const dirEntries = await enumerateCanonicalChildren(target);

  for (const entry of dirEntries) {
    if (excludedNames.has(entry.name)) {
      continue;
    }
    if (entry.type === 'directory') {
      if (includedTypes.has('directory')) {
        results.push({
          name: entry.name,
          path: entry.relativePath,
          type: 'directory',
        });
      }
      if (maxDepth === undefined || currentDepth < maxDepth) {
        await walkDirectory(
          {
            ...target,
            requestedRelativePath: entry.relativePath,
            relativePath: entry.relativePath,
            canonicalAbsolutePath: entry.canonicalAbsolutePath,
            absolutePath: entry.canonicalAbsolutePath,
            exists: true,
          },
          results,
          excludedNames,
          includedTypes,
          maxDepth,
          visitedDirectories,
          currentDepth + 1,
        );
      }
    } else {
      if (includedTypes.has('file')) {
        results.push({
          name: entry.name,
          path: entry.relativePath,
          type: 'file',
        });
      }
    }
  }
}
