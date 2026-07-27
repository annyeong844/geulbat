import { randomBytes } from 'node:crypto';
import { platform } from 'node:os';
import { z } from 'zod';
import type { HostCommandRuntime } from '../../../command-host/contract.js';
import {
  ensureHostCommandFullOutputArchive,
  type HostCommandFullOutputArchiveHandle,
} from '../../host-command-full-output-archive.js';
import { resolveSourceDirectoryTarget } from '../../files/file-platform.js';
import { createVersionToken } from '../../files/version-token.js';
import type { HostCommandSnapshot } from '../../host-command-output-store.js';
import type { RunCheckpointToolInvocation } from '../../runtime-contracts.js';
import { isRecord, type JsonValue } from '../../runtime-json.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
import {
  recordDurableToolInvocation,
  recordDurableToolInvocationResult,
  resolveDurableToolInvocation,
  type DurableToolInvocationContext,
} from '../tool-invocation-durability.js';
import { toolError } from '../result.js';
import type { ExecuteResult, ToolExecutionContext } from '../types.js';
import { defineZodTool } from '../zod-tool.js';
import {
  preparePersistentShellInvocation,
  type ExecCommandShellMode,
} from '../../exec-command-shell-state.js';

const EXEC_COMMAND_MAX_TIMER_MS = 2_147_483_647;

const execCommandArgsSchema = z.strictObject({
  cmd: z
    .string()
    .min(1, 'cmd is required.')
    .refine((value) => value.trim().length > 0, {
      message: 'cmd must not be empty.',
    })
    .describe('The shell command string to execute.'),
  cwd: z
    .string()
    .refine((value) => value.trim().length > 0, {
      message: 'cwd must not be empty.',
    })
    .optional()
    .describe(
      'Working directory. Relative paths resolve from the selected run cwd; an admitted absolute path may select any Computer location independently of that cwd.',
    ),
  shellMode: z
    .enum(['isolated', 'persistent'])
    .optional()
    .describe(
      'Shell state lifetime. The default "isolated" starts from the requested cwd and daemon environment. "persistent" serializes commands per thread and carries cwd, exported environment changes, aliases, and shell functions into the next persistent command. Use isolated mode for independent or parallel commands.',
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(EXEC_COMMAND_MAX_TIMER_MS)
    .optional()
    .describe(
      'Optional command timeout in milliseconds. Omit it to rely on run cancellation instead of a command-local deadline.',
    ),
  yieldTimeMs: z
    .number()
    .int()
    .min(0)
    .max(EXEC_COMMAND_MAX_TIMER_MS)
    .optional()
    .describe(
      'Optional caller-owned foreground observation window. If the command is still running when it expires, return a durable outputRef instead of blocking the model turn. Zero yields immediately. Omitting it waits up to the runtime ceiling, not forever: a command that outlives the ceiling comes back as a running outputRef you can keep observing with write_stdin. A running result that carries processExit means the command itself already finished with that exit code and only a background descendant still holds its output stream, so there is nothing left to wait for.',
    ),
  stdinMode: z
    .enum(['closed', 'open'])
    .optional()
    .describe(
      'stdin pipe lifetime. The default is "closed". Use "open" only with yieldTimeMs to create an addressable pipe-backed session for write_stdin; this does not allocate a PTY.',
    ),
  maxOutputBytesPerStream: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Optional caller-owned buffered byte stop for stdout and stderr separately. Omit it to let the command finish without a tool-imposed output stop; completed output is preserved through the durable tool-output path.',
    ),
});

type ExecCommandParsedArgs = z.output<typeof execCommandArgsSchema>;
type ExecCommandStatus = HostCommandSnapshot['status'];

interface ExecCommandRecoveryState {
  schemaVersion: 1;
  digestSalt: string;
  invocationDigest: string;
}

