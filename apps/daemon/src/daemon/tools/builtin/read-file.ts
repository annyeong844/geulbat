import { z } from 'zod';
import { catchToolError } from '../result.js';
import { readFile } from '../../files/read-file.js';
import { splitTextLines } from '../../files/text-content.js';
import { defineZodTool } from '../zod-tool.js';

const readFileArgsSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'path is required.')
    .describe('The path to the file to read, relative to the workspace root.'),
  offset: z
    .number()
    .min(0)
    .optional()
    .describe(
      'The line number to start reading from (0-based). Defaults to 0.',
    ),
  limit: z
    .number()
    .min(1)
    .optional()
    .describe(
      'The maximum number of lines to read. Defaults to reading the entire file.',
    ),
});

export const readFileTool = defineZodTool({
  name: 'read_file',
  description:
    'Read the contents of a file at the specified path. Returns the file content as a string. Use this to examine existing files in the workspace.',
  argsSchema: readFileArgsSchema,
  sideEffectLevel: 'read',
  timeoutMs: 10_000,
  requiresApproval: false,
  async executeParsed(args, ctx) {
    const inputPath = args.path;
    const offset = Math.max(0, Math.floor(args.offset ?? 0));
    const limit =
      args.limit != null ? Math.max(1, Math.floor(args.limit)) : undefined;

    try {
      const result = await readFile(
        ctx.workspaceRoot,
        inputPath,
        ctx.fileStateCache ? { fileStateCache: ctx.fileStateCache } : {},
      );
      const allLines = splitTextLines(result.content);
      const totalLines = allLines.length;

      // Apply offset/limit slicing
      const startIdx = offset;
      const endIdx =
        limit != null
          ? Math.min(startIdx + limit, allLines.length)
          : allLines.length;
      const selectedLines = allLines.slice(startIdx, endIdx);
      const sliceContent =
        selectedLines.join('\n') + (selectedLines.length > 0 ? '\n' : '');

      // Determine truncation
      const truncated = endIdx < allLines.length;
      const startLine = startIdx + 1; // 1-based for output
      const endLine = startIdx + selectedLines.length;

      const output = {
        path: result.path,
        content: sliceContent,
        versionToken: result.versionToken,
        totalLines,
        startLine,
        endLine,
        truncated,
      };

      return { ok: true, output: JSON.stringify(output) };
    } catch (err: unknown) {
      return catchToolError(err);
    }
  },
});
