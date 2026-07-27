import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type {
  CommandHostOperation,
  HostCommandRuntime,
} from '../../../command-host/contract.js';

import {
  ensureHostCommandFullOutputArchive,
  type HostCommandFullOutputArchiveHandle,
} from '../../host-command-full-output-archive.js';
import { createVersionToken } from '../../files/version-token.js';
import type { RunCheckpointToolInvocation } from '../../runtime-contracts.js';
import { isRecord, type JsonValue } from '../../runtime-json.js';
import {
  recordDurableToolInvocation,
  recordDurableToolInvocationResult,
  resolveDurableToolInvocation,
  type DurableToolInvocationContext,
} from '../tool-invocation-durability.js';
import { toolError } from '../result.js';
import type { ExecuteResult, ToolExecutionContext } from '../types.js';
import { defineZodTool } from '../zod-tool.js';

const WRITE_STDIN_MAX_TIMER_MS = 2_147_483_647;

const writeStdinArgsSchema = z.strictObject({
  outputRef: z
    .string()
    .min(1, 'outputRef is required.')
    .describe(
      'Opaque command-output reference returned by exec_command. It is thread-bound and also identifies the writable process session while that process is running.',
    ),
  chars: z
    .string()
    .min(1, 'chars must not be empty.')
    .optional()
    .describe(
      'Characters to write to an exec_command session whose approved stdinMode was "open". Omit to poll without writing.',
    ),
  closeStdin: z
    .boolean()
    .optional()
    .describe('Close the process stdin pipe after any chars are written.'),
  terminate: z
    .boolean()
    .optional()
    .describe(
      'Terminate the still-running process tree. This does not discard its durable output.',
    ),
  afterRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Previously observed output revision. When current state already differs, return immediately.',
    ),
  yieldTimeMs: z
    .number()
    .int()
    .min(0)
    .max(WRITE_STDIN_MAX_TIMER_MS)
    .optional()
    .describe(
      'Optional caller-owned observation window. Omit it to wait for a change up to the runtime ceiling rather than forever; zero performs a non-blocking poll. Waits never outlive the ceiling, so a quiet long-running process still returns a snapshot.',
    ),
  stream: z
    .enum(['stdout', 'stderr'])
    .optional()
    .describe('Optional durable output stream to page in this same call.'),
  offsetBytes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'UTF-8 byte offset for the requested stream page. Use nextOffsetBytes from the previous page.',
    ),
  limitBytes: z
    .number()
    .int()
    .min(4)
    .optional()
    .describe(
      'Required with stream. The runtime rejects pages above the configured inline tool-result budget; the full output remains at outputRef.',
    ),
});

type WriteStdinParsedArgs = z.output<typeof writeStdinArgsSchema>;

interface WriteStdinRecoveryState {
  schemaVersion: 1;
  digestSalt: string;
  argsDigest: string;
  operationClientId: string;
  operationSeq: 1;
}

