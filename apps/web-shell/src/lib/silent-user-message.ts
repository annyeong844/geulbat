import type { ThreadMessage } from '@geulbat/protocol/threads';

// silent 사용자 턴(아티팩트 ♻ 등 UI 발 자동 요청) 판정 — metadata.silent가
// 정본이다. silent 표시가 없던 이전 데몬이 저장한 과거 ♻ 턴은 displayPrompt
// 프리픽스로 인식해 함께 숨긴다(레거시 폴백).
const LEGACY_SILENT_PROMPT_PREFIXES = ['아티팩트 다시 만들기 — '] as const;

export function isSilentUserMessage(
  message: Pick<ThreadMessage, 'role' | 'content' | 'metadata'>,
): boolean {
  if (message.role !== 'user') {
    return false;
  }
  if (message.metadata?.silent === true) {
    return true;
  }
  return LEGACY_SILENT_PROMPT_PREFIXES.some((prefix) =>
    message.content.startsWith(prefix),
  );
}
