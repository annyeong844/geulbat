import { z } from 'zod';

import { defineZodTool } from '../zod-tool.js';

/**
 * suggest_followup — 다음 걸음이 명확할 때만 컴포저에 희미하게 띄우는 제안.
 *
 * 저장하지 않는다. 이건 그 턴의 결과 표시이지 durable state가 아니다 —
 * 저장하면 재접속 때 맞출 상태가 늘고, 세 턴 전 제안이 남아 있는 건 없는 것보다
 * 나쁘다. 셸이 tool_call 이벤트에서 읽어 다음 턴이나 새로고침에 버린다.
 *
 * ask_user와 역할이 다르다. ask_user는 사용자 결정 없이 나아갈 수 없을 때 막고
 * 기록에 남는다. 이 도구는 막지 않고 기록에도 남지 않는다.
 */
const suggestFollowupArgsSchema = z.strictObject({
  prompt: z
    .string()
    .min(1, 'prompt is required.')
    .describe(
      'The follow-up request, written as the user would type it. One actionable step.',
    ),
});

export const suggestFollowupTool = defineZodTool({
  name: 'suggest_followup',
  description:
    'Offer one follow-up request for the user to accept in the composer. Call this only when the next step is clear and you would actually take it next; skip it otherwise. Never use it to ask a question you need answered to proceed — use ask_user for that.',
  argsSchema: suggestFollowupArgsSchema,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  recoveryStrategy: 'replay_safe',
  catalogSearchMetadata: {
    family: 'planning',
    searchHints: ['suggest follow-up', 'next step', 'prompt suggestion'],
    tags: ['suggestion', 'composer', 'next'],
    whenToUse:
      'Propose the next step after finishing work, when that step is clear.',
    notFor:
      'Asking a question you need answered, or changing files, plans, or commands.',
  },
  executeParsed(args) {
    // 셸은 tool_call 이벤트에서 제안을 읽는다. 여기서는 모델에게 제안이
    // 전달되었다는 사실만 되돌려 준다.
    return Promise.resolve({
      ok: true as const,
      output: JSON.stringify({ ok: true, offered: args.prompt }),
    });
  },
});
