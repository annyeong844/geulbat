import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import {
  AlreadyExistsWriteTargetError,
  MissingWriteTargetError,
  StaleWriteError,
} from '../../files/file-domain-error.js';
import {
  prepareMutatingFilePath,
  preparePatchFile,
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
import {
  countTextLines,
  normalizeTextContent,
} from '../../files/text-content.js';
import { createVersionToken } from '../../files/version-token.js';
import type { RunCheckpointToolInvocation } from '../../runtime-contracts.js';
import { isRecord, type JsonValue } from '../../runtime-json.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
import {
  recordDurableToolInvocation,
  recordDurableToolInvocationResult,
  resolveDurableToolInvocation,
  type DurableToolInvocationContext,
} from '../tool-invocation-durability.js';
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

type ApplyPatchParsedArgs = z.output<typeof applyPatchArgsSchema>;

interface ApplyPatchExecutionContext {
  callId: string;
  fileStateCache?: FileStateCache;
  root: 'computer';
  runId?: string;
  absoluteRoot: string;
  durability?: DurableToolInvocationContext;
}

type PreparedAddPatchOperation = {
  kind: 'add';
  operation: Extract<ApplyPatchOperation, { kind: 'add' }>;
  preparedPath: Awaited<ReturnType<typeof prepareMutatingFilePath>>;
  content: string;
  linesChanged: number;
};

type PreparedUpdatePatchOperation = {
  kind: 'update';
  operation: Extract<ApplyPatchOperation, { kind: 'update' }>;
  preparedFile: Awaited<ReturnType<typeof preparePatchFile>>;
  content: string;
  linesChanged: number;
};

type PreparedApplyPatchOperation =
  | PreparedAddPatchOperation
  | PreparedUpdatePatchOperation;

type ObservedApplyPatchTarget =
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
      content: string;
      kind: 'file';
      path: string;
      versionToken: string;
      totalLines: number;
    };

type ApplyPatchRecoveryDecision =
  | { kind: 'replay' }
  | { kind: 'settled'; result: ExecuteResult };

interface ApplyPatchRecoveryState {
  manifest: OperationManifest;
  patchDigest: string;
}

export const applyPatchTool = defineZodTool({
  name: 'apply_patch',
  description:
    'Apply one non-destructive file patch using a patch text block. Supports Add File and Update File sections. Update hunks must include exact context and match the current file exactly once. Delete File is owned by manage_files delete.',
  argsSchema: applyPatchArgsSchema,
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
      const resolvedOperation = { ...operation, path: filePath.path };
      const durability = await resolveDurableToolInvocation(
        ctx,
        applyPatchTool.name,
      );
      const executionContext: ApplyPatchExecutionContext = {
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
        return await recoverApplyPatchOperation({
          args,
          operation: resolvedOperation,
          context: executionContext,
          invocation: durability.invocation,
        });
      }
      const prepared = await prepareApplyPatchOperation(
        resolvedOperation,
        executionContext,
      );
      const manifest = prepareApplyPatchOperationManifest({
        context: executionContext,
        prepared,
      });
      return await executeApplyPatchOperation({
        args,
        context: executionContext,
        manifest,
        prepared,
      });
    } catch (err: unknown) {
      if (err instanceof ApplyPatchParseError) {
        return toolError('invalid_args', err.message);
      }
      return catchToolError(err);
    }
  },
});

async function prepareApplyPatchOperation(
  operation: ApplyPatchOperation,
  context: ApplyPatchExecutionContext,
): Promise<PreparedApplyPatchOperation> {
  switch (operation.kind) {
    case 'add':
      return await prepareAddPatchOperation(operation, context);
    case 'update':
      return await prepareUpdatePatchOperation(operation, context);
  }
}

async function prepareAddPatchOperation(
  operation: Extract<ApplyPatchOperation, { kind: 'add' }>,
  context: ApplyPatchExecutionContext,
): Promise<PreparedAddPatchOperation> {
  const preparedPath = await prepareMutatingFilePath(
    context.absoluteRoot,
    operation.path,
    {
      allowMissingLeaf: true,
    },
  );
  if (preparedPath.exists) {
    throw new ApplyPatchParseError(
      `file already exists: ${preparedPath.resolvedPath.relativePath}`,
    );
  }
  return {
    kind: 'add',
    operation,
    preparedPath,
    content: normalizeTextContent(operation.content),
    linesChanged: countTextLines(operation.content),
  };
}

