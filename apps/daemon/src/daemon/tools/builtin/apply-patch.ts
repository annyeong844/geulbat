import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import {
  prepareMutatingFilePath,
  preparePatchFile,
  persistPreparedFile,
} from '../../files/file-mutation-chain.js';
import {
  countTextLines,
  normalizeTextContent,
} from '../../files/text-content.js';
import {
  resolveComputerFileToolPath,
  type ComputerFileToolPath,
} from '../file-tool-root.js';
import { defineZodTool } from '../zod-tool.js';
import type { ExecuteResult } from '../types.js';
import type { FileStateCache } from '../../utils/file-state-cache.js';

type ApplyPatchOperation =
  | {
      kind: 'add';
      path: string;
      content: string;
    }
  | {
      kind: 'update';
      path: string;
      hunks: ApplyPatchHunk[];
    };

interface ApplyPatchHunk {
  oldText: string;
  newText: string;
}

const applyPatchArgsSchema = z.strictObject({
  patch: z
    .string()
    .min(1, 'patch is required.')
    .describe(
      'Patch text using *** Begin Patch / *** End Patch with one Add File or Update File section.',
    ),
});

export const applyPatchTool = defineZodTool({
  name: 'apply_patch',
  description:
    'Apply one non-destructive file patch using a patch text block. Supports Add File and Update File sections. Update hunks must include exact context and match the current file exactly once. Delete File is owned by manage_files delete.',
  argsSchema: applyPatchArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: true,
  requiresApproval: true,
  exposure: {
    directHot: true,
    sdkVisible: false,
    inCellCallable: false,
    directOnly: true,
    approvalRequired: true,
    effectClass: 'computerWrite',
  },
  catalogSearchMetadata: {
    family: 'file',
    searchHints: ['apply patch', 'patch file', 'replace text', 'edit file'],
    tags: ['file', 'mutation', 'approval'],
    whenToUse:
      'Apply a patch-shaped change to one computer file with exact context matching.',
    notFor:
      'Deleting files, running shell patch commands, broad multi-file rewrites, or edits without exact context.',
  },
  async executeParsed(args, ctx) {
    try {
      const operation = parseSingleApplyPatchOperation(args.patch);
      const filePath = resolveComputerFileToolPath(ctx, operation.path);
      const cacheContext = ctx.fileStateCache
        ? { fileStateCache: ctx.fileStateCache }
        : {};

      switch (operation.kind) {
        case 'add':
          return await applyAddFileOperation(
            { ...operation, path: filePath.path },
            filePath,
            cacheContext,
          );
        case 'update':
          return await applyUpdateFileOperation(
            { ...operation, path: filePath.path },
            filePath,
            cacheContext,
          );
      }
    } catch (err: unknown) {
      if (err instanceof ApplyPatchParseError) {
        return toolError('invalid_args', err.message);
      }
      return catchToolError(err);
    }
  },
});

async function applyAddFileOperation(
  operation: Extract<ApplyPatchOperation, { kind: 'add' }>,
  fileRoot: Pick<ComputerFileToolPath, 'root' | 'absoluteRoot'>,
  cacheContext: { fileStateCache?: FileStateCache },
) {
  const preparedPath = await prepareMutatingFilePath(
    fileRoot.absoluteRoot,
    operation.path,
    {
      allowMissingLeaf: true,
    },
  );
  if (preparedPath.exists) {
    return toolError(
      'invalid_args',
      `file already exists: ${preparedPath.resolvedPath.relativePath}`,
    );
  }

  const saveResult = await persistPreparedFile(
    preparedPath,
    operation.content,
    '',
    undefined,
    cacheContext,
  );

  return applyPatchSuccess({
    ok: true,
    root: fileRoot.root,
    operation: 'add',
    path: saveResult.path,
    versionToken: saveResult.versionToken,
    totalLines: saveResult.totalLines,
    linesChanged: countTextLines(operation.content),
  });
}