interface ExecCommandOutput {
  command: string;
  cwd: string;
  shellMode: ExecCommandShellMode;
  status: ExecCommandStatus;
  exitCode: number | null;
  /**
   * 프로세스는 끝났는데 백그라운드 자손이 stdout을 물고 있어 출력 스트림이
   * 아직 닫히지 않은 경우에만 실린다. 이게 없으면 이미 끝난 명령을 계속
   * 관찰하게 된다.
   */
  processExit?: {
    status: Exclude<ExecCommandStatus, 'running'>;
    exitCode: number | null;
  };
  stdout: string | null;
  stderr: string | null;
  outputRef: string | null;
  outputComplete: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutChars: number | null;
  stderrChars: number | null;
  revision: number | null;
  stdinOpen: boolean;
  durationMs: number;
  firstOutputAfterMs: number | null;
  timeoutMs: number | null;
  maxOutputBytesPerStream: number | null;
  outputLimitExceeded: {
    stream: 'stdout' | 'stderr';
    maxBufferedBytesPerStream: number;
  } | null;
}

interface ShellCommandInvocation {
  executable: string;
  args: string[];
}

export const execCommandTool = defineZodTool({
  name: 'exec_command',
  description:
    'Run a real approved shell command from the daemon host with the daemon process environment. It is best for host process or CLI behavior, or when one cohesive shell pipeline is more effective than dependent tool rounds; bounded structured file work is usually better served by dedicated tools, whose same-round independent reads can run concurrently. Commands are isolated by default; explicit persistent shell mode serializes commands within one thread and carries cwd, exported environment changes, aliases, and shell functions forward. Its optional cwd is a start location, not a file-authority boundary; admitted absolute cwd paths may select another Computer directory. When a command yields a continuation ref, its redacted stdout and stderr are durably recoverable from offset zero. This is not PTC exec, not a file-tool alias, and not a read-only shortcut.',
  argsSchema: execCommandArgsSchema,
  sideEffectLevel: 'destructive',
  mayMutateComputerFiles: true,
  requiresApproval: true,
  recoveryStrategy: 'reconcile_then_replay',
  resultProjection: {
    exactDurableRecovery: true,
    modelProjection: 'runtime_summary',
    snapshotFailure: 'inline',
  },
  catalogSearchMetadata: {
    family: 'command',
    searchHints: [
      'run command',
      'shell command',
      'terminal command',
      'execute process',
      'bash command',
      'cmd command',
    ],
    tags: ['command', 'shell', 'process', 'approval'],
    whenToUse:
      'Run a host process/CLI operation or one cohesive shell pipeline when that is more effective than splitting dependent work across tool rounds.',
    notFor:
      'Routine file listing, reading, searching, or editing when a dedicated Geulbat tool is available; PTC cells; browser automation; URL fetching; or catalog discovery.',
  },
  async executeParsed(args, ctx) {
    if (args.stdinMode === 'open' && args.yieldTimeMs === undefined) {
      return toolError(
        'invalid_args',
        'stdinMode "open" requires yieldTimeMs so the writable session can be returned.',
      );
    }
    const cwd = await resolveExecCommandCwd(ctx, args.cwd);
    const runtimeServices = ctx.runtimeServices;
    if (runtimeServices === undefined) {
      return toolError(
        'execution_failed',
        'exec_command requires the daemon host command runtime.',
        {
          phase: 'command_start',
          reasonCode: 'host_command_runtime_unavailable',
          retryHint:
            'Retry with the daemon host command runtime enabled and available.',
        },
      );
    }
    const hostCommands = runtimeServices.hostCommands;
    if (
      ctx.threadId === undefined ||
      ctx.runId === undefined ||
      ctx.stateRoot === undefined
    ) {
      return toolError(
        'execution_failed',
        'exec_command host runtime requires an agent thread context.',
        {
          phase: 'command_start',
          reasonCode: 'agent_thread_context_missing',
          retryHint:
            'Retry exec_command from an active agent run with thread state available.',
        },
      );
    }
    const durability = await resolveDurableToolInvocation(
      ctx,
      execCommandTool.name,
    );
    if (durability?.invocation !== undefined) {
      return await recoverExecCommandInvocation({
        args,
        context: ctx,
        cwd,
        durability,
        hostCommands,
        invocation: durability.invocation,
        pageLimitBytes: runtimeServices.hostCommandInlineMaxBytes,
        runId: ctx.runId,
        stateRoot: ctx.stateRoot,
        threadId: ctx.threadId,
      });
    }
    if (durability !== undefined) {
      const recorded = await recordDurableToolInvocation({
        durability,
        callId: ctx.callId,
        toolName: execCommandTool.name,
        recoveryStrategy: 'reconcile_then_replay',
        recoveryState: buildExecCommandRecoveryState(args, cwd),
      });
      if (!recorded.changed) {
        return await recoverExecCommandInvocation({
          args,
          context: ctx,
          cwd,
          durability,
          hostCommands,
          invocation: recorded.invocation,
          pageLimitBytes: runtimeServices.hostCommandInlineMaxBytes,
          runId: ctx.runId,
          stateRoot: ctx.stateRoot,
          threadId: ctx.threadId,
        });
      }
    }

    const result = await startAndWaitForExecCommand({
      args,
      context: ctx,
      cwd,
      hostCommands,
      pageLimitBytes: runtimeServices.hostCommandInlineMaxBytes,
      runId: ctx.runId,
      stateRoot: ctx.stateRoot,
      threadId: ctx.threadId,
    });
    await recordDurableToolInvocationResult({
      durability,
      callId: ctx.callId,
      toolName: execCommandTool.name,
      result,
    });
    return result;
  },
});

