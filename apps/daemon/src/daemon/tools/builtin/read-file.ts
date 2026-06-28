import { z } from 'zod';
import { catchToolError } from '../result.js';
import { readFile, readFilePage } from '../../files/read-file.js';
import { splitTextLines } from '../../files/text-content.js';
import { defineZodTool } from '../zod-tool.js';

const readFileArgsSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'path is required.')
    .refine((value) => value.trim().length > 0, {
      message: 'path must not be empty.',
    })
    .describe('The path to the file to read, relative to the workspace root.'),
  offset: z
    .number()
    .int('offset must be a non-negative integer.')
    .min(0, 'offset must be a non-negative integer.')
    .optional()
    .describe(
      'The line number to start reading from (0-based). Defaults to 0.',
    ),
  limit: z
    .number()
    .int('limit must be a positive integer.')
    .min(1, 'limit must be a positive integer.')
    .optional()
    .describe(
      'Optional page size in lines. Omit to read from the offset through the end of the file.',
    ),
});

export const readFileTool = defineZodTool({
  name: 'read_file',
  description:
    'Read the contents of a file at the specified path. Returns the file content as a string. Use this to examine existing files in the workspace.',
  argsSchema: readFileArgsSchema,
  sideEffectLevel: 'read',
  mayMutateWorkspaceFiles: false,
  requiresApproval: false,
  async executeParsed(args, ctx) {
    const inputPath = args.path;
    const offset = args.offset ?? 0;
    const limit = args.limit;

    try {
      const result =
        limit != null
          ? await readFilePage(ctx.workspaceRoot, inputPath, { offset, limit })
          : await readFile(
              ctx.workspaceRoot,
              inputPath,
              ctx.fileStateCache ? { fileStateCache: ctx.fileStateCache } : {},
            );
      const totalLines = result.totalLines;

      const startIdx = offset;
      const endIdx =
        limit != null ? Math.min(startIdx + limit, totalLines) : totalLines;
      const selectedLines =
        limit != null
          ? splitTextLines(result.content)
          : splitTextLines(result.content).slice(startIdx, endIdx);
      const sliceContent =
        limit != null
          ? result.content
          : selectedLines.join('\n') + (selectedLines.length > 0 ? '\n' : '');

      const hasMore = endIdx < totalLines;
      const startLine = startIdx + 1;
      const endLine = startIdx + selectedLines.length;

      const output = {
        path: result.path,
        content: sliceContent,
        versionToken: result.versionToken,
        totalLines,
        startLine,
        endLine,
        hasMore,
        nextOffset: hasMore ? endIdx : null,
      };

      return { ok: true, output: JSON.stringify(output) };
    } catch (err: unknown) {
      return catchToolError(err);
    }
  },
});