export const writeStdinTool = defineZodTool({
  name: 'write_stdin',
  description:
    'Continue or observe a host command previously yielded by exec_command. Empty writes can poll, a bounded stdout/stderr page can be returned from any durable byte offset, terminate stops the process tree without deleting output, and chars are accepted only when the approved exec_command opened stdin. The opaque outputRef is a thread-bound continuation capability; this tool never starts a new command and does not allocate a PTY.',
  argsSchema: writeStdinArgsSchema,
  sideEffectLevel: 'destructive',
  mayMutateComputerFiles: true,
  abortSettlement: 'await_execution',
  requiresApproval: false,
  recoveryStrategy: 'reconcile_then_replay',
  resultProjection: {
    exactDurableRecovery: true,
    modelProjection: 'runtime_summary',
    snapshotFailure: 'inline',
  },
  catalogSearchMetadata: {
    family: 'command',
    searchHints: [
      'poll command',
      'background command',
      'write stdin',
      'command output',
      'stop command',
    ],
    tags: ['command', 'process', 'stdin', 'output', 'continuation'],
    whenToUse:
      'Poll, page, terminate, or write to the exact host command session returned by exec_command.',
    notFor:
      'Starting a new command, PTC cells, subagent waiting, or writing to a session that was not opened with stdinMode "open".',
  },
  async executeParsed(args, ctx) {
    if (!ctx.threadId || !ctx.stateRoot) {
      return toolError(
        'execution_failed',
        'write_stdin requires an agent thread context.',
      );
    }
    if (args.closeStdin === true && args.terminate === true) {
      return toolError(
        'invalid_args',
        'closeStdin and terminate cannot both be true.',
      );
    }
    if (
      (args.stream === undefined) !== (args.limitBytes === undefined) ||
      (args.stream === undefined && args.offsetBytes !== undefined)
    ) {
      return toolError(
        'invalid_args',
        'stream and limitBytes must be provided together; offsetBytes is valid only with stream.',
      );
    }
    const runtimeServices = ctx.runtimeServices;
    if (runtimeServices === undefined) {
      return toolError(
        'execution_failed',
        'write_stdin requires the daemon host command runtime.',
      );
    }
    const durability = await resolveDurableToolInvocation(
      ctx,
      writeStdinTool.name,
    );
    if (durability?.invocation !== undefined) {
      return await recoverWriteStdinInvocation({
        args,
        context: ctx,
        durability,
        hostCommands: runtimeServices.hostCommands,
        invocation: durability.invocation,
        pageLimitBytes: runtimeServices.hostCommandInlineMaxBytes,
        stateRoot: ctx.stateRoot,
        threadId: ctx.threadId,
      });
    }

    let operation: CommandHostOperation | undefined;
    if (durability !== undefined) {
      const recoveryState = buildWriteStdinRecoveryState(args);
      const recorded = await recordDurableToolInvocation({
        durability,
        callId: ctx.callId,
        toolName: writeStdinTool.name,
        recoveryStrategy: 'reconcile_then_replay',
        recoveryState,
      });
      if (!recorded.changed) {
        return await recoverWriteStdinInvocation({
          args,
          context: ctx,
          durability,
          hostCommands: runtimeServices.hostCommands,
          invocation: recorded.invocation,
          pageLimitBytes: runtimeServices.hostCommandInlineMaxBytes,
          stateRoot: ctx.stateRoot,
          threadId: ctx.threadId,
        });
      }
      operation = commandHostOperationFromRecoveryState(recoveryState);
    }

    const result = await executeWriteStdinInteraction({
      args,
      context: ctx,
      hostCommands: runtimeServices.hostCommands,
      operation,
      pageLimitBytes: runtimeServices.hostCommandInlineMaxBytes,
      stateRoot: ctx.stateRoot,
      threadId: ctx.threadId,
    });
    await recordDurableToolInvocationResult({
      durability,
      callId: ctx.callId,
      toolName: writeStdinTool.name,
      result,
    });
    return result;
  },
});

async function recoverWriteStdinInvocation(args: {
  args: WriteStdinParsedArgs;
  context: Pick<ToolExecutionContext, 'callId' | 'signal'>;
  durability: DurableToolInvocationContext;
  hostCommands: HostCommandRuntime;
  invocation: RunCheckpointToolInvocation;
  pageLimitBytes: number;
  stateRoot: string;
  threadId: string;
}): Promise<ExecuteResult> {
  if (
    args.invocation.callId !== args.context.callId ||
    args.invocation.toolName !== writeStdinTool.name ||
    args.invocation.recoveryStrategy !== 'reconcile_then_replay'
  ) {
    throw new Error('write_stdin recovery invocation identity conflicts');
  }
  const recoveryState = parseWriteStdinRecoveryState(
    args.invocation.recoveryState,
  );
  if (
    recoveryState === null ||
    recoveryState.argsDigest !==
      buildWriteStdinArgsDigest(args.args, recoveryState.digestSalt)
  ) {
    throw new Error('write_stdin recovery arguments conflict');
  }
  if (args.invocation.status === 'reconciled') {
    return args.invocation.result;
  }

  const result = await executeWriteStdinInteraction({
    args: args.args,
    context: args.context,
    hostCommands: args.hostCommands,
    operation: commandHostOperationFromRecoveryState(recoveryState),
    pageLimitBytes: args.pageLimitBytes,
    stateRoot: args.stateRoot,
    threadId: args.threadId,
  });
  await recordDurableToolInvocationResult({
    durability: args.durability,
    callId: args.context.callId,
    toolName: writeStdinTool.name,
    result,
  });
  return result;
}

