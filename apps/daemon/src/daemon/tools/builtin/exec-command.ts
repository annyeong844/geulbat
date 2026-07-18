import { platform } from 'node:os';
import {
  runBoundedProcessCommand,
  type BoundedProcessCommandResult,
} from '@geulbat/shared-utils/process-command';
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
      'Working directory. Relative paths resolve from the run current directory; every path must remain inside ComputerFileScope.',
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(EXEC_COMMAND_MAX_TIMER_MS)
    .describe('Command timeout in milliseconds.'),
  maxOutputBytesPerStream: z
    .number()
    .int()
    .positive()
    .max(EXEC_COMMAND_MAX_TIMER_MS)
    .describe(
      'Maximum buffered bytes for stdout and stderr separately before the command is stopped.',
    ),
});

type ExecCommandStatus = BoundedProcessCommandResult['kind'];

interface ExecCommandOutput {
  command: string;
  cwd: string;
  status: ExecCommandStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timeoutMs: number;
  maxOutputBytesPerStream: number;
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
    'Run a real approved shell command from the daemon host with the daemon process environment. This is not PTC exec, not a file-tool alias, and not a read-only shortcut.',
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
    const result = await runBoundedProcessCommand({
      executable: shell.executable,
      args: shell.args,
      cwd,
      timeoutMs: args.timeoutMs,
      env: process.env,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      cancelledStderr: 'exec_command cancelled',
      outputBufferPolicy: {
        maxBufferedBytesPerStream: args.maxOutputBytesPerStream,
      },
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
  maxOutputBytesPerStream: number;
  result: BoundedProcessCommandResult;
  timeoutMs: number;
}): ExecCommandOutput {
  return {
    command: args.command,
    cwd: args.cwd,
    status: args.result.kind,
    exitCode: args.result.kind === 'exit' ? args.result.exitCode : null,
    stdout: args.result.stdout,
    stderr: args.result.stderr,
    durationMs: args.durationMs,
    timeoutMs: args.timeoutMs,
    maxOutputBytesPerStream: args.maxOutputBytesPerStream,
    outputLimitExceeded:
      args.result.kind === 'output_limit_exceeded'
        ? {
            stream: args.result.stream,
            maxBufferedBytesPerStream: args.result.maxBufferedBytesPerStream,
          }
        : null,
  };
}
