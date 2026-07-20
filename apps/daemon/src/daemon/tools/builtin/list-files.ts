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

const listFilesArgsSchema = z.strictObject({
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
});

export const listFilesTool = defineZodTool({
  name: 'list_files',
  description:
    'List the host filesystem, the verified read-only geulbat-sdk tree, or an enabled bundled/installed plugin skill tree. Relative paths start from the current directory; hidden entries and symlink aliases are included when the OS exposes them.',
  argsSchema: listFilesArgsSchema,
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
    searchHints: ['ls folder', 'list directory', 'show files', 'tree'],
    tags: ['file', 'directory', 'computer'],
    whenToUse:
      'Explore a filesystem, geulbat-sdk, or bundled/installed plugin skill directory.',
    notFor: 'Reading file contents or text search.',
  },
  async executeParsed(args, ctx) {
    const inputPath = args.path ?? '.';
    const recursive = args.recursive ?? false;

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
        return {
          ok: true,
          output: JSON.stringify({
            path: directory.logicalPath,
            total: directory.entries.length,
            entries: directory.entries,
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
        return {
          ok: true,
          output: JSON.stringify({
            path: projectionPath.logicalPath,
            total: projectionEntries.length,
            entries: projectionEntries,
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
          await walkDirectory(rootTarget, entries);
        } else {
          await listSingleDir(rootTarget, entries);
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
): Promise<void> {
  const dirEntries = await enumerateCanonicalChildren(target);

  for (const entry of dirEntries) {
    if (entry.type === 'directory') {
      results.push({
        name: entry.name,
        path: entry.relativePath,
        type: 'directory',
      });
    } else {
      results.push({
        name: entry.name,
        path: entry.relativePath,
        type: 'file',
      });
    }
  }
}

/** Recursively walk directories */
async function walkDirectory(
  target: SourceDirectoryTarget,
  results: EntryInfo[],
  visitedDirectories: Set<string> = new Set(),
): Promise<void> {
  if (visitedDirectories.has(target.canonicalAbsolutePath)) {
    return;
  }
  visitedDirectories.add(target.canonicalAbsolutePath);
  const dirEntries = await enumerateCanonicalChildren(target);

  for (const entry of dirEntries) {
    if (entry.type === 'directory') {
      results.push({
        name: entry.name,
        path: entry.relativePath,
        type: 'directory',
      });
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
        visitedDirectories,
      );
    } else {
      results.push({
        name: entry.name,
        path: entry.relativePath,
        type: 'file',
      });
    }
  }
}