async function applyUpdateFileOperation(
  operation: Extract<ApplyPatchOperation, { kind: 'update' }>,
  fileRoot: Pick<ComputerFileToolPath, 'root' | 'absoluteRoot'>,
  cacheContext: { fileStateCache?: FileStateCache },
) {
  const preparedFile = await preparePatchFile(
    fileRoot.absoluteRoot,
    operation.path,
    cacheContext,
  );
  const { fileResult } = preparedFile;
  const original = fileResult.content;
  const applyResult = applyPatchHunks(original, operation.hunks);

  if (applyResult.updated === original) {
    return applyPatchSuccess({
      ok: true,
      root: fileRoot.root,
      operation: 'update',
      path: fileResult.path,
      versionToken: fileResult.versionToken,
      totalLines: countTextLines(original),
      linesChanged: 0,
    });
  }

  const saveResult = await persistPreparedFile(
    preparedFile,
    applyResult.updated,
    fileResult.versionToken,
    undefined,
    cacheContext,
  );

  return applyPatchSuccess({
    ok: true,
    root: fileRoot.root,
    operation: 'update',
    path: saveResult.path,
    versionToken: saveResult.versionToken,
    totalLines: saveResult.totalLines,
    linesChanged: applyResult.linesChanged,
  });
}

function parseSingleApplyPatchOperation(patch: string): ApplyPatchOperation {
  const operations = parseApplyPatchOperations(patch);
  if (operations.length !== 1) {
    throw new ApplyPatchParseError(
      'apply_patch requires exactly one file operation.',
    );
  }
  return operations[0]!;
}

function parseApplyPatchOperations(patch: string): ApplyPatchOperation[] {
  const lines = splitPatchLines(patch);
  if (lines[0] !== '*** Begin Patch') {
    throw new ApplyPatchParseError(
      'apply_patch patch must start with *** Begin Patch.',
    );
  }
  if (lines.at(-1) !== '*** End Patch') {
    throw new ApplyPatchParseError(
      'apply_patch patch must end with *** End Patch.',
    );
  }

  const operations: ApplyPatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index]!;
    if (line.trim() === '') {
      index++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const { operation, nextIndex } = parseAddFileOperation(lines, index);
      operations.push(operation);
      index = nextIndex;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const { operation, nextIndex } = parseUpdateFileOperation(lines, index);
      operations.push(operation);
      index = nextIndex;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      throw new ApplyPatchParseError(
        'Delete File is not supported by apply_patch; use manage_files delete.',
      );
    }
    throw new ApplyPatchParseError(
      `unsupported apply_patch directive: ${line}`,
    );
  }

  if (operations.length === 0) {
    throw new ApplyPatchParseError(
      'apply_patch patch must contain a file operation.',
    );
  }
  return operations;
}

function parseAddFileOperation(
  lines: string[],
  startIndex: number,
): {
  operation: Extract<ApplyPatchOperation, { kind: 'add' }>;
  nextIndex: number;
} {
  const path = readPatchDirectivePath(lines[startIndex]!, '*** Add File: ');
  const contentLines: string[] = [];
  let stripFinalNewline = false;
  let index = startIndex + 1;
  while (index < lines.length - 1 && !isPatchDirective(lines[index]!)) {
    const line = lines[index]!;
    if (line === '*** End of File') {
      stripFinalNewline = true;
      index++;
      continue;
    }
    if (!line.startsWith('+')) {
      throw new ApplyPatchParseError(
        'Add File content lines must start with +.',
      );
    }
    contentLines.push(line.slice(1));
    index++;
  }
  if (contentLines.length === 0) {
    throw new ApplyPatchParseError(
      'Add File requires at least one content line.',
    );
  }
  return {
    operation: {
      kind: 'add',
      path,
      content: joinPatchLines(contentLines, stripFinalNewline),
    },
    nextIndex: index,
  };
}

