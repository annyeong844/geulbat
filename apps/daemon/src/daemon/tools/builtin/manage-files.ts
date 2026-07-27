import { lstat } from 'node:fs/promises';

import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import { defineParsedTool, failToolParse } from '../parsed-tool.js';
import {
  commitPreparedDeletion,
  commitPreparedDirectoryCreation,
  commitPreparedRelocation,
  createPreparedPathFingerprint,
  prepareMutatingFilePath,
  prepareRelocationPaths,
  persistPreparedFile,
} from '../../files/file-mutation-chain.js';
import {
  evaluateOperationManifestPreconditions,
  evaluateRelocationPreconditions,
  operationCommitOutcomeFromPreconditionResult,
  operationManifestToJsonValue,
  parseOperationManifest,
  prepareOperationManifest,
  type OperationActor,
  type OperationManifest,
} from '../../files/operation-manifest.js';
import type { RunCheckpointToolInvocation } from '../../runtime-contracts.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
import {
  recordDurableToolInvocation,
  recordDurableToolInvocationResult,
  resolveDurableToolInvocation,
  type DurableToolInvocationContext,
} from '../tool-invocation-durability.js';
import {
  formatZodToolParseError,
  zodSchemaToToolParameters,
} from '../zod-tool.js';
import type { FileStateCache } from '../../utils/file-state-cache.js';
import { hasErrorCode } from '../../utils/error.js';
import type { ExecuteResult } from '../types.js';

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
  .describe('The source or target host path.');

const manageFilesDestinationDescription =
  'The destination host path. Required for rename/move and forbidden for create/mkdir/delete.';

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
  durability?: DurableToolInvocationContext;
}

type ManageFilesCommit = () => Promise<ExecuteResult>;

type ObservedManageFilesTarget =
  | { exists: false }
  | {
      exists: true;
      kind: 'file' | 'directory';
      isRegularFile: boolean;
      size: number;
      identityToken: string;
      versionToken: string;
    };

type ManageFilesRecoveryDecision =
  | { kind: 'settled'; result: ExecuteResult }
  | { kind: 'replay' };

