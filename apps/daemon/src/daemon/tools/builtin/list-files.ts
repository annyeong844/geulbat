import { z } from 'zod';
import { catchToolError } from '../result.js';
import { shouldExcludeWorkspaceEntry } from '../../files/reserved-paths.js';
import {
  enumerateCanonicalChildren,
  resolveSourceDirectoryTarget,
  type SourceDirectoryTarget,
} from '../../files/file-platform.js';
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
    .describe('The directory path to list, relative to the workspace root.'),
  recursive: z
    .boolean()
    .optional()
    .describe('Whether to list files recursively. Defaults to false.'),
});

export const listFilesTool = defineZodTool({
  name: 'list_files',
  description:
    'List files and directories at the specified path. Returns a listing of entries in the directory. Useful for exploring the workspace structure.',
  argsSchema: listFilesArgsSchema,
  sideEffectLevel: 'read',
  mayMutateWorkspaceFiles: false,
  requiresApproval: false,
  async executeParsed(args, ctx) {
    const inputPath = args.path ?? '.';
    const recursive = args.recursive ?? false;

    try {
      const rootTarget = await resolveSourceDirectoryTarget(
        ctx.workspaceRoot,
        inputPath,
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

/** List a single directory (non-recursive) */
async function listSingleDir(
  target: SourceDirectoryTarget,
  results: EntryInfo[],
): Promise<void> {
  const dirEntries = await enumerateCanonicalChildren(target);

  for (const entry of dirEntries) {
    if (
      entry.viaSymlink ||
      shouldExcludeWorkspaceEntry(entry.relativePath, entry.name)
    ) {
      continue;
    }

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
): Promise<void> {
  const dirEntries = await enumerateCanonicalChildren(target);

  for (const entry of dirEntries) {
    if (
      entry.viaSymlink ||
      shouldExcludeWorkspaceEntry(entry.relativePath, entry.name)
    ) {
      continue;
    }

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