async function executeWriteStdinInteraction(args: {
  args: WriteStdinParsedArgs;
  context: Pick<ToolExecutionContext, 'signal'>;
  hostCommands: HostCommandRuntime;
  operation: CommandHostOperation | undefined;
  pageLimitBytes: number;
  stateRoot: string;
  threadId: string;
}): Promise<ExecuteResult> {
  let archive: HostCommandFullOutputArchiveHandle | null;
  try {
    archive = await ensureHostCommandFullOutputArchive({
      hostCommands: args.hostCommands,
      stateRoot: args.stateRoot,
      threadId: args.threadId,
      outputRef: args.args.outputRef,
      pageLimitBytes: args.pageLimitBytes,
      createIfMissing: false,
      activateRelease: true,
    });
  } catch (error: unknown) {
    return fullOutputArchiveToolError(getErrorMessage(error));
  }
  if (archive?.status === 'failed') {
    return fullOutputArchiveToolError(
      archive.failureMessage ?? 'full-output archive failed.',
    );
  }

  const result = await args.hostCommands.interact({
    stateRoot: args.stateRoot,
    threadId: args.threadId,
    outputRef: args.args.outputRef,
    ...(args.args.chars === undefined ? {} : { chars: args.args.chars }),
    ...(args.args.closeStdin === undefined
      ? {}
      : { closeStdin: args.args.closeStdin }),
    ...(args.args.terminate === undefined
      ? {}
      : { terminate: args.args.terminate }),
    ...(args.operation === undefined ? {} : { operation: args.operation }),
    ...(args.args.afterRevision === undefined
      ? {}
      : { afterRevision: args.args.afterRevision }),
    ...(args.args.yieldTimeMs === undefined
      ? {}
      : { yieldTimeMs: args.args.yieldTimeMs }),
    ...(args.args.stream === undefined || args.args.limitBytes === undefined
      ? {}
      : {
          page: {
            stream: args.args.stream,
            offsetBytes: args.args.offsetBytes ?? 0,
            limitBytes: args.args.limitBytes,
            ...(archive?.status === 'active' ? { deferRelease: true } : {}),
          },
        }),
    ...(args.context.signal === undefined
      ? {}
      : { signal: args.context.signal }),
  });
  if (!result.ok) {
    return toolError(
      result.reasonCode === 'not_found'
        ? 'not_found'
        : result.reasonCode === 'access_denied'
          ? 'access_denied'
          : result.reasonCode === 'invalid_args' ||
              result.reasonCode === 'operation_superseded'
            ? 'invalid_args'
            : 'execution_failed',
      result.message,
    );
  }
  if (
    archive !== null &&
    archive.status === 'active' &&
    result.value.snapshot.status !== 'running'
  ) {
    const archived = await archive.completed;
    if (!archived.ok) {
      return fullOutputArchiveToolError(archived.message);
    }
  }
  return { ok: true, output: JSON.stringify(result.value) };
}

function buildWriteStdinRecoveryState(args: WriteStdinParsedArgs): JsonValue {
  const digestSalt = randomBytes(32).toString('hex');
  return {
    schemaVersion: 1,
    digestSalt,
    argsDigest: buildWriteStdinArgsDigest(args, digestSalt),
    operationClientId: randomBytes(32).toString('hex'),
    operationSeq: 1,
  };
}

function parseWriteStdinRecoveryState(
  value: unknown,
): WriteStdinRecoveryState | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.digestSalt !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.digestSalt) ||
    typeof value.argsDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.argsDigest) ||
    typeof value.operationClientId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.operationClientId) ||
    value.operationSeq !== 1
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    digestSalt: value.digestSalt,
    argsDigest: value.argsDigest,
    operationClientId: value.operationClientId,
    operationSeq: 1,
  };
}

function buildWriteStdinArgsDigest(
  args: WriteStdinParsedArgs,
  digestSalt: string,
): string {
  const canonicalIdentity = JSON.stringify({
    schemaVersion: 1,
    outputRef: args.outputRef,
    chars: args.chars ?? null,
    closeStdin: args.closeStdin ?? null,
    terminate: args.terminate ?? null,
    afterRevision: args.afterRevision ?? null,
    yieldTimeMs: args.yieldTimeMs ?? null,
    stream: args.stream ?? null,
    offsetBytes: args.offsetBytes ?? null,
    limitBytes: args.limitBytes ?? null,
  });
  return createVersionToken(`${digestSalt}\u0000${canonicalIdentity}`);
}

function commandHostOperationFromRecoveryState(
  value: JsonValue | WriteStdinRecoveryState,
): CommandHostOperation {
  const recoveryState = parseWriteStdinRecoveryState(value);
  if (recoveryState === null) {
    throw new Error('write_stdin recovery state is invalid');
  }
  return {
    clientId: recoveryState.operationClientId,
    seq: recoveryState.operationSeq,
  };
}

function fullOutputArchiveToolError(message: string): ExecuteResult {
  return toolError(
    'execution_failed',
    `write_stdin could not preserve the command’s complete output: ${message}`,
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'host command full-output archive failed';
}
