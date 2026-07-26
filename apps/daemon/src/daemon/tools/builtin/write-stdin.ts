import { z } from 'zod';

import { toolError } from '../result.js';
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

export const writeStdinTool = defineZodTool({
  name: 'write_stdin',
  description:
    'Continue or observe a host command previously yielded by exec_command. Empty writes can poll, a bounded stdout/stderr page can be returned in the same call, terminate stops the process tree without deleting output, and chars are accepted only when the approved exec_command opened stdin. The opaque outputRef is a thread-bound continuation capability; this tool never starts a new command and does not allocate a PTY.',
  argsSchema: writeStdinArgsSchema,
  sideEffectLevel: 'destructive',
  mayMutateComputerFiles: true,
  requiresApproval: false,
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
    const runtime = ctx.runtimeServices?.hostCommands;
    if (runtime === undefined) {
      return toolError(
        'execution_failed',
        'write_stdin requires the daemon host command runtime.',
      );
    }

    const result = await runtime.interact({
      stateRoot: ctx.stateRoot,
      threadId: ctx.threadId,
      outputRef: args.outputRef,
      ...(args.chars === undefined ? {} : { chars: args.chars }),
      ...(args.closeStdin === undefined ? {} : { closeStdin: args.closeStdin }),
      ...(args.terminate === undefined ? {} : { terminate: args.terminate }),
      ...(args.afterRevision === undefined
        ? {}
        : { afterRevision: args.afterRevision }),
      ...(args.yieldTimeMs === undefined
        ? {}
        : { yieldTimeMs: args.yieldTimeMs }),
      ...(args.stream === undefined || args.limitBytes === undefined
        ? {}
        : {
            page: {
              stream: args.stream,
              offsetBytes: args.offsetBytes ?? 0,
              limitBytes: args.limitBytes,
            },
          }),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    if (!result.ok) {
      return toolError(
        result.reasonCode === 'not_found'
          ? 'not_found'
          : result.reasonCode === 'access_denied'
            ? 'access_denied'
            : result.reasonCode === 'invalid_args' ||
                // 뒤늦은 재전송이 순서를 뒤집으려 한 것 — 이 요청 자체가
                // 더는 유효하지 않다는 뜻이므로 인자 오류로 돌려준다.
                result.reasonCode === 'operation_superseded'
              ? 'invalid_args'
              : 'execution_failed',
        result.message,
      );
    }
    return { ok: true, output: JSON.stringify(result.value) };
  },
});
