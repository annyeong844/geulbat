import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import {
  preparePatchFile,
  persistPreparedFile,
} from './file-mutation-chain.js';
import {
  countTextLines,
  normalizeTextContent,
} from '../../files/text-content.js';
import { defineZodTool } from '../zod-tool.js';

const patchFilePathSchema = z
  .string()
  .min(1, 'path is required.')
  .refine((value) => value.trim().length > 0, {
    message: 'path must not be empty.',
  })
  .describe('The path to the file to patch, relative to the workspace root.');

const patchFileNewStringSchema = z
  .string()
  .describe('The string to replace old_string with.');

const patchFileVersionTokenSchema = z
  .string()
  .refine((value) => value.trim().length > 0, {
    message: 'versionToken must not be empty.',
  })
  .optional()
  .describe('Version token from a previous read, for conflict detection.');

const patchFileArgsSchema = z.strictObject({
  path: patchFilePathSchema,
  old_string: z
    .string()
    .describe(
      'The exact string to find in the file. Must match exactly one location. Empty string appends to end of file.',
    ),
  new_string: patchFileNewStringSchema,
  versionToken: patchFileVersionTokenSchema,
});

const patchFileParametersSchema = z.union([
  z.strictObject({
    path: patchFilePathSchema,
    old_string: z
      .literal('')
      .describe('Append mode marker. Empty old_string appends to the file.'),
    new_string: patchFileNewStringSchema,
    versionToken: patchFileVersionTokenSchema,
  }),
  z.strictObject({
    path: patchFilePathSchema,
    old_string: z
      .string()
      .min(1)
      .describe(
        'The exact non-empty string to find. Must match exactly one location.',
      ),
    new_string: patchFileNewStringSchema,
    versionToken: patchFileVersionTokenSchema,
  }),
]);

export const patchFileTool = defineZodTool({
  name: 'patch_file',
  description:
    'Apply a patch to an existing file. Performs a search-and-replace operation, replacing the old_string with new_string. The old_string must match exactly one location in the file.',
  argsSchema: patchFileArgsSchema,
  parametersSchema: patchFileParametersSchema,
  sideEffectLevel: 'write',
  mayMutateWorkspaceFiles: true,
  requiresApproval: true,
  async executeParsed(args, ctx) {
    const inputPath = args.path;
    const oldStr = normalizeTextContent(args.old_string);
    const newStr = normalizeTextContent(args.new_string);
    const versionToken = args.versionToken ?? '';
    const hasNonEmptyVersionToken = versionToken.trim().length > 0;

    const isAppend = oldStr === '';

    try {
      const cacheContext = ctx.fileStateCache
        ? { fileStateCache: ctx.fileStateCache }
        : {};
      const preparedFile = await preparePatchFile(
        ctx.workspaceRoot,
        inputPath,
        cacheContext,
      );
      const { fileResult } = preparedFile;
      const original = fileResult.content;

      if (!hasNonEmptyVersionToken) {
        return toolError(
          'invalid_args',
          'versionToken is required when patching an existing file.',
        );
      }

      let updated: string;
      let mode: 'replace' | 'append';

      if (isAppend) {
        // Append mode — add to end of file
        updated = original + newStr;
        mode = 'append';
      } else {
        // Replace mode — require exactly 1 match
        const matchCount = countOccurrences(original, oldStr);

        if (matchCount === 0) {
          return toolError('invalid_args', 'old_string not found in file.');
        }

        if (matchCount > 1) {
          return toolError(
            'invalid_args',
            `old_string matched ${matchCount} times. Must match exactly once.`,
          );
        }

        // Exactly 1 match — replace
        const idx = original.indexOf(oldStr);
        updated =
          original.slice(0, idx) + newStr + original.slice(idx + oldStr.length);
        mode = 'replace';
      }

      // No-op detection — skip write if nothing changed
      if (updated === original) {
        const output = {
          path: fileResult.path,
          ok: true,
          versionToken: fileResult.versionToken,
          totalLines: countTextLines(original),
          mode,
          linesChanged: 0,
        };
        return { ok: true, output: JSON.stringify(output) };
      }

      // Save via shared saveFile (conflict check + atomic write)
      const saveResult = await persistPreparedFile(
        preparedFile,
        updated,
        versionToken,
        undefined,
        cacheContext,
      );

      const linesChanged = Math.abs(
        countTextLines(newStr) - (isAppend ? 0 : countTextLines(oldStr)),
      );

      const output = {
        path: saveResult.path,
        ok: true,
        versionToken: saveResult.versionToken,
        totalLines: saveResult.totalLines,
        mode,
        linesChanged,
      };

      return { ok: true, output: JSON.stringify(output) };
    } catch (err: unknown) {
      return catchToolError(err);
    }
  },
});

/** Count occurrences of a substring in text */
function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = text.indexOf(search, pos);
    if (idx === -1) break;
    count++;
    pos = idx + search.length;
  }
  return count;
}