function parseUpdateFileOperation(
  lines: string[],
  startIndex: number,
): {
  operation: Extract<ApplyPatchOperation, { kind: 'update' }>;
  nextIndex: number;
} {
  const path = readPatchDirectivePath(lines[startIndex]!, '*** Update File: ');
  const hunks: ApplyPatchHunk[] = [];
  let index = startIndex + 1;
  while (index < lines.length - 1 && !isPatchDirective(lines[index]!)) {
    if (!isHunkHeader(lines[index]!)) {
      throw new ApplyPatchParseError(
        'Update File content must be grouped under @@ hunks.',
      );
    }
    const { hunk, nextIndex } = parseUpdateHunk(lines, index + 1);
    hunks.push(hunk);
    index = nextIndex;
  }
  if (hunks.length === 0) {
    throw new ApplyPatchParseError(
      'Update File requires at least one @@ hunk.',
    );
  }
  return {
    operation: {
      kind: 'update',
      path,
      hunks,
    },
    nextIndex: index,
  };
}

function parseUpdateHunk(
  lines: string[],
  startIndex: number,
): { hunk: ApplyPatchHunk; nextIndex: number } {
  let oldText = '';
  let newText = '';
  let sawChange = false;
  let stripFinalNewline = false;
  let index = startIndex;

  while (
    index < lines.length - 1 &&
    !isHunkHeader(lines[index]!) &&
    !isPatchDirective(lines[index]!)
  ) {
    const line = lines[index]!;
    if (line === '*** End of File') {
      stripFinalNewline = true;
      index++;
      continue;
    }
    const prefix = line[0];
    const text = `${line.slice(1)}\n`;
    switch (prefix) {
      case ' ':
        oldText += text;
        newText += text;
        break;
      case '-':
        oldText += text;
        sawChange = true;
        break;
      case '+':
        newText += text;
        sawChange = true;
        break;
      default:
        throw new ApplyPatchParseError(
          'Update hunk lines must start with space, -, or +.',
        );
    }
    index++;
  }

  if (!sawChange) {
    throw new ApplyPatchParseError(
      'Update hunk must contain at least one changed line.',
    );
  }
  if (oldText === '') {
    throw new ApplyPatchParseError(
      'Update hunk must include exact context or removed text.',
    );
  }

  return {
    hunk: {
      oldText: stripFinalNewline ? removeFinalNewline(oldText) : oldText,
      newText: stripFinalNewline ? removeFinalNewline(newText) : newText,
    },
    nextIndex: index,
  };
}

function applyPatchHunks(
  original: string,
  hunks: ApplyPatchHunk[],
): { updated: string; linesChanged: number } {
  let updated = original;
  let linesChanged = 0;
  for (const hunk of hunks) {
    const matchCount = countOccurrences(updated, hunk.oldText);
    if (matchCount === 0) {
      return throwApplyPatchError('patch hunk context not found in file.');
    }
    if (matchCount > 1) {
      return throwApplyPatchError(
        `patch hunk context matched ${matchCount} times. Must match exactly once.`,
      );
    }
    updated = updated.replace(hunk.oldText, hunk.newText);
    linesChanged += Math.abs(
      countTextLines(hunk.newText) - countTextLines(hunk.oldText),
    );
  }
  return { updated, linesChanged };
}

function splitPatchLines(patch: string): string[] {
  const normalized = normalizeTextContent(patch);
  const withoutFinalNewline = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized;
  return withoutFinalNewline.split('\n');
}

function readPatchDirectivePath(line: string, prefix: string): string {
  const path = line.slice(prefix.length).trim();
  if (path.length === 0) {
    throw new ApplyPatchParseError('apply_patch file path must not be empty.');
  }
  return path;
}

function isPatchDirective(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Update File: ') ||
    line.startsWith('*** Delete File: ')
  );
}

function isHunkHeader(line: string): boolean {
  return line === '@@' || line.startsWith('@@ ');
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = text.indexOf(search, pos);
    if (idx === -1) {
      break;
    }
    count++;
    pos = idx + search.length;
  }
  return count;
}

function throwApplyPatchError(message: string): never {
  throw new ApplyPatchParseError(message);
}

function applyPatchSuccess(output: unknown): ExecuteResult {
  return { ok: true, output: JSON.stringify(output) };
}

function joinPatchLines(lines: string[], stripFinalNewline: boolean): string {
  if (lines.length === 0) {
    return '';
  }
  const joined = lines.join('\n');
  return stripFinalNewline ? joined : `${joined}\n`;
}

function removeFinalNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

class ApplyPatchParseError extends Error {}