export const manageFilesTool = defineParsedTool({
  name: 'manage_files',
  description:
    'Manage host files and directories using OS permissions and approval as the authority boundary. Path and destination are host paths: relative paths start from the current directory, while absolute paths may address any location accessible to the daemon process. Supports creating, renaming, moving, deleting files, and creating directories; deleting or moving a symlink acts on the link itself.',
  parameters: zodSchemaToToolParameters(manageFilesBranchSchema),
  strict: true,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: true,
  requiresApproval: true,
  recoveryStrategy: 'reconcile_then_replay',
  exposure: {
    directHot: true,
    sdkVisible: false,
    inCellCallable: false,
    directOnly: true,
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
      let resolvedArgs: ManageFilesParsedArgs;
      switch (args.operation) {
        case 'create':
        case 'delete':
        case 'mkdir':
          resolvedArgs = { ...args, path: sourcePath.path };
          break;
        case 'rename':
        case 'move': {
          const destinationPath = resolveComputerFileToolPath(
            ctx,
            args.destination,
          );
          resolvedArgs = {
            ...args,
            path: sourcePath.path,
            destination: destinationPath.path,
          };
          break;
        }
      }
      const durability = await resolveDurableToolInvocation(
        ctx,
        manageFilesTool.name,
      );
      const executionContext: ManageFilesExecutionContext = {
        callId: ctx.callId,
        absoluteRoot: sourcePath.absoluteRoot,
        root: sourcePath.root,
        ...(ctx.fileStateCache === undefined
          ? {}
          : { fileStateCache: ctx.fileStateCache }),
        ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
        ...(durability === undefined ? {} : { durability }),
      };
      if (durability?.invocation !== undefined) {
        return await recoverManageFilesOperation({
          args: resolvedArgs,
          context: executionContext,
          invocation: durability.invocation,
        });
      }
      switch (resolvedArgs.operation) {
        case 'create':
          return await createManagedPath(resolvedArgs, executionContext);
        case 'delete':
          return await deleteManagedPath(resolvedArgs, executionContext);
        case 'mkdir':
          return await mkdirManagedPath(resolvedArgs, executionContext);
        case 'rename':
        case 'move':
          return await relocateManagedPath(resolvedArgs, executionContext);
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

async function executeManageFilesOperation(args: {
  args: ManageFilesParsedArgs;
  manifest: OperationManifest;
  context: ManageFilesExecutionContext;
  commit: ManageFilesCommit;
}): Promise<ExecuteResult> {
  const { context, manifest } = args;
  const durability = context.durability;
  if (durability === undefined) {
    return await args.commit();
  }
  const recorded = await recordDurableToolInvocation({
    durability,
    callId: context.callId,
    toolName: manageFilesTool.name,
    recoveryStrategy: 'reconcile_then_replay',
    recoveryState: operationManifestToJsonValue(manifest),
  });
  if (!recorded.changed) {
    return await recoverManageFilesOperation({
      args: args.args,
      context,
      invocation: recorded.invocation,
    });
  }

  let result: ExecuteResult;
  try {
    result = await args.commit();
  } catch (error: unknown) {
    const decision = await reconcileManageFilesOperationState({
      args: args.args,
      context,
      manifest,
    });
    result =
      decision.kind === 'settled' ? decision.result : catchToolError(error);
  }
  await recordManageFilesInvocationResult({ context, result });
  return result;
}

async function recoverManageFilesOperation(args: {
  args: ManageFilesParsedArgs;
  context: ManageFilesExecutionContext;
  invocation: RunCheckpointToolInvocation;
}): Promise<ExecuteResult> {
  const { context, invocation } = args;
  if (
    invocation.callId !== context.callId ||
    invocation.toolName !== manageFilesTool.name ||
    invocation.recoveryStrategy !== 'reconcile_then_replay'
  ) {
    throw new Error('manage_files recovery invocation identity conflicts');
  }
  const manifest = parseOperationManifest(invocation.recoveryState);
  if (
    manifest === null ||
    !(await doesManageFilesManifestMatchInvocation({
      args: args.args,
      context,
      manifest,
    }))
  ) {
    throw new Error('manage_files recovery manifest is invalid');
  }
  if (invocation.status === 'reconciled') {
    return invocation.result;
  }

  const decision = await reconcileManageFilesOperationState({
    args: args.args,
    context,
    manifest,
  });
  let result: ExecuteResult;
  if (decision.kind === 'settled') {
    result = decision.result;
  } else {
    try {
      result = await replayManageFilesOperation(args.args, context);
    } catch (error: unknown) {
      result = catchToolError(error);
    }
    const afterReplay = await reconcileManageFilesOperationState({
      args: args.args,
      context,
      manifest,
    });
    if (afterReplay.kind === 'settled') {
      result = afterReplay.result;
    }
  }
  await recordManageFilesInvocationResult({ context, result });
  return result;
}

async function recordManageFilesInvocationResult(args: {
  context: ManageFilesExecutionContext;
  result: ExecuteResult;
}): Promise<void> {
  await recordDurableToolInvocationResult({
    durability: args.context.durability,
    callId: args.context.callId,
    toolName: manageFilesTool.name,
    result: args.result,
  });
}

async function reconcileManageFilesOperationState(args: {
  args: ManageFilesParsedArgs;
  context: ManageFilesExecutionContext;
  manifest: OperationManifest;
}): Promise<ManageFilesRecoveryDecision> {
  if (
    !(await doesManageFilesManifestMatchInvocation({
      args: args.args,
      context: args.context,
      manifest: args.manifest,
    }))
  ) {
    return {
      kind: 'settled',
      result: toolError(
        'conflict',
        'manage_files recovery target no longer matches its durable manifest',
      ),
    };
  }
  const source = await observeManageFilesTarget(
    args.manifest.targets[0]?.canonicalTargetId,
  );
  switch (args.args.operation) {
    case 'create':
      if (!source.exists) {
        return { kind: 'replay' };
      }
      return {
        kind: 'settled',
        result:
          source.isRegularFile && source.size === 0
            ? buildManagedOperationSuccess({
                root: args.context.root,
                operation: 'create',
                path: args.manifest.targets[0]?.path,
              })
            : buildManageFilesRecoveryConflict('create'),
      };
    case 'mkdir':
      if (!source.exists) {
        return { kind: 'replay' };
      }
      return {
        kind: 'settled',
        result:
          source.kind === 'directory'
            ? buildManagedOperationSuccess({
                root: args.context.root,
                operation: 'mkdir',
                path: args.manifest.targets[0]?.path,
              })
            : buildManageFilesRecoveryConflict('mkdir'),
      };
    case 'delete':
      if (!source.exists) {
        return {
          kind: 'settled',
          result: buildManagedOperationSuccess({
            root: args.context.root,
            operation: 'delete',
            path: args.manifest.targets[0]?.path,
          }),
        };
      }
      return matchesManifestTarget(source, args.manifest.targets[0])
        ? { kind: 'replay' }
        : {
            kind: 'settled',
            result: buildManageFilesRecoveryConflict('delete'),
          };
    case 'rename':
    case 'move': {
      const destination = await observeManageFilesTarget(
        args.manifest.targets[1]?.canonicalTargetId,
      );
      const sourceTarget = args.manifest.targets[0];
      if (
        !source.exists &&
        destination.exists &&
        destination.identityToken === sourceTarget?.expectedIdentityToken &&
        destination.kind === sourceTarget.expectedKind
      ) {
        return {
          kind: 'settled',
          result: buildManagedOperationSuccess({
            root: args.context.root,
            operation: args.args.operation,
            from: sourceTarget.path,
            to: args.manifest.targets[1]?.path,
          }),
        };
      }
      if (
        source.exists &&
        !destination.exists &&
        matchesManifestTarget(source, sourceTarget)
      ) {
        return { kind: 'replay' };
      }
      return {
        kind: 'settled',
        result: buildManageFilesRecoveryConflict(args.args.operation),
      };
    }
  }
}

async function doesManageFilesManifestMatchInvocation(args: {
  args: ManageFilesParsedArgs;
  context: ManageFilesExecutionContext;
  manifest: OperationManifest;
}): Promise<boolean> {
  if (
    args.manifest.operationId !== args.context.callId ||
    args.manifest.operationKind !==
      manageFilesOperationKind(args.args.operation) ||
    args.manifest.authorityId !== args.context.root ||
    args.manifest.actor.runId !== args.context.runId
  ) {
    return false;
  }
  const paths =
    args.args.operation === 'rename' || args.args.operation === 'move'
      ? [args.args.path, args.args.destination]
      : [args.args.path];
  if (args.manifest.targets.length !== paths.length) {
    return false;
  }
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const target = args.manifest.targets[index];
    if (path === undefined || target?.canonicalTargetId === undefined) {
      return false;
    }
    const prepared = await prepareMutatingFilePath(
      args.context.absoluteRoot,
      path,
      { allowMissingLeaf: true },
    );
    if (
      prepared.resolvedPath.canonicalAbsolutePath !==
        target.canonicalTargetId ||
      prepared.resolvedPath.relativePath !== target.path
    ) {
      return false;
    }
  }
  return true;
}

async function observeManageFilesTarget(
  canonicalTargetId: string | undefined,
): Promise<ObservedManageFilesTarget> {
  if (canonicalTargetId === undefined) {
    return { exists: false };
  }
  try {
    const stats = await lstat(canonicalTargetId);
    const kind = stats.isDirectory() ? 'directory' : 'file';
    const fingerprint = createPreparedPathFingerprint(stats, kind);
    return {
      exists: true,
      kind,
      isRegularFile: stats.isFile(),
      size: stats.size,
      identityToken: fingerprint.pathIdentityToken,
      versionToken: fingerprint.pathVersionToken,
    };
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
      return { exists: false };
    }
    throw error;
  }
}

function matchesManifestTarget(
  observation: Extract<ObservedManageFilesTarget, { exists: true }>,
  target: OperationManifest['targets'][number] | undefined,
): boolean {
  return (
    target !== undefined &&
    observation.kind === target.expectedKind &&
    observation.identityToken === target.expectedIdentityToken &&
    observation.versionToken === target.expectedVersionToken
  );
}

async function replayManageFilesOperation(
  args: ManageFilesParsedArgs,
  context: ManageFilesExecutionContext,
): Promise<ExecuteResult> {
  const replayContext: ManageFilesExecutionContext = {
    callId: context.callId,
    absoluteRoot: context.absoluteRoot,
    root: context.root,
    ...(context.fileStateCache === undefined
      ? {}
      : { fileStateCache: context.fileStateCache }),
    ...(context.runId === undefined ? {} : { runId: context.runId }),
  };
  switch (args.operation) {
    case 'create':
      return await createManagedPath(args, replayContext);
    case 'delete':
      return await deleteManagedPath(args, replayContext);
    case 'mkdir':
      return await mkdirManagedPath(args, replayContext);
    case 'rename':
    case 'move':
      return await relocateManagedPath(args, replayContext);
  }
}

function buildManageFilesRecoveryConflict(
  operation: ManageFilesOperation,
): ExecuteResult {
  return toolError(
    'conflict',
    `manage_files ${operation} recovery found authoritative state that does not match the durable operation`,
  );
}

function manageFilesOperationKind(
  operation: ManageFilesOperation,
): OperationManifest['operationKind'] {
  switch (operation) {
    case 'create':
      return 'create_file';
    case 'mkdir':
      return 'create_directory';
    case 'delete':
      return 'delete';
    case 'rename':
      return 'rename';
    case 'move':
      return 'move';
  }
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

  return await executeManageFilesOperation({
    args,
    manifest,
    context,
    commit: async () => {
      if (precondition.ok === false) {
        const outcome =
          operationCommitOutcomeFromPreconditionResult(precondition);
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
        context.fileStateCache
          ? { fileStateCache: context.fileStateCache }
          : {},
      );
      return buildManagedOperationSuccess({
        root: context.root,
        operation: 'create',
        path: result.path,
      });
    },
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
  const manifest = prepareManageFilesDeleteManifest(preparedPath, context);
  const precondition = evaluateOperationManifestPreconditions(manifest, [
    {
      canonicalTargetId: preparedPath.resolvedPath.canonicalAbsolutePath,
      exists: preparedPath.exists,
      ...(preparedPath.pathKind === undefined
        ? {}
        : { kind: preparedPath.pathKind }),
    },
  ]);

  return await executeManageFilesOperation({
    args,
    manifest,
    context,
    commit: async () => {
      if (precondition.ok === false) {
        const outcome =
          operationCommitOutcomeFromPreconditionResult(precondition);
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
        context.fileStateCache
          ? { fileStateCache: context.fileStateCache }
          : {},
      );
      return buildManagedOperationSuccess({
        root: context.root,
        operation: 'delete',
        path: result.path,
      });
    },
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
        ...(preparedPath.pathKind === undefined
          ? {}
          : { expectedKind: preparedPath.pathKind }),
        ...(preparedPath.pathIdentityToken === undefined
          ? {}
          : { expectedIdentityToken: preparedPath.pathIdentityToken }),
        ...(preparedPath.pathVersionToken === undefined
          ? {}
          : { expectedVersionToken: preparedPath.pathVersionToken }),
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

  return await executeManageFilesOperation({
    args,
    manifest,
    context,
    commit: async () => {
      if (precondition.ok === false) {
        const outcome =
          operationCommitOutcomeFromPreconditionResult(precondition);
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
        context.fileStateCache
          ? { fileStateCache: context.fileStateCache }
          : {},
      );
      return buildManagedOperationSuccess({
        root: context.root,
        operation: 'mkdir',
        path: result.path,
      });
    },
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
  return await executeManageFilesOperation({
    args,
    manifest,
    context,
    commit: async () => {
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
        context.fileStateCache
          ? { fileStateCache: context.fileStateCache }
          : {},
      );
      return buildManagedOperationSuccess({
        root: context.root,
        operation,
        from: result.from,
        to: result.to,
      });
    },
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
        expectedIdentityToken: preparedPaths.sourceIdentityToken,
        expectedVersionToken: preparedPaths.sourceVersionToken,
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
