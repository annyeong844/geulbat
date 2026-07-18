import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import { defineParsedTool, failToolParse } from '../parsed-tool.js';
import {
  commitPreparedDeletion,
  commitPreparedDirectoryCreation,
  commitPreparedRelocation,
  isFileAuthorityRootPath,
  prepareMutatingFilePath,
  prepareRelocationPaths,
  persistPreparedFile,
  FILE_AUTHORITY_ROOT_DELETE_ERROR,
  FILE_AUTHORITY_ROOT_RELOCATE_ERROR,
} from '../../files/file-mutation-chain.js';
import {
  evaluateOperationManifestPreconditions,
  evaluateRelocationPreconditions,
  operationCommitOutcomeFromPreconditionResult,
  prepareOperationManifest,
  type OperationActor,
  type OperationManifest,
} from '../../files/operation-manifest.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
import {
  formatZodToolParseError,
  zodSchemaToToolParameters,
} from '../zod-tool.js';
import type { FileStateCache } from '../../utils/file-state-cache.js';

const MANAGE_FILE_OPERATIONS = [
  'create',
  'rename',
  'move',
  'delete',
  'mkdir',
] as const;

type ManageFilesOperation = (typeof MANAGE_FILE_OPERATIONS)[number];

const manageFilesPathSchema = z
  .string()
  .min(1, 'path is required.')
  .refine((value) => value.trim().length > 0, {
    message: 'path must not be empty.',
  })
  .describe(
    'The target path. Relative paths start from the current directory inside ComputerFileScope.',
  );

const manageFilesDestinationDescription =
  'The destination path for rename/move operations. Relative paths start from the current directory inside ComputerFileScope. Required for rename/move and forbidden for create/mkdir/delete.';

const manageFilesDestinationSchema = z
  .string()
  .describe(manageFilesDestinationDescription);

const manageFilesRelocationDestinationSchema = z
  .string()
  .min(1, 'destination is required.')
  .refine((value) => value.trim().length > 0, {
    message: 'destination is required.',
  })
  .describe(manageFilesDestinationDescription);

const manageFilesArgsSchema = z.strictObject({
  operation: z
    .enum(MANAGE_FILE_OPERATIONS)
    .describe('The file management operation to perform.'),
  path: manageFilesPathSchema,
  destination: manageFilesDestinationSchema.optional(),
});

const manageFilesBranchSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('create'),
    path: manageFilesPathSchema,
  }),
  z.strictObject({
    operation: z.literal('mkdir'),
    path: manageFilesPathSchema,
  }),
  z.strictObject({
    operation: z.literal('delete'),
    path: manageFilesPathSchema,
  }),
  z.strictObject({
    operation: z.literal('rename'),
    path: manageFilesPathSchema,
    destination: manageFilesRelocationDestinationSchema,
  }),
  z.strictObject({
    operation: z.literal('move'),
    path: manageFilesPathSchema,
    destination: manageFilesRelocationDestinationSchema,
  }),
]);

type ManageFilesParsedArgs = z.output<typeof manageFilesBranchSchema>;
type ManageFilesCreateArgs = Extract<
  ManageFilesParsedArgs,
  { operation: 'create' }
>;
type ManageFilesDeleteArgs = Extract<
  ManageFilesParsedArgs,
  { operation: 'delete' }
>;
type ManageFilesMkdirArgs = Extract<
  ManageFilesParsedArgs,
  { operation: 'mkdir' }
>;
type ManageFilesRelocationArgs = Extract<
  ManageFilesParsedArgs,
  { operation: 'rename' | 'move' }
>;

interface ManageFilesExecutionContext {
  callId: string;
  fileStateCache?: FileStateCache;
  root: 'computer';
  runId?: string;
  absoluteRoot: string;
}