async function startAndWaitForExecCommand(args: {
  args: ExecCommandParsedArgs;
  context: Pick<ToolExecutionContext, 'callId' | 'emitAgentEvent' | 'signal'>;
  cwd: string;
  hostCommands: HostCommandRuntime;
  pageLimitBytes: number;
  runId: string;
  stateRoot: string;
  threadId: string;
}): Promise<ExecuteResult> {
  const shell =
    args.args.shellMode === 'persistent'
      ? await preparePersistentShellInvocation({
          command: args.args.cmd,
          environment: process.env,
          explicitCwd: args.args.cwd === undefined ? undefined : args.cwd,
          shellExecutable: process.env['SHELL']?.trim() || '/bin/sh',
          stateRoot: args.stateRoot,
          threadId: args.threadId,
        })
      : { ok: true as const, ...buildShellCommandInvocation(args.args.cmd) };
  if (!shell.ok) {
    return toolError('invalid_args', shell.message, {
      phase: 'command_start',
      reasonCode: shell.reasonCode,
    });
  }
  const started = await args.hostCommands.start({
    executable: shell.executable,
    args: shell.args,
    cwd: args.cwd,
    env: process.env,
    stateRoot: args.stateRoot,
    threadId: args.threadId,
    runId: args.runId,
    callId: args.context.callId,
    stdinMode: args.args.stdinMode ?? 'closed',
    streamMode: 'lossless',
    requiresDeferredOutputRelease: true,
    ...(args.args.timeoutMs === undefined
      ? {}
      : { timeoutMs: args.args.timeoutMs }),
    ...(args.args.maxOutputBytesPerStream === undefined
      ? {}
      : {
          maxOutputBytesPerStream: args.args.maxOutputBytesPerStream,
        }),
    ...(args.context.signal === undefined
      ? {}
      : { signal: args.context.signal }),
    onOutput: ({ stream, text }) => {
      emitExecCommandOutput(args.context, stream, text);
    },
  });
  if (!started.ok) {
    return toolError(
      started.reasonCode === 'runtime_closed' ||
        started.reasonCode === 'session_capacity_exhausted'
        ? 'execution_failed'
        : 'internal',
      started.message,
      {
        phase: 'command_start',
        reasonCode: started.reasonCode,
        ...(started.reasonCode === 'runtime_closed'
          ? {
              retryHint:
                'Restart the daemon host command runtime, then retry the command.',
            }
          : started.reasonCode === 'session_capacity_exhausted'
            ? {
                retryHint:
                  'Wait for an existing command session to finish or stop it, then retry.',
              }
            : {}),
      },
    );
  }
  let archive: HostCommandFullOutputArchiveHandle;
  try {
    const prepared = await ensureHostCommandFullOutputArchive({
      hostCommands: args.hostCommands,
      stateRoot: args.stateRoot,
      threadId: args.threadId,
      outputRef: started.outputRef,
      pageLimitBytes: args.pageLimitBytes,
      createIfMissing: true,
    });
    if (prepared === null) {
      throw new Error('full-output archive owner was not created');
    }
    archive = prepared;
  } catch (error: unknown) {
    await args.hostCommands.interact({
      stateRoot: args.stateRoot,
      threadId: args.threadId,
      outputRef: started.outputRef,
      terminate: true,
      yieldTimeMs: 0,
    });
    return fullOutputArchiveToolError(getErrorMessage(error));
  }
  const waited = await args.hostCommands.waitForInitialResult({
    outputRef: started.outputRef,
    stateRoot: args.stateRoot,
    ...(args.args.yieldTimeMs === undefined
      ? {}
      : { yieldTimeMs: args.args.yieldTimeMs }),
    ...(args.context.signal === undefined
      ? {}
      : { signal: args.context.signal }),
  });
  if (!waited.ok) {
    await archive.cancelAndRemove();
    return toolError(
      waited.reasonCode === 'not_found' ? 'not_found' : 'execution_failed',
      waited.message,
      {
        phase: 'command_wait',
        reasonCode: waited.reasonCode,
        ...(waited.reasonCode === 'not_found'
          ? {
              retryHint:
                'The command session no longer exists; start the command again.',
            }
          : {}),
      },
    );
  }
  if (waited.value.outputRef === null) {
    await archive.cancelAndRemove();
  } else {
    archive.activateRelease();
    if (waited.value.status !== 'running') {
      const archived = await archive.completed;
      if (!archived.ok) {
        return fullOutputArchiveToolError(archived.message);
      }
    } else if (archive.status === 'failed') {
      return fullOutputArchiveToolError(
        archive.failureMessage ?? 'full-output archive failed.',
      );
    }
  }
  return buildExecCommandSuccess({
    args: args.args,
    cwd: args.cwd,
    snapshot: waited.value,
  });
}