async function prepareUpdatePatchOperation(
  operation: Extract<ApplyPatchOperation, { kind: 'update' }>,
  context: ApplyPatchExecutionContext,
): Promise<PreparedUpdatePatchOperation> {
  const preparedFile = await preparePatchFile(
    context.absoluteRoot,
    operation.path,
    context.fileStateCache ? { fileStateCache: context.fileStateCache } : {},
  );
  const applyResult = applyPatchHunks(
    preparedFile.fileResult.content,
    operation.hunks,
  );
  return {
    kind: 'update',
    operation,
    preparedFile,
    content: normalizeTextContent(applyResult.updated),
    linesChanged: applyResult.linesChanged,
  };
}

async function executeApplyPatchOperation(args: {
  args: ApplyPatchParsedArgs;
  context: ApplyPatchExecutionContext;
  manifest: OperationManifest;
  prepared: PreparedApplyPatchOperation;
}): Promise<ExecuteResult> {
  const durability = args.context.durability;
  if (durability === undefined) {
    return await commitApplyPatchOperation(args.prepared, args.context);
  }
  const recorded = await recordDurableToolInvocation({
    durability,
    callId: args.context.callId,
    toolName: applyPatchTool.name,
    recoveryStrategy: 'reconcile_then_replay',
    recoveryState: buildApplyPatchRecoveryState({
      manifest: args.manifest,
      patch: args.args.patch,
    }),
  });
  if (!recorded.changed) {
    return await recoverApplyPatchOperation({
      args: args.args,
      operation: args.prepared.operation,
      context: args.context,
      invocation: recorded.invocation,
    });
  }

  let result: ExecuteResult;
  try {
    result = await commitApplyPatchOperation(args.prepared, args.context);
  } catch (error: unknown) {
    const decision = await reconcileApplyPatchOperationState({
      args: args.args,
      operation: args.prepared.operation,
      context: args.context,
      manifest: args.manifest,
    });
    result =
      decision.kind === 'settled' ? decision.result : catchToolError(error);
  }
  await recordApplyPatchInvocationResult({
    context: args.context,
    result,
  });
  return result;
}

async function commitApplyPatchOperation(
  prepared: PreparedApplyPatchOperation,
  context: ApplyPatchExecutionContext,
): Promise<ExecuteResult> {
  switch (prepared.kind) {
    case 'add': {
      const saveResult = await persistPreparedFile(
        prepared.preparedPath,
        prepared.content,
        '',
        undefined,
        context.fileStateCache
          ? { fileStateCache: context.fileStateCache }
          : {},
      );
      return buildApplyPatchSuccess({
        root: context.root,
        operation: 'add',
        path: saveResult.path,
        versionToken: saveResult.versionToken,
        totalLines: saveResult.totalLines,
        linesChanged: prepared.linesChanged,
      });
    }
    case 'update': {
      const { fileResult } = prepared.preparedFile;
      if (prepared.content === fileResult.content) {
        return buildApplyPatchSuccess({
          root: context.root,
          operation: 'update',
          path: fileResult.path,
          versionToken: fileResult.versionToken,
          totalLines: countTextLines(fileResult.content),
          linesChanged: 0,
        });
      }
      const saveResult = await persistPreparedFile(
        prepared.preparedFile,
        prepared.content,
        fileResult.versionToken,
        undefined,
        context.fileStateCache
          ? { fileStateCache: context.fileStateCache }
          : {},
      );
      return buildApplyPatchSuccess({
        root: context.root,
        operation: 'update',
        path: saveResult.path,
        versionToken: saveResult.versionToken,
        totalLines: saveResult.totalLines,
        linesChanged: prepared.linesChanged,
      });
    }
  }
}

async function recoverApplyPatchOperation(args: {
  args: ApplyPatchParsedArgs;
  operation: ApplyPatchOperation;
  context: ApplyPatchExecutionContext;
  invocation: RunCheckpointToolInvocation;
}): Promise<ExecuteResult> {
  const { context, invocation } = args;
  if (
    invocation.callId !== context.callId ||
    invocation.toolName !== applyPatchTool.name ||
    invocation.recoveryStrategy !== 'reconcile_then_replay'
  ) {
    throw new Error('apply_patch recovery invocation identity conflicts');
  }
  const recoveryState = parseApplyPatchRecoveryState(invocation.recoveryState);
  if (
    recoveryState === null ||
    !(await doesApplyPatchManifestMatchInvocation({
      args: args.args,
      operation: args.operation,
      context,
      recoveryState,
    }))
  ) {
    throw new Error('apply_patch recovery manifest is invalid');
  }
  if (invocation.status === 'reconciled') {
    return invocation.result;
  }

  const decision = await reconcileApplyPatchOperationState({
    args: args.args,
    operation: args.operation,
    context,
    manifest: recoveryState.manifest,
  });
  let result: ExecuteResult;
  if (decision.kind === 'settled') {
    result = decision.result;
  } else {
    try {
      const prepared = await prepareApplyPatchOperation(
        args.operation,
        context,
      );
      result = await commitApplyPatchOperation(prepared, context);
    } catch (error: unknown) {
      result = catchToolError(error);
    }
    const afterReplay = await reconcileApplyPatchOperationState({
      args: args.args,
      operation: args.operation,
      context,
      manifest: recoveryState.manifest,
    });
    if (afterReplay.kind === 'settled') {
      result = afterReplay.result;
    }
  }
  await recordApplyPatchInvocationResult({ context, result });
  return result;
}

