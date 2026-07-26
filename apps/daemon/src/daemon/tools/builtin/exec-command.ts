import { platform } from 'node:os';
import { z } from 'zod';
import { resolveSourceDirectoryTarget } from '../../files/file-platform.js';
import type { HostCommandSnapshot } from '../../host-command-output-store.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

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
      'Optional caller-owned foreground observation window. If the command is still running when it expires, return a durable outputRef instead of blocking the model turn. Zero yields immediately. Omitting it waits up to the runtime ceiling, not forever: a command that outlives the ceiling comes back as a running outputRef you can keep observing with write_stdin.',
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

type ExecCommandStatus = HostCommandSnapshot['status'];

interface ExecCommandOutput {
  command: string;
  cwd: string;
  status: ExecCommandStatus;
  exitCode: number | null;
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
    'Run a real approved shell command from the daemon host with the daemon process environment. It is best for host process or CLI behavior, or when one cohesive shell pipeline is more effective than dependent tool rounds; bounded structured file work is usually better served by dedicated tools, whose same-round independent reads can run concurrently. Its optional cwd is a start location, not a file-authority boundary; admitted absolute cwd paths may select another Computer directory. This is not PTC exec, not a file-tool alias, and not a read-only shortcut.',
  argsSchema: execCommandArgsSchema,
  sideEffectLevel: 'destructive',
  mayMutateComputerFiles: true,
  requiresApproval: true,
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
    const shell = buildShellCommandInvocation(args.cmd);
    const hostCommands = ctx.runtimeServices?.hostCommands;
    if (hostCommands !== undefined) {
      if (
        ctx.threadId === undefined ||
        ctx.runId === undefined ||
        ctx.stateRoot === undefined
      ) {
        return toolError(
          'execution_failed',
          'exec_command host runtime requires an agent thread context.',
        );
      }
      const started = await hostCommands.start({
        executable: shell.executable,
        args: shell.args,
        cwd,
        env: process.env,
        stateRoot: ctx.stateRoot,
        threadId: ctx.threadId,
        runId: ctx.runId,
        callId: ctx.callId,
        stdinMode: args.stdinMode ?? 'closed',
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
        ...(args.maxOutputBytesPerStream === undefined
          ? {}
          : {
              maxOutputBytesPerStream: args.maxOutputBytesPerStream,
            }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        onOutput: ({ stream, text }) => {
          emitExecCommandOutput(ctx, stream, text);
        },
      });
      if (!started.ok) {
        return toolError(
          started.reasonCode === 'runtime_closed' ||
            started.reasonCode === 'session_capacity_exhausted'
            ? 'execution_failed'
            : 'internal',
          started.message,
        );
      }
      const result = await hostCommands.waitForInitialResult({
        outputRef: started.outputRef,
        stateRoot: ctx.stateRoot,
        ...(args.yieldTimeMs === undefined
          ? {}
          : { yieldTimeMs: args.yieldTimeMs }),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      if (!result.ok) {
        return toolError(
          result.reasonCode === 'not_found' ? 'not_found' : 'execution_failed',
          result.message,
        );
      }
      return {
        ok: true,
        output: JSON.stringify(
          buildHostRuntimeExecCommandOutput({
            command: args.cmd,
            cwd,
            maxOutputBytesPerStream: args.maxOutputBytesPerStream,
            snapshot: result.value,
            timeoutMs: args.timeoutMs,
          }),
        ),
      };
    }
    return toolError(
      'execution_failed',
      'exec_command requires the daemon host command runtime.',
    );
  },
});

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
  snapshot: HostCommandSnapshot;
  timeoutMs: number | undefined;
}): ExecCommandOutput {
  return {
    command: args.command,
    cwd: args.cwd,
    status: args.snapshot.status,
    exitCode: args.snapshot.exitCode,
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