export const manageFilesTool = defineParsedTool({
  name: 'manage_files',
  description:
    'Manage files and directories admitted by ComputerFileScope. Supports creating, renaming, moving, deleting files, and creating directories.',
  parameters: zodSchemaToToolParameters(manageFilesBranchSchema),
  strict: true,
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
    searchHints: [
      'rename file',
      'move file',
      'delete file',
      'copy file',
      'manage files',
    ],
    tags: ['file', 'mutation', 'approval'],
    whenToUse: 'Move, rename, copy, or delete computer files.',
    notFor: 'Editing file contents or applying text patches.',
  },
  parseArgs(raw) {
    const flatParsed = manageFilesArgsSchema.safeParse(raw);
    if (!flatParsed.success) {
      return failToolParse(formatZodToolParseError(flatParsed.error));
    }

    const branchParsed = manageFilesBranchSchema.safeParse(flatParsed.data);
    if (branchParsed.success) {
      return { ok: true, value: branchParsed.data };
    }

    return failToolParse(
      formatManageFilesBranchParseError(flatParsed.data.operation),
    );
  },
  async executeParsed(args, ctx) {
    try {
      const sourcePath = resolveComputerFileToolPath(ctx, args.path);
      const executionContext: ManageFilesExecutionContext = {
        callId: ctx.callId,
        absoluteRoot: sourcePath.absoluteRoot,
        root: sourcePath.root,
        ...(ctx.fileStateCache === undefined
          ? {}
          : { fileStateCache: ctx.fileStateCache }),
        ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
      };
      switch (args.operation) {
        case 'create':
          return await createManagedPath(
            { ...args, path: sourcePath.path },
            executionContext,
          );
        case 'delete':
          return await deleteManagedPath(
            { ...args, path: sourcePath.path },
            executionContext,
          );
        case 'mkdir':
          return await mkdirManagedPath(
            { ...args, path: sourcePath.path },
            executionContext,
          );
        case 'rename':
        case 'move': {
          const destinationPath = resolveComputerFileToolPath(
            ctx,
            args.destination,
          );
          return await relocateManagedPath(
            {
              ...args,
              path: sourcePath.path,
              destination: destinationPath.path,
            },
            executionContext,
          );
        }
      }
    } catch (err: unknown) {
      return catchToolError(err);
    }
  },
});

function buildManagedOperationSuccess(payload: Record<string, unknown>): {
  ok: true;
  output: string;
} {
  return {
    ok: true,
    output: JSON.stringify({ ...payload, ok: true }),
  };
}

function formatManageFilesBranchParseError(
  operation: ManageFilesOperation,
): string {
  switch (operation) {
    case 'rename':
    case 'move':
      return `destination is required for ${operation}.`;
    case 'create':
    case 'delete':
    case 'mkdir':
      return `destination is not allowed for ${operation}.`;
  }
}

async function createManagedPath(
  args: ManageFilesCreateArgs,
  context: ManageFilesExecutionContext,
) {
  const { path: inputPath } = args;
  const preparedPath = await prepareMutatingFilePath(
    context.absoluteRoot,
    inputPath,
    {
      allowMissingLeaf: true,
    },
  );
  const { resolvedPath, exists } = preparedPath;
  const manifest = prepareManageFilesCreateManifest(preparedPath, context);
  const precondition = evaluateOperationManifestPreconditions(manifest, [
    {
      canonicalTargetId: resolvedPath.canonicalAbsolutePath,
      exists,
    },
  ]);

  if (precondition.ok === false) {
    const outcome = operationCommitOutcomeFromPreconditionResult(precondition);
    if (outcome.reasonCode !== 'destination_already_exists') {
      return toolError(
        'invalid_args',
        `create precondition failed: ${outcome.reasonCode}`,
      );
    }
    return toolError(
      'already_exists',
      `file already exists: ${resolvedPath.relativePath}. Use write_file to overwrite.`,
    );
  }

  const result = await persistPreparedFile(
    preparedPath,
    '',
    '',
    undefined,
    context.fileStateCache ? { fileStateCache: context.fileStateCache } : {},
  );
  return buildManagedOperationSuccess({
    root: context.root,
    operation: 'create',
    path: result.path,
  });
}

