import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import {
  prepareMutatingFilePath,
  persistPreparedFile,
} from '../../files/file-mutation-chain.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
import { defineZodTool } from '../zod-tool.js';

const writeFileArgsSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'path is required.')
    .refine((value) => value.trim().length > 0, {
      message: 'path must not be empty.',
    })
    .describe(
      'The path to write. Relative paths start from the current directory inside ComputerFileScope.',
    ),
  content: z.string().describe('The content to write to the file.'),
  versionToken: z
    .string()
    .refine((value) => value.trim().length > 0, {
      message: 'versionToken must not be empty.',
    })
    .optional()
    .describe('Version token from a previous read, for conflict detection.'),
});

export const writeFileTool = defineZodTool({
  name: 'write_file',
  description:
    'Write content to a file at the specified path. Creates the file if it does not exist, or overwrites it if it does. Parent directories are created as needed.',
  argsSchema: writeFileArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: true,
  requiresApproval: true,
  catalogSearchMetadata: {
    family: 'file',
    searchHints: ['write file', 'create file', 'save file'],
    tags: ['file', 'mutation', 'approval'],
    whenToUse: 'Create a new file or write full file content.',
    notFor: 'Small exact replacements in existing files.',
  },
  async executeParsed(args, ctx) {
    const inputPath = args.path;
    const content = args.content;
    const versionToken = args.versionToken ?? '';
    const hasNonEmptyVersionToken = versionToken.trim().length > 0;

    try {
      const filePath = resolveComputerFileToolPath(ctx, inputPath);
      const preparedFile = await prepareMutatingFilePath(
        filePath.absoluteRoot,
        filePath.path,
        { allowMissingLeaf: true },
      );
      const { exists } = preparedFile;

      if (exists && !hasNonEmptyVersionToken) {
        return toolError(
          'invalid_args',
          'versionToken is required when overwriting an existing file.',
        );
      }

      const result = await persistPreparedFile(
        preparedFile,
        content,
        versionToken,
        undefined,
        ctx.fileStateCache ? { fileStateCache: ctx.fileStateCache } : {},
      );

      const output = {
        root: filePath.root,
        path: result.path,
        ok: true,
        versionToken: result.versionToken,
        totalLines: result.totalLines,
        mode: exists ? 'overwritten' : 'created',
      };

      return { ok: true, output: JSON.stringify(output) };
    } catch (err: unknown) {
      return catchToolError(err);
    }
  },
});
