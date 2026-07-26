import { z } from 'zod';
import { catchToolError, toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

const setThreadTitleArgsSchema = z.strictObject({
  title: z
    .string()
    .min(1, 'title is required.')
    .max(60, 'title must be at most 60 characters.')
    .describe('A concise thread title, 4-7 words, in the user’s language.'),
});

// 첫 응답에서 모델이 스레드 제목을 요약해 붙인다. 이미 제목이 있으면
// (자동이든 사용자의 이름 변경이든) 조용히 no-op — 절대 덮어쓰지 않는다.
export const setThreadTitleTool = defineZodTool({
  name: 'set_thread_title',
  description:
    'Set a concise summary title for this thread, shown in the session list. Call once in your first reply of a new thread, before answering. No-op if the thread already has a title.',
  argsSchema: setThreadTitleArgsSchema,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  recoveryStrategy: 'replay_safe',
  catalogSearchMetadata: {
    family: 'planning',
    searchHints: ['thread title', 'session title', 'rename thread', 'summary'],
    tags: ['title', 'thread', 'session'],
    whenToUse:
      'Give a new thread a short human-readable title in the first reply.',
    notFor: 'Renaming a thread the user already titled, or mid-conversation.',
  },
  async executeParsed(args, ctx) {
    const threadId = ctx.threadId;
    const stateRoot = ctx.stateRoot;
    const threadIndex = ctx.runtimeServices?.threadIndex;
    if (!threadId || !stateRoot || !threadIndex) {
      return toolError(
        'execution_failed',
        'thread and Home state runtime context are required for set_thread_title.',
      );
    }

    try {
      const title = args.title.trim();
      const entries = await threadIndex.loadThreadIndex(stateRoot);
      const existing = entries.find((entry) => entry.threadId === threadId);
      if (existing?.title !== undefined) {
        return {
          ok: true,
          output: JSON.stringify({
            ok: true,
            skipped: 'already_titled',
            title: existing.title,
          }),
        };
      }
      await threadIndex.upsertThreadSummary(stateRoot, {
        threadId,
        lastUpdated: existing?.lastUpdated ?? new Date().toISOString(),
        messageCount: existing?.messageCount ?? 0,
        title,
      });
      return { ok: true, output: JSON.stringify({ ok: true, title }) };
    } catch (err: unknown) {
      return catchToolError(err);
    }
  },
});