function prepareManageFilesCreateManifest(
  preparedPath: Awaited<ReturnType<typeof prepareMutatingFilePath>>,
  context: ManageFilesExecutionContext,
): OperationManifest {
  return prepareOperationManifest({
    operationId: context.callId,
    manifestRevision: '1',
    operationKind: 'create_file',
    authorityId: context.root,
    actor: buildManageFilesActor(context),
    targets: [
      {
        role: 'destination',
        path: preparedPath.resolvedPath.relativePath,
        canonicalTargetId: preparedPath.resolvedPath.canonicalAbsolutePath,
      },
    ],
    approval: { required: true },
    atomicity: 'best_effort',
    createdAt: new Date().toISOString(),
  });
}

async function deleteManagedPath(
  args: ManageFilesDeleteArgs,
  context: ManageFilesExecutionContext,
) {
  const { path: inputPath } = args;
  const preparedPath = await prepareMutatingFilePath(
    context.absoluteRoot,
    inputPath,
    {
      allowMissingLeaf: true,
    },
  );
  if (isFileAuthorityRootPath(preparedPath.resolvedPath.relativePath)) {
    return toolError('invalid_args', FILE_AUTHORITY_ROOT_DELETE_ERROR);
  }
  const manifest = prepareManageFilesDeleteManifest(preparedPath, context);
  const precondition = evaluateOperationManifestPreconditions(manifest, [
    {
      canonicalTargetId: preparedPath.resolvedPath.canonicalAbsolutePath,
      exists: preparedPath.exists,
    },
  ]);

  if (precondition.ok === false) {
    const outcome = operationCommitOutcomeFromPreconditionResult(precondition);
    if (outcome.reasonCode !== 'source_missing') {
      return toolError(
        'invalid_args',
        `delete precondition failed: ${outcome.reasonCode}`,
      );
    }
    return toolError(
      'not_found',
      `file not found: ${preparedPath.resolvedPath.relativePath}`,
    );
  }

  const result = await commitPreparedDeletion(
    preparedPath,
    context.fileStateCache ? { fileStateCache: context.fileStateCache } : {},
  );

  return buildManagedOperationSuccess({
    root: context.root,
    operation: 'delete',
    path: result.path,
  });
}

function prepareManageFilesDeleteManifest(
  preparedPath: Awaited<ReturnType<typeof prepareMutatingFilePath>>,
  context: ManageFilesExecutionContext,
): OperationManifest {
  return prepareOperationManifest({
    operationId: context.callId,
    manifestRevision: '1',
    operationKind: 'delete',
    authorityId: context.root,
    actor: buildManageFilesActor(context),
    targets: [
      {
        role: 'source',
        path: preparedPath.resolvedPath.relativePath,
        canonicalTargetId: preparedPath.resolvedPath.canonicalAbsolutePath,
      },
    ],
    approval: { required: true },
    atomicity: 'best_effort',
    createdAt: new Date().toISOString(),
  });
}

async function mkdirManagedPath(
  args: ManageFilesMkdirArgs,
  context: ManageFilesExecutionContext,
) {
  const { path: inputPath } = args;
  const preparedPath = await prepareMutatingFilePath(
    context.absoluteRoot,
    inputPath,
    {
      allowMissingLeaf: true,
    },
  );
  const manifest = prepareManageFilesMkdirManifest(preparedPath, context);
  const precondition = evaluateOperationManifestPreconditions(manifest, [
    {
      canonicalTargetId: preparedPath.resolvedPath.canonicalAbsolutePath,
      exists: preparedPath.exists,
    },
  ]);

  if (precondition.ok === false) {
    const outcome = operationCommitOutcomeFromPreconditionResult(precondition);
    if (outcome.reasonCode !== 'destination_already_exists') {
      return toolError(
        'invalid_args',
        `mkdir precondition failed: ${outcome.reasonCode}`,
      );
    }
    return toolError(
      'already_exists',
      `file already exists: ${preparedPath.resolvedPath.relativePath}`,
    );
  }

  const result = await commitPreparedDirectoryCreation(
    preparedPath,
    context.fileStateCache ? { fileStateCache: context.fileStateCache } : {},
  );
  return buildManagedOperationSuccess({
    root: context.root,
    operation: 'mkdir',
    path: result.path,
  });
}