async function recoverExecCommandInvocation(args: {
  args: ExecCommandParsedArgs;
  context: Pick<ToolExecutionContext, 'callId' | 'signal'>;
  cwd: string;
  durability: DurableToolInvocationContext;
  hostCommands: HostCommandRuntime;
  invocation: RunCheckpointToolInvocation;
  pageLimitBytes: number;
  runId: string;
  stateRoot: string;
  threadId: string;
}): Promise<ExecuteResult> {
  if (
    args.invocation.callId !== args.context.callId ||
    args.invocation.toolName !== execCommandTool.name ||
    args.invocation.recoveryStrategy !== 'reconcile_then_replay'
  ) {
    throw new Error('exec_command recovery invocation identity conflicts');
  }
  const recoveryState = parseExecCommandRecoveryState(
    args.invocation.recoveryState,
  );
  if (
    recoveryState === null ||
    recoveryState.invocationDigest !==
      buildExecCommandInvocationDigest(
        args.args,
        args.cwd,
        recoveryState.digestSalt,
      )
  ) {
    throw new Error('exec_command recovery arguments conflict');
  }
  if (args.invocation.status === 'reconciled') {
    return args.invocation.result;
  }

  const sessions = await args.hostCommands.listThreadSessions({
    stateRoot: args.stateRoot,
    threadId: args.threadId,
  });
  const matching = sessions.filter(
    (session) =>
      session.runId === args.runId && session.callId === args.context.callId,
  );
  let result: ExecuteResult;
  if (matching.length === 0) {
    result = toolError(
      'execution_failed',
      'exec_command recovery found no surviving command session; the command outcome is unknown and the command was not replayed.',
      {
        phase: 'command_wait',
        reasonCode: 'command_session_not_found',
        retryHint:
          'Inspect the command’s external effects before deciding whether to issue a new command.',
      },
    );
  } else if (matching.length > 1) {
    result = toolError(
      'conflict',
      'exec_command recovery found multiple surviving command sessions for one invocation; none was selected and the command was not replayed.',
      {
        phase: 'command_wait',
        reasonCode: 'command_session_identity_conflict',
      },
    );
  } else {
    const session = matching[0];
    if (session === undefined) {
      throw new Error('exec_command recovery session selection disappeared');
    }
    const archive = await ensureHostCommandFullOutputArchive({
      hostCommands: args.hostCommands,
      stateRoot: args.stateRoot,
      threadId: args.threadId,
      outputRef: session.outputRef,
      pageLimitBytes: args.pageLimitBytes,
      createIfMissing: false,
      activateRelease: true,
    });
    const waited = await args.hostCommands.waitForInitialResult({
      outputRef: session.outputRef,
      stateRoot: args.stateRoot,
      ...(args.args.yieldTimeMs === undefined
        ? {}
        : { yieldTimeMs: args.args.yieldTimeMs }),
      ...(args.context.signal === undefined
        ? {}
        : { signal: args.context.signal }),
    });
    if (waited.ok && waited.value.status !== 'running' && archive !== null) {
      const archived = await archive.completed;
      result = archived.ok
        ? buildExecCommandSuccess({
            args: args.args,
            cwd: args.cwd,
            snapshot: waited.value,
          })
        : fullOutputArchiveToolError(archived.message);
    } else {
      result = waited.ok
        ? buildExecCommandSuccess({
            args: args.args,
            cwd: args.cwd,
            snapshot: waited.value,
          })
        : toolError(
            'execution_failed',
            `exec_command recovery could not reattach to the surviving command session: ${waited.message} The command was not replayed.`,
            {
              phase: 'command_wait',
              reasonCode: waited.reasonCode,
            },
          );
    }
  }
  await recordDurableToolInvocationResult({
    durability: args.durability,
    callId: args.context.callId,
    toolName: execCommandTool.name,
    result,
  });
  return result;
}

