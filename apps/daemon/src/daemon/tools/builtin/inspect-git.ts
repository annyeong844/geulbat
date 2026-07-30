import { z } from 'zod';
import { resolveSourceDirectoryTarget } from '../../files/file-platform.js';
import {
  buildGitInspectionEnvironment,
  GIT_INSPECTION_GLOBAL_ARGUMENTS,
} from '../../git-inspection-command.js';
import type { HostCommandSnapshot } from '../../host-command-output-store.js';
import { runHostRoutedSystemCommand } from '../../host-routed-command.js';
import { resolveComputerFileToolPath } from '../file-tool-root.js';
import { catchToolError, toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const INSPECT_GIT_MAX_TIMER_MS = 2_147_483_647;
const INSPECT_GIT_OPERATIONS = ['status', 'diff', 'log'] as const;

const inspectGitArgsSchema = z
  .strictObject({
    operation: z
      .enum(INSPECT_GIT_OPERATIONS)
      .describe('Read-only Git operation to perform.'),
    cwd: z
      .string()
      .refine((value) => value.trim().length > 0, {
        message: 'cwd must not be empty.',
      })
      .optional()
      .describe(
        'Repository working directory. Relative paths start from the selected run cwd.',
      ),
    paths: z
      .array(
        z
          .string()
          .min(1, 'paths entries must not be empty.')
          .refine((value) => value.trim().length > 0, {
            message: 'paths entries must not be empty.',
          }),
      )
      .min(1, 'paths must contain at least one path.')
      .optional()
      .describe(
        'Optional literal Git pathspecs limiting the inspection scope.',
      ),
    staged: z
      .boolean()
      .optional()
      .describe(
        'For diff only, inspect the staged index instead of unstaged work.',
      ),
    maxEntries: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('For log only, caller-owned maximum commit count.'),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(INSPECT_GIT_MAX_TIMER_MS)
      .optional()
      .describe(
        'Optional caller-owned timeout in milliseconds. Omit to rely on run cancellation.',
      ),
  })
  .refine((args) => args.staged === undefined || args.operation === 'diff', {
    path: ['staged'],
    message: 'staged is available only for the diff operation.',
  })
  .refine((args) => args.maxEntries === undefined || args.operation === 'log', {
    path: ['maxEntries'],
    message: 'maxEntries is available only for the log operation.',
  });

type InspectGitOperation = (typeof INSPECT_GIT_OPERATIONS)[number];

interface InspectGitOutput {
  operation: InspectGitOperation;
  cwd: string;
  paths: string[];
  status: HostCommandSnapshot['status'];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export const inspectGitTool = defineZodTool({
  name: 'inspect_git',
  description:
    'Inspect Git status, diff, or history without a shell or mutation approval. Operations use fixed Git argv, disable optional locks, external diff drivers, text conversion, pagers, and credential prompts, and never accept arbitrary Git subcommands.',
  argsSchema: inspectGitArgsSchema,
  sideEffectLevel: 'read',
  mayMutateComputerFiles: false,
  abortSettlement: 'await_execution',
  requiresApproval: false,
  recoveryStrategy: 'replay_safe',
  resultProjection: {
    exactDurableRecovery: true,
    modelProjection: 'runtime_summary',
    snapshotFailure: 'fail_closed',
  },
  exposure: {
    directHot: true,
    sdkVisible: false,
    inCellCallable: false,
    directOnly: true,
    effectClass: 'readOnly',
  },
  catalogSearchMetadata: {
    family: 'command',
    searchHints: [
      'git status',
      'git diff',
      'git log',
      'repository changes',
      'commit history',
    ],
    tags: ['git', 'repository', 'read-only'],
    whenToUse:
      'Read repository status, an exact working-tree or staged diff, or commit history without invoking an approval-gated shell.',
    notFor:
      'Git mutation, arbitrary Git subcommands, file contents, tests, builds, or non-Git process execution.',
  },
  async executeParsed(args, ctx) {
    const runtimeServices = ctx.runtimeServices;
    const hostCommands = runtimeServices?.hostCommands;
    const stateRoot = ctx.stateRoot;
    if (
      runtimeServices === undefined ||
      hostCommands === undefined ||
      stateRoot === undefined
    ) {
      return toolError(
        'execution_failed',
        'inspect_git requires the daemon host command runtime and run state.',
        {
          phase: 'command_start',
          reasonCode: 'git_inspection_runtime_unavailable',
          retryHint:
            'Retry inspect_git from an active daemon run with host commands available.',
        },
      );
    }

    try {
      const cwd = await resolveInspectGitCwd(ctx, args.cwd);
      const observation = await runHostRoutedSystemCommand({
        hostCommands,
        stateRoot,
        pageLimitBytes: runtimeServices.hostCommandInlineMaxBytes,
        invocation: {
          executable: 'git',
          args: buildInspectGitArguments(args),
          cwd,
          env: buildGitInspectionEnvironment(),
          ...(args.timeoutMs === undefined
            ? {}
            : { timeoutMs: args.timeoutMs }),
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        },
      });
      if (!observation.ok) {
        return toolError(
          observation.aborted ? 'aborted' : 'execution_failed',
          observation.message,
          {
            phase: 'command_wait',
            reasonCode: observation.aborted
              ? 'git_inspection_aborted'
              : 'git_inspection_runtime_failed',
            ...(observation.aborted
              ? {}
              : {
                  retryHint:
                    'Confirm the daemon host command runtime is healthy, then retry inspect_git.',
                }),
          },
        );
      }

      const output: InspectGitOutput = {
        operation: args.operation,
        cwd,
        paths: [...(args.paths ?? [])],
        status: observation.snapshot.status,
        exitCode: observation.snapshot.exitCode,
        stdout: observation.stdout,
        stderr: observation.stderr,
      };
      if (
        observation.snapshot.status !== 'exit' ||
        observation.snapshot.exitCode !== 0
      ) {
        return {
          ok: false,
          output: JSON.stringify(output),
          errorCode: 'execution_failed',
          error: `inspect_git ${args.operation} exited with status ${observation.snapshot.status} and code ${String(observation.snapshot.exitCode)}`,
          diagnostics: {
            phase: 'command_wait',
            reasonCode:
              observation.snapshot.exitCode === null
                ? `git_${observation.snapshot.status}`
                : `git_exit_${observation.snapshot.exitCode}`,
            retryHint:
              'Check stderr and the selected cwd, operation, and path scope before retrying.',
          },
        };
      }
      return { ok: true, output: JSON.stringify(output) };
    } catch (error: unknown) {
      return catchToolError(error);
    }
  },
});

export function buildInspectGitArguments(args: {
  operation: InspectGitOperation;
  paths?: readonly string[] | undefined;
  staged?: boolean | undefined;
  maxEntries?: number | undefined;
}): string[] {
  const globalArgs = [...GIT_INSPECTION_GLOBAL_ARGUMENTS];
  const pathArgs =
    args.paths === undefined ? [] : ['--', ...args.paths.map(String)];
  switch (args.operation) {
    case 'status':
      return [
        ...globalArgs,
        'status',
        '--short',
        '--branch',
        '--untracked-files=all',
        ...pathArgs,
      ];
    case 'diff':
      return [
        ...globalArgs,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        ...(args.staged === true ? ['--cached'] : []),
        ...pathArgs,
      ];
    case 'log':
      return [
        ...globalArgs,
        'log',
        '--no-show-signature',
        '--date=iso-strict',
        '--format=%H%x09%aI%x09%an%x09%s',
        ...(args.maxEntries === undefined
          ? []
          : [`--max-count=${args.maxEntries}`]),
        ...pathArgs,
      ];
  }
}

async function resolveInspectGitCwd(
  ctx: { computerFileRoot?: string; workingDirectory?: string },
  cwd: string | undefined,
): Promise<string> {
  const filePath = resolveComputerFileToolPath(ctx, cwd?.trim() || '.');
  const target = await resolveSourceDirectoryTarget(
    filePath.absoluteRoot,
    filePath.path,
  );
  if (!target.exists) {
    throw new Error(`inspect_git cwd not found: ${filePath.path}`);
  }
  return target.canonicalAbsolutePath;
}
