import { platform } from 'node:os';
import {
  runBoundedChildProcess,
  type BoundedChildProcessResult,
} from '../../bounded-child-process.js';
import { z } from 'zod';
import { resolveSourceDirectoryTarget } from '../../files/file-platform.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
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
  maxOutputBytesPerStream: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Optional caller-owned buffered byte stop for stdout and stderr separately. Omit it to let the command finish without a tool-imposed output stop; completed output is preserved through the durable tool-output path.',
    ),
});

type ExecCommandStatus = BoundedChildProcessResult['kind'];

interface ExecCommandOutput {
  command: string;
  cwd: string;
  status: ExecCommandStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
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
    'Run a real approved shell command from the daemon host with the daemon process environment. Its optional cwd is a start location, not a file-authority boundary; admitted absolute cwd paths may select another Computer directory. This is not PTC exec, not a file-tool alias, and not a read-only shortcut.',
  argsSchema: execCommandArgsSchema,
  sideEffectLevel: 'destructive',
  mayMutateComputerFiles: true,
  requiresApproval: true,
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
      'Run a real host shell command when command execution itself is required and approval is available.',
    notFor:
      'Routine file listing, reading, searching, or editing when a dedicated Geulbat tool is available; PTC cells; browser automation; URL fetching; or catalog discovery.',
  },
  async executeParsed(args, ctx) {
    const cwd = await resolveExecCommandCwd(ctx, args.cwd);
    const shell = buildShellCommandInvocation(args.cmd);
    const startedAt = Date.now();
    const result = await runBoundedChildProcess({
      executable: shell.executable,
      args: shell.args,
      cwd,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      env: process.env,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      cancelledStderr: 'exec_command cancelled',
      ...(args.maxOutputBytesPerStream === undefined
        ? {}
        : {
            outputBufferPolicy: {
              maxBufferedBytesPerStream: args.maxOutputBytesPerStream,
            },
          }),
    });
    const output = buildExecCommandOutput({
      command: args.cmd,
      cwd,
      durationMs: Date.now() - startedAt,
      maxOutputBytesPerStream: args.maxOutputBytesPerStream,
      result,
      timeoutMs: args.timeoutMs,
    });
    return { ok: true, output: JSON.stringify(output) };
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

function buildExecCommandOutput(args: {
  command: string;
  cwd: string;
  durationMs: number;
  maxOutputBytesPerStream: number | undefined;
  result: BoundedChildProcessResult;
  timeoutMs: number | undefined;
}): ExecCommandOutput {
  return {
    command: args.command,
    cwd: args.cwd,
    status: args.result.kind,
    exitCode: args.result.kind === 'exit' ? args.result.exitCode : null,
    stdout: args.result.stdout,
    stderr: args.result.stderr,
    durationMs: args.durationMs,
    timeoutMs: args.timeoutMs ?? null,
    maxOutputBytesPerStream: args.maxOutputBytesPerStream ?? null,
    outputLimitExceeded:
      args.result.kind === 'output_limit_exceeded'
        ? {
            stream: args.result.stream,
            maxBufferedBytesPerStream: args.result.maxBufferedBytesPerStream,
          }
        : null,
  };
}
