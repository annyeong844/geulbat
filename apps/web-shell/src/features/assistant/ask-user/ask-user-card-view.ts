import { isRecord } from '@geulbat/protocol/runtime-utils';

// ask_user 도구 호출을 선택지 카드 뷰로 좁힌다 — visualize처럼 렌더
// 원본은 tool_call args가 정본이다.
export const ASK_USER_TOOL_NAME = 'ask_user';

interface AskUserCardOption {
  label: string;
  description: string | null;
}

export interface AskUserCardView {
  question: string;
  options: AskUserCardOption[];
}

export function readAskUserCardViewFromToolArgs(
  args: unknown,
): AskUserCardView | null {
  if (!isRecord(args)) {
    return null;
  }
  const question =
    typeof args.question === 'string' ? args.question.trim() : '';
  if (question === '' || !Array.isArray(args.options)) {
    return null;
  }
  const options: AskUserCardOption[] = [];
  for (const option of args.options) {
    if (!isRecord(option)) {
      return null;
    }
    const label = typeof option.label === 'string' ? option.label.trim() : '';
    if (label === '') {
      return null;
    }
    options.push({
      label,
      description:
        typeof option.description === 'string' &&
        option.description.trim() !== ''
          ? option.description.trim()
          : null,
    });
  }
  return options.length > 0 ? { question, options } : null;
}

export function readAskUserCardViewFromToolCallContent(
  content: string,
): AskUserCardView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.tool !== ASK_USER_TOOL_NAME) {
    return null;
  }
  return readAskUserCardViewFromToolArgs(parsed.args);
}