function prepareManageFilesMkdirManifest(
  preparedPath: Awaited<ReturnType<typeof prepareMutatingFilePath>>,
  context: ManageFilesExecutionContext,
): OperationManifest {
  return prepareOperationManifest({
    operationId: context.callId,
    manifestRevision: '1',
    operationKind: 'create_directory',
    authorityId: context.root,
    actor: buildManageFilesActor(context),
    targets: [
      {
        role: 'destination',
        path: preparedPath.resolvedPath.relativePath,
        canonicalTargetId: preparedPath.resolvedPath.canonicalAbsolutePath,
      },
    ],
    approval: { required: true },
    atomicity: 'best_effort',
    createdAt: new Date().toISOString(),
  });
}

async function relocateManagedPath(
  args: ManageFilesRelocationArgs,
  context: ManageFilesExecutionContext,
) {
  const { operation, path: inputPath, destination } = args;
  const preparedPaths = await prepareRelocationPaths(
    context.absoluteRoot,
    inputPath,
    destination,
  );
  const { sourcePath, destinationPath, destinationExists } = preparedPaths;
  if (isFileAuthorityRootPath(sourcePath.relativePath)) {
    return toolError('invalid_args', FILE_AUTHORITY_ROOT_RELOCATE_ERROR);
  }

  const manifest = prepareManageFilesRelocationManifest(
    operation,
    preparedPaths,
    context,
  );
  const sourceTarget = manifest.targets[0]!;
  const destinationTarget = manifest.targets[1]!;

  const relocationPrecondition = evaluateRelocationPreconditions(
    sourceTarget,
    destinationTarget,
    {
      canonicalTargetId: destinationPath.canonicalAbsolutePath,
      exists: destinationExists,
    },
  );
  if (relocationPrecondition.ok === false) {
    const outcome = operationCommitOutcomeFromPreconditionResult(
      relocationPrecondition,
    );
    switch (outcome.reasonCode) {
      case 'same_canonical_target':
        return toolError(
          'invalid_args',
          `source and destination resolve to the same target: ${sourcePath.relativePath}`,
        );
      case 'destination_already_exists':
        return toolError(
          'already_exists',
          `destination already exists: ${destinationPath.relativePath}`,
        );
      case 'destination_inside_source':
        return toolError(
          'invalid_args',
          `cannot relocate a directory into itself: ${sourcePath.relativePath}`,
        );
      default:
        return toolError(
          'invalid_args',
          `relocation precondition failed: ${relocationPrecondition.reasonCode}`,
        );
    }
  }

  const result = await commitPreparedRelocation(
    preparedPaths,
    context.fileStateCache ? { fileStateCache: context.fileStateCache } : {},
  );
  return buildManagedOperationSuccess({
    root: context.root,
    operation,
    from: result.from,
    to: result.to,
  });
}

function prepareManageFilesRelocationManifest(
  operation: ManageFilesRelocationArgs['operation'],
  preparedPaths: Awaited<ReturnType<typeof prepareRelocationPaths>>,
  context: ManageFilesExecutionContext,
): OperationManifest {
  return prepareOperationManifest({
    operationId: context.callId,
    manifestRevision: '1',
    operationKind: operation,
    authorityId: context.root,
    actor: buildManageFilesActor(context),
    targets: [
      {
        role: 'source',
        path: preparedPaths.sourcePath.relativePath,
        canonicalTargetId: preparedPaths.sourcePath.canonicalAbsolutePath,
        expectedKind: preparedPaths.sourceKind,
      },
      {
        role: 'destination',
        path: preparedPaths.destinationPath.relativePath,
        canonicalTargetId: preparedPaths.destinationPath.canonicalAbsolutePath,
      },
    ],
    approval: { required: true },
    atomicity: 'best_effort',
    createdAt: new Date().toISOString(),
  });
}

function buildManageFilesActor(
  context: ManageFilesExecutionContext,
): OperationActor {
  return context.runId
    ? { kind: 'assistant', runId: context.runId }
    : { kind: 'daemon' };
}