async function recordApplyPatchInvocationResult(args: {
  context: ApplyPatchExecutionContext;
  result: ExecuteResult;
}): Promise<void> {
  await recordDurableToolInvocationResult({
    durability: args.context.durability,
    callId: args.context.callId,
    toolName: applyPatchTool.name,
    result: args.result,
  });
}

async function reconcileApplyPatchOperationState(args: {
  args: ApplyPatchParsedArgs;
  operation: ApplyPatchOperation;
  context: ApplyPatchExecutionContext;
  manifest: OperationManifest;
}): Promise<ApplyPatchRecoveryDecision> {
  if (
    !(await doesApplyPatchManifestMatchInvocation({
      args: args.args,
      operation: args.operation,
      context: args.context,
      recoveryState: {
        manifest: args.manifest,
        patchDigest: createVersionToken(normalizeTextContent(args.args.patch)),
      },
    }))
  ) {
    return {
      kind: 'settled',
      result: buildApplyPatchRecoveryConflict(
        'target no longer matches its durable manifest',
      ),
    };
  }
  const target = args.manifest.targets[0];
  const payloadDigest = args.manifest.payloadDigest;
  if (target === undefined || payloadDigest?.kind !== 'content') {
    return {
      kind: 'settled',
      result: buildApplyPatchRecoveryConflict('durable manifest is incomplete'),
    };
  }
  const targetPath = target.path ?? args.operation.path;
  const observation = await observeApplyPatchTarget(
    args.context.absoluteRoot,
    args.operation.path,
  );
  if (
    observation.exists &&
    observation.kind === 'file' &&
    observation.versionToken === payloadDigest.digest
  ) {
    return {
      kind: 'settled',
      result: buildApplyPatchSuccess({
        root: args.context.root,
        operation: args.operation.kind,
        path: observation.path,
        versionToken: observation.versionToken,
        totalLines: observation.totalLines,
        linesChanged: countApplyPatchChangedLines(args.operation),
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
          result: buildApplyPatchRecoveryConflict(
            'target kind or canonical path changed',
          ),
        };
    }
  }

  if (args.operation.kind === 'add') {
    return { kind: 'replay' };
  }
  if (
    observation.exists &&
    observation.kind === 'file' &&
    observation.versionToken === target.expectedVersionToken
  ) {
    const applyResult = applyPatchHunks(
      observation.content,
      args.operation.hunks,
    );
    if (
      createVersionToken(normalizeTextContent(applyResult.updated)) !==
      payloadDigest.digest
    ) {
      return {
        kind: 'settled',
        result: buildApplyPatchRecoveryConflict(
          'payload no longer matches the durable patch',
        ),
      };
    }
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
    result: buildApplyPatchRecoveryConflict('target state is ambiguous'),
  };
}

async function doesApplyPatchManifestMatchInvocation(args: {
  args: ApplyPatchParsedArgs;
  operation: ApplyPatchOperation;
  context: ApplyPatchExecutionContext;
  recoveryState: ApplyPatchRecoveryState;
}): Promise<boolean> {
  const { manifest } = args.recoveryState;
  const target = manifest.targets[0];
  const isUpdate = args.operation.kind === 'update';
  const actor = buildApplyPatchActor(args.context);
  if (
    args.recoveryState.patchDigest !==
      createVersionToken(normalizeTextContent(args.args.patch)) ||
    manifest.operationId !== args.context.callId ||
    manifest.operationKind !== (isUpdate ? 'overwrite' : 'create_file') ||
    manifest.authorityId !== args.context.root ||
    manifest.actor.kind !== actor.kind ||
    manifest.actor.runId !== actor.runId ||
    manifest.targets.length !== 1 ||
    target === undefined ||
    target.role !== (isUpdate ? 'single' : 'destination') ||
    target.existence !== (isUpdate ? 'must_exist' : 'must_not_exist') ||
    target.expectedKind !== (isUpdate ? 'file' : undefined) ||
    (isUpdate && target.expectedVersionToken === undefined) ||
    (!isUpdate && target.expectedVersionToken !== undefined) ||
    manifest.payloadDigest?.kind !== 'content' ||
    manifest.atomicity !== 'atomic'
  ) {
    return false;
  }
  if (
    args.operation.kind === 'add' &&
    manifest.payloadDigest.digest !==
      createVersionToken(normalizeTextContent(args.operation.content))
  ) {
    return false;
  }
  const preparedPath = await prepareMutatingFilePath(
    args.context.absoluteRoot,
    args.operation.path,
    { allowMissingLeaf: true },
  );
  return (
    preparedPath.resolvedPath.relativePath === target.path &&
    preparedPath.resolvedPath.canonicalAbsolutePath === target.canonicalTargetId
  );
}

async function observeApplyPatchTarget(
  absoluteRoot: string,
  path: string,
): Promise<ObservedApplyPatchTarget> {
  const preparedPath = await prepareMutatingFilePath(absoluteRoot, path, {
    allowMissingLeaf: true,
  });
  const canonicalTargetId = preparedPath.resolvedPath.canonicalAbsolutePath;
  if (!preparedPath.exists) {
    return { exists: false, canonicalTargetId };
  }
  if (preparedPath.pathKind === 'directory') {
    return { exists: true, canonicalTargetId, kind: 'directory' };
  }
  const file = await readResolvedFile(preparedPath.resolvedPath);
  return {
    exists: true,
    canonicalTargetId,
    content: file.content,
    kind: 'file',
    path: file.path,
    versionToken: file.versionToken,
    totalLines: file.totalLines,
  };
}

function prepareApplyPatchOperationManifest(args: {
  context: ApplyPatchExecutionContext;
  prepared: PreparedApplyPatchOperation;
}): OperationManifest {
  const isUpdate = args.prepared.kind === 'update';
  const preparedPath =
    args.prepared.kind === 'update'
      ? args.prepared.preparedFile
      : args.prepared.preparedPath;
  const expectedVersionToken =
    args.prepared.kind === 'update'
      ? args.prepared.preparedFile.fileResult.versionToken
      : undefined;
  return prepareOperationManifest({
    operationId: args.context.callId,
    manifestRevision: '1',
    operationKind: isUpdate ? 'overwrite' : 'create_file',
    authorityId: args.context.root,
    actor: buildApplyPatchActor(args.context),
    targets: [
      {
        role: isUpdate ? 'single' : 'destination',
        path: preparedPath.resolvedPath.relativePath,
        canonicalTargetId: preparedPath.resolvedPath.canonicalAbsolutePath,
        ...(expectedVersionToken === undefined
          ? {}
          : {
              expectedKind: 'file' as const,
              expectedVersionToken,
            }),
      },
    ],
    approval: { required: true },
    payloadDigest: {
      kind: 'content',
      digest: createVersionToken(args.prepared.content),
    },
    atomicity: 'atomic',
    createdAt: new Date().toISOString(),
  });
}

function buildApplyPatchActor(
  context: ApplyPatchExecutionContext,
): OperationActor {
  return context.runId === undefined
    ? { kind: 'daemon' }
    : { kind: 'assistant', runId: context.runId };
}

function buildApplyPatchRecoveryState(args: {
  manifest: OperationManifest;
  patch: string;
}): JsonValue {
  return {
    manifest: operationManifestToJsonValue(args.manifest),
    patchDigest: createVersionToken(normalizeTextContent(args.patch)),
  };
}

function parseApplyPatchRecoveryState(
  value: unknown,
): ApplyPatchRecoveryState | null {
  if (
    !isRecord(value) ||
    typeof value.patchDigest !== 'string' ||
    value.patchDigest.length === 0
  ) {
    return null;
  }
  const manifest = parseOperationManifest(value.manifest);
  return manifest === null
    ? null
    : { manifest, patchDigest: value.patchDigest };
}

function countApplyPatchChangedLines(operation: ApplyPatchOperation): number {
  if (operation.kind === 'add') {
    return countTextLines(operation.content);
  }
  return operation.hunks.reduce(
    (total, hunk) =>
      total +
      Math.abs(countTextLines(hunk.newText) - countTextLines(hunk.oldText)),
    0,
  );
}

function buildApplyPatchSuccess(args: {
  root: 'computer';
  operation: 'add' | 'update';
  path: string;
  versionToken: string;
  totalLines: number;
  linesChanged: number;
}): ExecuteResult {
  return applyPatchSuccess({
    ok: true,
    root: args.root,
    operation: args.operation,
    path: args.path,
    versionToken: args.versionToken,
    totalLines: args.totalLines,
    linesChanged: args.linesChanged,
  });
}

function buildApplyPatchRecoveryConflict(detail: string): ExecuteResult {
  return toolError('conflict', `apply_patch recovery ${detail}`);
}

export function parseSingleApplyPatchTargetPath(patch: string): string {
  return parseSingleApplyPatchOperation(patch).path;
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