function buildExecCommandRecoveryState(
  args: ExecCommandParsedArgs,
  cwd: string,
): JsonValue {
  // 무작위 salt는 짧거나 흔한 명령의 결정적 해시가 디스크에서 사전 대조
  // 표면이 되는 것을 막는다. 명령·argv·env 자체는 체크포인트에 쓰지 않는다.
  const digestSalt = randomBytes(32).toString('hex');
  return {
    schemaVersion: 1,
    digestSalt,
    invocationDigest: buildExecCommandInvocationDigest(args, cwd, digestSalt),
  };
}

function parseExecCommandRecoveryState(
  value: unknown,
): ExecCommandRecoveryState | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.digestSalt !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.digestSalt) ||
    typeof value.invocationDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.invocationDigest)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    digestSalt: value.digestSalt,
    invocationDigest: value.invocationDigest,
  };
}

function buildExecCommandInvocationDigest(
  args: ExecCommandParsedArgs,
  cwd: string,
  digestSalt: string,
): string {
  const canonicalIdentity = JSON.stringify({
    schemaVersion: 1,
    command: args.cmd,
    cwd,
    stdinMode: args.stdinMode ?? 'closed',
    timeoutMs: args.timeoutMs ?? null,
    yieldTimeMs: args.yieldTimeMs ?? null,
    maxOutputBytesPerStream: args.maxOutputBytesPerStream ?? null,
    shellMode: args.shellMode ?? 'isolated',
  });
  return createVersionToken(`${digestSalt}\u0000${canonicalIdentity}`);
}

