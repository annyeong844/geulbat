import { z } from 'zod';
import { toolError } from '../result.js';
import { defineZodTool } from '../zod-tool.js';

// ask_user — 사용자에게 선택지를 제시하는 턴 출력 카드. 도구 자체는
// 실행을 멈추고 기다리지 않는다: 모델이 이 도구를 부르고 턴을 끝내면
// web-shell이 tool_call args를 옵션 카드로 그리고, 사용자의 클릭이 일반
// 사용자 메시지로 다음 턴을 시작한다 (visualize와 같은 args-렌더 패턴).
const askUserArgsSchema = z.strictObject({
  question: z
    .string()
    .min(1, 'question is required.')
    .describe('The question to ask the user, phrased completely.'),
  options: z
    .array(
      z.strictObject({
        label: z
          .string()
          .min(1, 'option label is required.')
          .describe('Short selectable answer shown on the button.'),
        description: z
          .string()
          .optional()
          .describe('Optional one-line explanation under the label.'),
      }),
    )
    .min(1, 'at least one option is required.')
    .describe('Mutually exclusive answer choices, best first.'),
});

export const askUserTool = defineZodTool({
  name: 'ask_user',
  description:
    'Ask the user a question with selectable answer options, rendered as an interactive card in the chat. Call this and end your turn; the user’s selection arrives as their next message. The user can always type a free-form answer instead of picking an option.',
  argsSchema: askUserArgsSchema,
  sideEffectLevel: 'none',
  mayMutateComputerFiles: false,
  requiresApproval: false,
  catalogSearchMetadata: {
    family: 'presentation',
    searchHints: ['ask user', 'question', 'choices', 'options', 'clarify'],
    tags: ['question', 'options', 'clarification'],
    whenToUse:
      'Ask the user to pick between concrete options when their answer changes what you do next.',
    notFor:
      'Questions answerable from context, or long-form prompts better asked as plain text.',
  },
  async executeParsed(args) {
    const question = args.question.trim();
    if (question === '') {
      return toolError('execution_failed', 'question must not be blank.');
    }
    return {
      ok: true,
      output: JSON.stringify({
        asked: true,
        optionCount: args.options.length,
      }),
    };
  },
});
