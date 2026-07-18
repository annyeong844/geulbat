import type { RunToolResultPayload } from '@geulbat/protocol/run-channel';
import { isRecord } from '@geulbat/protocol/runtime-utils';

// 아티팩트/위젯 프레임 → 부모 back-channel (§geulbat artifact back-channel
// design). 프레임은 데이터(text)만 보내고, 권한/컨텍스트(threadId, runId,
// permissionMode)는 부모가 자기 신뢰 상태에서 주입한다. scopeHandle이
// 프레임 인스턴스에 메시지를 바인딩한다 — export snapshot 채널과 동일 패턴.
export const ARTIFACT_RUNTIME_AGENT_MESSAGE_KIND =
  'geulbat.artifact_runtime_agent';

// back-channel 설계 정본의 프레임 경계 텍스트 상한 — 신뢰할 수 없는
// 프레임이 초대형 페이로드를 밀어 넣는 것을 수신 경계에서 거른다.
const MAX_AGENT_TEXT_LENGTH = 8000;

interface ArtifactRuntimeAgentPromptRequest {
  kind: 'agent_prompt_request';
  text: string;
  displayText: string | null;
}

interface ArtifactRuntimeAgentInterjectRequest {
  kind: 'agent_interject_request';
  text: string;
}

interface ArtifactRuntimeAgentToolRequest {
  kind: 'agent_tool_request';
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export type ArtifactRuntimeAgentMessage =
  | ArtifactRuntimeAgentPromptRequest
  | ArtifactRuntimeAgentInterjectRequest
  | ArtifactRuntimeAgentToolRequest;

// 부모 → 프레임 도구 결과 회신. 프레임 helper(window.geulbat.requestTool)의
// pending Promise가 requestId로 상관해 resolve한다.
const ARTIFACT_RUNTIME_AGENT_TOOL_RESULT_MESSAGE_KIND =
  'geulbat.shell.agent_tool_result';

export function createArtifactRuntimeAgentToolResultMessage(args: {
  requestId: string;
  result: RunToolResultPayload;
}): Record<string, unknown> {
  return {
    kind: ARTIFACT_RUNTIME_AGENT_TOOL_RESULT_MESSAGE_KIND,
    requestId: args.requestId,
    result: args.result,
  };
}

export function readArtifactRuntimeAgentMessage(
  value: unknown,
  expectedScopeHandle: string,
): ArtifactRuntimeAgentMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value['kind'] !== ARTIFACT_RUNTIME_AGENT_MESSAGE_KIND ||
    value['scopeHandle'] !== expectedScopeHandle
  ) {
    return null;
  }

  if (value['action'] === 'request_prompt') {
    const text = readBoundedAgentText(value['text']);
    if (text === null) {
      return null;
    }
    if (value['displayText'] === undefined) {
      return { kind: 'agent_prompt_request', text, displayText: null };
    }
    const displayText = readBoundedAgentText(value['displayText']);
    if (displayText === null) {
      return null;
    }
    return { kind: 'agent_prompt_request', text, displayText };
  }

  if (value['action'] === 'request_interject') {
    const text = readBoundedAgentText(value['text']);
    if (text === null) {
      return null;
    }
    return { kind: 'agent_interject_request', text };
  }

  if (value['action'] === 'request_tool') {
    const requestId = readBoundedAgentText(value['requestId']);
    const toolName = readBoundedAgentText(value['toolName']);
    if (requestId === null || toolName === null) {
      return null;
    }
    const args = value['args'] === undefined ? {} : value['args'];
    if (!isRecord(args)) {
      return null;
    }
    return { kind: 'agent_tool_request', requestId, toolName, args };
  }

  return null;
}

function readBoundedAgentText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_AGENT_TEXT_LENGTH) {
    return null;
  }
  return trimmed;
}
