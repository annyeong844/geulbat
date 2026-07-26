import type { RunSessionViewModel } from './run-session-view-model.js';
import type { createHomeRunSessionView } from './home-run-session-view.js';

/**
 * 런 세션 뷰모델을 홈 셸 입력으로 넘긴다. 예전에는 필드 41개를 한 줄씩 손으로
 * 옮겨 적었고, 상류에 필드가 늘어도 여기 한 줄을 빠뜨리면 컴파일은 통과한 채
 * 기능만 화면에 닿지 않았다. 입력 타입이 뷰모델에서 파생되도록 바꿨으므로
 * 이제는 그대로 흘려보내고, 이름이 다른 자리만 명시한다.
 */
export function createHomeRunSessionInput(
  runSession: RunSessionViewModel,
): Parameters<typeof createHomeRunSessionView>[0]['runSession'] {
  const { activeRunId: _activeRunId, isSettling, ...forwarded } = runSession;
  return { ...forwarded, isRunSettling: isSettling };
}
