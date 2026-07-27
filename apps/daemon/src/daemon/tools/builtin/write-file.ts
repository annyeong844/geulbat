import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import {
  AlreadyExistsWriteTargetError,
  MissingWriteTargetError,
  StaleWriteError,
} from '../../files/file-domain-error.js';
import {
  prepareMutatingFilePath,
  persistPreparedFile,
} from '../../files/file-mutation-chain.js';
import {
  evaluateOperationManifestPreconditions,
  operationManifestToJsonValue,
  parseOperationManifest,
  prepareOperationManifest,
  type OperationActor,
  type OperationManifest,
} from '../../files/operation-manifest.js';
import { readResolvedFile } from '../../files/read-file.js';
import { normalizeTextContent } from '../../files/text-content.js';
import { createVersionToken } from '../../files/version-token.js';
import type { RunCheckpointToolInvocation } from '../../runtime-contracts.js';
import type { FileStateCache } from '../../utils/file-state-cache.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
import {
  recordDurableToolInvocation,
  recordDurableToolInvocationResult,
  resolveDurableToolInvocation,
  type DurableToolInvocationContext,
} from '../tool-invocation-durability.js';
import type { ExecuteResult } from '../types.js';
import { defineZodTool } from '../zod-tool.js';

const writeFileArgsSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'path is required.')
    .refine((value) => value.trim().length > 0, {
      message: 'path must not be empty.',
    })
    .describe(
      'The host path to write. Relative paths start from the current directory; absolute paths may address any location writable by the daemon process.',
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

type WriteFileParsedArgs = z.output<typeof writeFileArgsSchema>;

interface WriteFileExecutionContext {
  callId: string;
  fileStateCache?: FileStateCache;
  root: 'computer';
  runId?: string;
  absoluteRoot: string;
  durability?: DurableToolInvocationContext;
}

type PreparedWriteFile = Awaited<ReturnType<typeof prepareMutatingFilePath>>;

type ObservedWriteFileTarget =
  | {
      exists: false;
      canonicalTargetId: string;
    }
  | {
      exists: true;
      canonicalTargetId: string;
      kind: 'directory';
    }
  | {
      exists: true;
      canonicalTargetId: string;
      kind: 'file';
      path: string;
      versionToken: string;
      totalLines: number;
    };

type WriteFileRecoveryDecision =
  | { kind: 'replay' }
  | { kind: 'settled'; result: ExecuteResult };

export const writeFileTool = defineZodTool({
  name: 'write_file',
  description:
    'Atomically write content to the host filesystem. Relative paths start from cwd; absolute paths are independent of cwd. Creates the file if it does not exist, or overwrites it if it does. Parent directories are created as needed, and symlink targets are supported.',
  argsSchema: writeFileArgsSchema,
  sideEffectLevel: 'write',
  mayMutateComputerFiles: true,
  requiresApproval: true,
  recoveryStrategy: 'reconcile_then_replay',
  catalogSearchMetadata: {
    family: 'file',
    searchHints: ['write file', 'create file', 'save file'],
    tags: ['file', 'mutation', 'approval'],
    whenToUse: 'Create a new file or write full file content.',
    notFor: 'Small exact replacements in existing files.',
  },
  async executeParsed(args, ctx) {
    try {
      const filePath = resolveComputerFileToolPath(ctx, args.path);
      const resolvedArgs = { ...args, path: filePath.path };
      const versionToken = resolvedArgs.versionToken ?? '';
      const hasNonEmptyVersionToken = versionToken.trim().length > 0;
      const preparedFile = await prepareMutatingFilePath(
        filePath.absoluteRoot,
        filePath.path,
        { allowMissingLeaf: true },
      );
      const { exists } = preparedFile;
      const durability = await resolveDurableToolInvocation(
        ctx,
        writeFileTool.name,
      );
      const executionContext: WriteFileExecutionContext = {
        callId: ctx.callId,
        absoluteRoot: filePath.absoluteRoot,
        root: filePath.root,
        ...(ctx.fileStateCache === undefined
          ? {}
          : { fileStateCache: ctx.fileStateCache }),
        ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
        ...(durability === undefined ? {} : { durability }),
      };
      if (durability?.invocation !== undefined) {
        return await recoverWriteFileOperation({
          args: resolvedArgs,
          context: executionContext,
          invocation: durability.invocation,
        });
      }
      if (exists && !hasNonEmptyVersionToken) {
        return toolError(
          'invalid_args',
          'versionToken is required when overwriting an existing file.',
        );
      }
      const manifest = prepareWriteFileOperationManifest({
        args: resolvedArgs,
        preparedFile,
        context: executionContext,
      });
      return await executeWriteFileOperation({
        args: resolvedArgs,
        preparedFile,
        context: executionContext,
        manifest,
      });
    } catch (err: unknown) {
      return catchToolError(err);
    }
  },
});

async function executeWriteFileOperation(args: {
  args: WriteFileParsedArgs;
  preparedFile: PreparedWriteFile;
  context: WriteFileExecutionContext;
  manifest: OperationManifest;
}): Promise<ExecuteResult> {
  const durability = args.context.durability;
  if (durability === undefined) {
    return await commitWriteFileOperation(args);
  }
  const recorded = await recordDurableToolInvocation({
    durability,
    callId: args.context.callId,
    toolName: writeFileTool.name,
    recoveryStrategy: 'reconcile_then_replay',
    recoveryState: operationManifestToJsonValue(args.manifest),
  });
  if (!recorded.changed) {
    return await recoverWriteFileOperation({
      args: args.args,
      context: args.context,
      invocation: recorded.invocation,
    });
  }

  let result: ExecuteResult;
  try {
    result = await commitWriteFileOperation(args);
  } catch (error: unknown) {
    const decision = await reconcileWriteFileOperationState({
      args: args.args,
      context: args.context,
      manifest: args.manifest,
    });
    result =
      decision.kind === 'settled' ? decision.result : catchToolError(error);
  }
  await recordWriteFileInvocationResult({
    context: args.context,
    result,
  });
  return result;
}

async function commitWriteFileOperation(args: {
  args: WriteFileParsedArgs;
  preparedFile: PreparedWriteFile;
  context: WriteFileExecutionContext;
}): Promise<ExecuteResult> {
  const result = await persistPreparedFile(
    args.preparedFile,
    args.args.content,
    args.args.versionToken ?? '',
    undefined,
    args.context.fileStateCache
      ? { fileStateCache: args.context.fileStateCache }
      : {},
  );
  return buildWriteFileSuccess({
    root: args.context.root,
    path: result.path,
    versionToken: result.versionToken,
    totalLines: result.totalLines,
    mode: writeFileOperationMode(args.args),
  });
}

async function recoverWriteFileOperation(args: {
  args: WriteFileParsedArgs;
  context: WriteFileExecutionContext;
  invocation: RunCheckpointToolInvocation;
}): Promise<ExecuteResult> {
  const { context, invocation } = args;
  if (
    invocation.callId !== context.callId ||
    invocation.toolName !== writeFileTool.name ||
    invocation.recoveryStrategy !== 'reconcile_then_replay'
  ) {
    throw new Error('write_file recovery invocation identity conflicts');
  }
  const manifest = parseOperationManifest(invocation.recoveryState);
  if (
    manifest === null ||
    !(await doesWriteFileManifestMatchInvocation({
      args: args.args,
      context,
      manifest,
    }))
  ) {
    throw new Error('write_file recovery manifest is invalid');
  }
  if (invocation.status === 'reconciled') {
    return invocation.result;
  }

  const decision = await reconcileWriteFileOperationState({
    args: args.args,
    context,
    manifest,
  });
  let result: ExecuteResult;
  if (decision.kind === 'settled') {
    result = decision.result;
  } else {
    try {
      result = await replayWriteFileOperation(args.args, context);
    } catch (error: unknown) {
      result = catchToolError(error);
    }
    const afterReplay = await reconcileWriteFileOperationState({
      args: args.args,
      context,
      manifest,
    });
    if (afterReplay.kind === 'settled') {
      result = afterReplay.result;
    }
  }
  await recordWriteFileInvocationResult({ context, result });
  return result;
}

async function recordWriteFileInvocationResult(args: {
  context: WriteFileExecutionContext;
  result: ExecuteResult;
}): Promise<void> {
  await recordDurableToolInvocationResult({
    durability: args.context.durability,
    callId: args.context.callId,
    toolName: writeFileTool.name,
    result: args.result,
  });
}

async function replayWriteFileOperation(
  args: WriteFileParsedArgs,
  context: WriteFileExecutionContext,
): Promise<ExecuteResult> {
  const preparedFile = await prepareMutatingFilePath(
    context.absoluteRoot,
    args.path,
    { allowMissingLeaf: true },
  );
  return await commitWriteFileOperation({ args, context, preparedFile });
}

async function reconcileWriteFileOperationState(args: {
  args: WriteFileParsedArgs;
  context: WriteFileExecutionContext;
  manifest: OperationManifest;
}): Promise<WriteFileRecoveryDecision> {
  if (
    !(await doesWriteFileManifestMatchInvocation({
      args: args.args,
      context: args.context,
      manifest: args.manifest,
    }))
  ) {
    return {
      kind: 'settled',
      result: buildWriteFileRecoveryConflict(
        'target no longer matches its durable manifest',
      ),
    };
  }
  const target = args.manifest.targets[0];
  const payloadDigest = args.manifest.payloadDigest;
  if (target === undefined || payloadDigest?.kind !== 'content') {
    return {
      kind: 'settled',
      result: buildWriteFileRecoveryConflict('durable manifest is incomplete'),
    };
  }
  const targetPath = target.path ?? args.args.path;
  const observation = await observeWriteFileTarget(
    args.context.absoluteRoot,
    args.args.path,
  );
  if (
    observation.exists &&
    observation.kind === 'file' &&
    observation.versionToken === payloadDigest.digest
  ) {
    return {
      kind: 'settled',
      result: buildWriteFileSuccess({
        root: args.context.root,
        path: observation.path,
        versionToken: observation.versionToken,
        totalLines: observation.totalLines,
        mode: writeFileOperationMode(args.args),
      }),
    };
  }

  const precondition = evaluateOperationManifestPreconditions(args.manifest, [
    {
      canonicalTargetId: observation.canonicalTargetId,
      exists: observation.exists,
      ...(observation.exists ? { kind: observation.kind } : {}),
    },
  ]);
  if (!precondition.ok) {
    switch (precondition.reasonCode) {
      case 'destination_already_exists':
      case 'target_already_exists':
        return {
          kind: 'settled',
          result: catchToolError(new AlreadyExistsWriteTargetError(targetPath)),
        };
      case 'source_missing':
      case 'target_missing':
        return {
          kind: 'settled',
          result: catchToolError(new MissingWriteTargetError(targetPath)),
        };
      case 'kind_mismatch':
      case 'path_alias_violation':
        return {
          kind: 'settled',
          result: buildWriteFileRecoveryConflict(
            'target kind or canonical path changed',
          ),
        };
    }
  }

  if (args.manifest.operationKind === 'create_file') {
    return { kind: 'replay' };
  }
  if (
    observation.exists &&
    observation.kind === 'file' &&
    observation.versionToken === target.expectedVersionToken
  ) {
    return { kind: 'replay' };
  }
  if (observation.exists && observation.kind === 'file') {
    return {
      kind: 'settled',
      result: catchToolError(
        new StaleWriteError(targetPath, observation.versionToken),
      ),
    };
  }
  return {
    kind: 'settled',
    result: buildWriteFileRecoveryConflict('target state is ambiguous'),
  };
}

async function doesWriteFileManifestMatchInvocation(args: {
  args: WriteFileParsedArgs;
  context: WriteFileExecutionContext;
  manifest: OperationManifest;
}): Promise<boolean> {
  const target = args.manifest.targets[0];
  const expectedVersionToken = args.args.versionToken?.trim();
  const isOverwrite = expectedVersionToken !== undefined;
  const actor = buildWriteFileActor(args.context);
  const canonicalContent = normalizeTextContent(args.args.content);
  if (
    args.manifest.operationId !== args.context.callId ||
    args.manifest.operationKind !==
      (isOverwrite ? 'overwrite' : 'create_file') ||
    args.manifest.authorityId !== args.context.root ||
    args.manifest.actor.kind !== actor.kind ||
    args.manifest.actor.runId !== actor.runId ||
    args.manifest.targets.length !== 1 ||
    target === undefined ||
    target.role !== (isOverwrite ? 'single' : 'destination') ||
    target.existence !== (isOverwrite ? 'must_exist' : 'must_not_exist') ||
    target.expectedKind !== (isOverwrite ? 'file' : undefined) ||
    target.expectedVersionToken !== expectedVersionToken ||
    args.manifest.payloadDigest?.kind !== 'content' ||
    args.manifest.payloadDigest.digest !==
      createVersionToken(canonicalContent) ||
    args.manifest.atomicity !== 'atomic'
  ) {
    return false;
  }
  const preparedFile = await prepareMutatingFilePath(
    args.context.absoluteRoot,
    args.args.path,
    { allowMissingLeaf: true },
  );
  return (
    preparedFile.resolvedPath.relativePath === target.path &&
    preparedFile.resolvedPath.canonicalAbsolutePath === target.canonicalTargetId
  );
}

async function observeWriteFileTarget(
  absoluteRoot: string,
  path: string,
): Promise<ObservedWriteFileTarget> {
  const preparedFile = await prepareMutatingFilePath(absoluteRoot, path, {
    allowMissingLeaf: true,
  });
  const canonicalTargetId = preparedFile.resolvedPath.canonicalAbsolutePath;
  if (!preparedFile.exists) {
    return { exists: false, canonicalTargetId };
  }
  if (preparedFile.pathKind === 'directory') {
    return { exists: true, canonicalTargetId, kind: 'directory' };
  }
  const file = await readResolvedFile(preparedFile.resolvedPath);
  return {
    exists: true,
    canonicalTargetId,
    kind: 'file',
    path: file.path,
    versionToken: file.versionToken,
    totalLines: file.totalLines,
  };
}

function prepareWriteFileOperationManifest(args: {
  args: WriteFileParsedArgs;
  preparedFile: PreparedWriteFile;
  context: WriteFileExecutionContext;
}): OperationManifest {
  const expectedVersionToken = args.args.versionToken?.trim();
  const isOverwrite = expectedVersionToken !== undefined;
  const canonicalContent = normalizeTextContent(args.args.content);
  return prepareOperationManifest({
    operationId: args.context.callId,
    manifestRevision: '1',
    operationKind: isOverwrite ? 'overwrite' : 'create_file',
    authorityId: args.context.root,
    actor: buildWriteFileActor(args.context),
    targets: [
      {
        role: isOverwrite ? 'single' : 'destination',
        path: args.preparedFile.resolvedPath.relativePath,
        canonicalTargetId: args.preparedFile.resolvedPath.canonicalAbsolutePath,
        ...(expectedVersionToken === undefined
          ? {}
          : {
              expectedKind: 'file',
              expectedVersionToken,
            }),
      },
    ],
    approval: { required: true },
    payloadDigest: {
      kind: 'content',
      digest: createVersionToken(canonicalContent),
    },
    atomicity: 'atomic',
    createdAt: new Date().toISOString(),
  });
}

function buildWriteFileActor(
  context: WriteFileExecutionContext,
): OperationActor {
  return context.runId
    ? { kind: 'assistant', runId: context.runId }
    : { kind: 'daemon' };
}

function writeFileOperationMode(
  args: WriteFileParsedArgs,
): 'created' | 'overwritten' {
  return args.versionToken === undefined ? 'created' : 'overwritten';
}

function buildWriteFileSuccess(args: {
  root: 'computer';
  path: string;
  versionToken: string;
  totalLines: number;
  mode: 'created' | 'overwritten';
}): ExecuteResult {
  return {
    ok: true,
    output: JSON.stringify({
      root: args.root,
      path: args.path,
      ok: true,
      versionToken: args.versionToken,
      totalLines: args.totalLines,
      mode: args.mode,
    }),
  };
}

function buildWriteFileRecoveryConflict(detail: string): ExecuteResult {
  return toolError('conflict', `write_file recovery ${detail}`);
}
