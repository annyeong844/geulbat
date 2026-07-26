import { z } from 'zod';

import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

// P7.5 §12 — 세션 열거의 모델 노출.
//
// 모델은 자기가 받은 outputRef로만 세션에 닿는다. 그런데 그 ref는 대화
// 기록에 실려 있고, 압축(compaction)이 그 자리를 지우면 **아직 돌고 있는
// 명령에 다시 닿을 길이 사라진다** — 프로세스는 살아 있는데 손잡이만 잃는
// 것이다. 이 도구는 그 손잡이를 되찾는 유일한 경로다.
//
// 읽기 전용이며 스레드 밖은 보이지 않는다(§13 비목표: 세션의 스레드 간 공유).

const listCommandsArgsSchema = z.strictObject({});

export const listCommandsTool = defineZodTool({
  name: 'list_commands',
  description:
    'List the host command sessions this thread still holds, including ones whose outputRef is no longer visible in the conversation. Each entry carries the outputRef that write_stdin needs to poll, page, or terminate it. This tool starts nothing, writes nothing, and never shows another thread’s sessions.',
  argsSchema: listCommandsArgsSchema,
  sideEffectLevel: 'read',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  // 드물게 쓰는 복구용 도구다. 기본 표면(directHot)은 캐시 prefix 비용을
  // 영구히 무는 자리이므로 여기 올리지 않고, tool_search로 찾게 둔다 —
  // 그러라고 위의 searchHints가 있다.
  exposure: {
    directHot: false,
    sdkVisible: true,
    // 레지스트리 불변식: non-hot 도구는 완전한 SDK 도달성을 갖춰야 한다 —
    // hot에서 뺐으면 다른 길이 반드시 있어야 한다는 뜻이다.
    inCellCallable: true,
    directOnly: false,
    effectClass: 'readOnly',
  },
  catalogSearchMetadata: {
    family: 'command',
    searchHints: [
      'running commands',
      'background commands',
      'what is still running',
      'lost outputRef',
      'list sessions',
    ],
    tags: ['command', 'process', 'session', 'listing', 'recovery'],
    whenToUse:
      'Recover the outputRef of a host command that is still running when the reference is no longer in view, or check what this thread left running.',
    notFor:
      'Starting commands, reading command output (use write_stdin), subagent runs, or PTC cells.',
  },
  async executeParsed(_args, ctx) {
    if (!ctx.threadId || !ctx.stateRoot) {
      return toolError(
        'execution_failed',
        'list_commands requires an agent thread context.',
      );
    }
    const hostCommands = ctx.runtimeServices?.hostCommands;
    if (hostCommands === undefined) {
      return toolError(
        'execution_failed',
        'list_commands requires the daemon host command runtime.',
      );
    }
    const sessions = await hostCommands.listThreadSessions({
      stateRoot: ctx.stateRoot,
      threadId: ctx.threadId,
    });
    const now = Date.now();
    return {
      ok: true,
      output: JSON.stringify({
        sessions: sessions.map((session) => ({
          outputRef: session.outputRef,
          command: session.command,
          status: session.status,
          running: session.running,
          stdinOpen: session.stdinOpen,
          runningForMs: Math.max(0, now - session.startedAtMs),
          stdoutBytes: session.stdoutBytes,
          stderrBytes: session.stderrBytes,
          revision: session.revision,
        })),
      }),
    };
  },
});
