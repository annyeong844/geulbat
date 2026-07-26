/**
 * 자식 런이 어떻게 끝났는지에 대한 어휘 — 종료 상태와 사유.
 *
 * run-events.ts에 있었으나 "런 이벤트"의 소유물이 아니다. threads.ts가 스레드의
 * 서브에이전트 종료 결과를 검증하려고 이 판정기를 값으로 가져가면서
 * threads ↔ run-events 런타임 순환이 생겼다(양쪽 다 validator를 실제로
 * import하고, verbatimModuleSyntax 아래에서는 타입만 남은 import 문장도 그대로
 * 방출된다). 두 계약이 공통으로 쓰는 어휘라 어느 쪽에도 속하지 않는 leaf로 뺀다.
 *
 * 이 모듈은 protocol 안의 무엇도 import하지 않는다 — 그래야 leaf로 남는다.
 */

export type AgentChildTerminalState = 'completed' | 'failed' | 'cancelled';

export type AgentChildTerminalReason =
  | 'child_error'
  | 'provider_error'
  | 'tool_error'
  | 'persistence_error'
  | 'daemon_restart'
  | 'daemon_shutdown'
  | 'timeout'
  | 'user_interrupt'
  | 'sibling_error'
  | 'explicit_stop';

export function isAgentChildTerminalState(
  value: unknown,
): value is AgentChildTerminalState {
  return value === 'completed' || value === 'failed' || value === 'cancelled';
}

export function isAgentChildTerminalReason(
  value: unknown,
): value is AgentChildTerminalReason {
  return (
    value === 'child_error' ||
    value === 'provider_error' ||
    value === 'tool_error' ||
    value === 'persistence_error' ||
    value === 'daemon_restart' ||
    value === 'daemon_shutdown' ||
    value === 'timeout' ||
    value === 'user_interrupt' ||
    value === 'sibling_error' ||
    value === 'explicit_stop'
  );
}