function buildExecCommandSuccess(args: {
  args: ExecCommandParsedArgs;
  cwd: string;
  snapshot: HostCommandSnapshot;
}): ExecuteResult {
  return {
    ok: true,
    output: JSON.stringify(
      buildHostRuntimeExecCommandOutput({
        command: args.args.cmd,
        cwd: args.cwd,
        maxOutputBytesPerStream: args.args.maxOutputBytesPerStream,
        shellMode: args.args.shellMode,
        snapshot: args.snapshot,
        timeoutMs: args.args.timeoutMs,
      }),
    ),
  };
}

function fullOutputArchiveToolError(message: string): ExecuteResult {
  return toolError(
    'execution_failed',
    `exec_command could not preserve its complete output: ${message}`,
    {
      phase: 'command_wait',
      reasonCode: 'full_output_archive_failed',
      retryHint:
        'Inspect the retained outputRef and command effects before deciding whether to run the command again.',
    },
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'host command full-output archive failed';
}

async function resolveExecCommandCwd(
  ctx: { computerFileRoot?: string; workingDirectory?: string },
  cwd: string | undefined,
): Promise<string> {
  const filePath = resolveComputerFileToolPath(ctx, cwd?.trim() || '.');
  const target = await resolveSourceDirectoryTarget(
    filePath.absoluteRoot,
    filePath.path,
  );
  if (!target.exists) {
    throw new Error(`exec_command cwd not found: ${filePath.path}`);
  }
  return target.canonicalAbsolutePath;
}

function buildShellCommandInvocation(command: string): ShellCommandInvocation {
  if (platform() === 'win32') {
    return {
      executable: process.env['ComSpec'] ?? 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }
  return {
    executable: process.env['SHELL']?.trim() || '/bin/sh',
    args: ['-c', command],
  };
}

function buildHostRuntimeExecCommandOutput(args: {
  command: string;
  cwd: string;
  maxOutputBytesPerStream: number | undefined;
  shellMode: ExecCommandShellMode | undefined;
  snapshot: HostCommandSnapshot;
  timeoutMs: number | undefined;
}): ExecCommandOutput {
  return {
    command: args.command,
    cwd: args.cwd,
    shellMode: args.shellMode ?? 'isolated',
    status: args.snapshot.status,
    exitCode: args.snapshot.exitCode,
    ...(args.snapshot.processExit === undefined
      ? {}
      : { processExit: args.snapshot.processExit }),
    stdout: args.snapshot.stdout,
    stderr: args.snapshot.stderr,
    outputRef: args.snapshot.outputRef,
    outputComplete: args.snapshot.outputComplete,
    stdoutBytes: args.snapshot.stdoutBytes,
    stderrBytes: args.snapshot.stderrBytes,
    stdoutChars: args.snapshot.stdoutChars,
    stderrChars: args.snapshot.stderrChars,
    revision: args.snapshot.revision,
    stdinOpen: args.snapshot.stdinOpen,
    durationMs: args.snapshot.durationMs,
    firstOutputAfterMs: args.snapshot.firstOutputAfterMs,
    timeoutMs: args.timeoutMs ?? null,
    maxOutputBytesPerStream: args.maxOutputBytesPerStream ?? null,
    outputLimitExceeded:
      args.snapshot.outputLimitExceeded === null
        ? null
        : {
            stream: args.snapshot.outputLimitExceeded.stream,
            maxBufferedBytesPerStream:
              args.snapshot.outputLimitExceeded.maxOutputBytesPerStream,
          },
  };
}

function emitExecCommandOutput(
  ctx: {
    callId: string;
    emitAgentEvent?: (event: {
      type: 'tool_output_delta';
      payload: {
        callId: string;
        tool: string;
        stream: 'stdout' | 'stderr';
        text: string;
      };
    }) => void;
  },
  stream: 'stdout' | 'stderr',
  text: string,
): void {
  ctx.emitAgentEvent?.({
    type: 'tool_output_delta',
    payload: {
      callId: ctx.callId,
      tool: 'exec_command',
      stream,
      text,
    },
  });
}
