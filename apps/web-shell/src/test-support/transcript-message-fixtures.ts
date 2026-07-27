import type { ThreadMessage } from '@geulbat/protocol/threads';

// 전사 테스트가 공유하는 ThreadMessage 팩토리. 원래 각 테스트 파일 안에
// 지역 함수로 있었고, owner별 테스트로 분리할 때 세 곳에 복사하지 않도록
// 여기로 올렸다. 이름과 본문은 이동 전과 동일하게 유지한다.
export function toolMessage(
  entryId: string,
  role: 'tool_call' | 'tool_result',
  content: string,
): ThreadMessage {
  return {
    entryId,
    role,
    content,
    timestamp: '2026-07-12T00:00:00.000Z',
  };
}

export function assistantMessage(
  entryId: string,
  content: string,
): ThreadMessage {
  return {
    entryId,
    role: 'assistant',
    content,
    timestamp: '2026-07-20T00:00:00.000Z',
  };
}
