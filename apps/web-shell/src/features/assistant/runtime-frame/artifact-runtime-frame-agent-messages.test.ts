import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ARTIFACT_RUNTIME_AGENT_MESSAGE_KIND,
  readArtifactRuntimeAgentMessage,
} from './artifact-runtime-frame-agent-messages.js';

const SCOPE_HANDLE = 'scope-handle-1';

void test('request_prompt는 scopeHandle이 일치할 때만 통과한다', () => {
  const message = {
    kind: ARTIFACT_RUNTIME_AGENT_MESSAGE_KIND,
    action: 'request_prompt',
    scopeHandle: SCOPE_HANDLE,
    text: '검증 단계를 더 설명해줘',
  };

  assert.deepEqual(readArtifactRuntimeAgentMessage(message, SCOPE_HANDLE), {
    kind: 'agent_prompt_request',
    text: '검증 단계를 더 설명해줘',
    displayText: null,
  });
  assert.equal(readArtifactRuntimeAgentMessage(message, 'other-scope'), null);
});

void test('request_prompt는 displayText를 함께 통과시킨다', () => {
  const message = {
    kind: ARTIFACT_RUNTIME_AGENT_MESSAGE_KIND,
    action: 'request_prompt',
    scopeHandle: SCOPE_HANDLE,
    text: 'raw prompt',
    displayText: '표시용 문구',
  };

  assert.deepEqual(readArtifactRuntimeAgentMessage(message, SCOPE_HANDLE), {
    kind: 'agent_prompt_request',
    text: 'raw prompt',
    displayText: '표시용 문구',
  });
});

void test('request_interject는 text만 나른다', () => {
  const message = {
    kind: ARTIFACT_RUNTIME_AGENT_MESSAGE_KIND,
    action: 'request_interject',
    scopeHandle: SCOPE_HANDLE,
    text: '지금 진행 중인 작업에 이 조건을 반영해줘',
  };

  assert.deepEqual(readArtifactRuntimeAgentMessage(message, SCOPE_HANDLE), {
    kind: 'agent_interject_request',
    text: '지금 진행 중인 작업에 이 조건을 반영해줘',
  });
});

void test('빈 문자열, 비문자열, 상한 초과 text는 거부한다', () => {
  const base = {
    kind: ARTIFACT_RUNTIME_AGENT_MESSAGE_KIND,
    action: 'request_prompt',
    scopeHandle: SCOPE_HANDLE,
  };

  assert.equal(
    readArtifactRuntimeAgentMessage({ ...base, text: '   ' }, SCOPE_HANDLE),
    null,
  );
  assert.equal(
    readArtifactRuntimeAgentMessage({ ...base, text: 42 }, SCOPE_HANDLE),
    null,
  );
  assert.equal(
    readArtifactRuntimeAgentMessage(
      { ...base, text: 'a'.repeat(8001) },
      SCOPE_HANDLE,
    ),
    null,
  );
  assert.equal(
    readArtifactRuntimeAgentMessage(
      { ...base, text: 'ok', displayText: 7 },
      SCOPE_HANDLE,
    ),
    null,
  );
});

void test('알 수 없는 action과 다른 kind는 거부한다', () => {
  assert.equal(
    readArtifactRuntimeAgentMessage(
      {
        kind: ARTIFACT_RUNTIME_AGENT_MESSAGE_KIND,
        action: 'request_unknown',
        scopeHandle: SCOPE_HANDLE,
        text: 'x',
      },
      SCOPE_HANDLE,
    ),
    null,
  );
  assert.equal(
    readArtifactRuntimeAgentMessage(
      {
        kind: 'geulbat.artifact_runtime_host',
        action: 'request_prompt',
        scopeHandle: SCOPE_HANDLE,
        text: 'x',
      },
      SCOPE_HANDLE,
    ),
    null,
  );
});

void test('request_tool은 requestId/toolName/args를 나르고 scopeHandle을 대조한다', () => {
  const message = {
    kind: ARTIFACT_RUNTIME_AGENT_MESSAGE_KIND,
    action: 'request_tool',
    scopeHandle: SCOPE_HANDLE,
    requestId: 'af-1',
    toolName: 'read_file',
    args: { path: 'draft.md' },
  };

  assert.deepEqual(readArtifactRuntimeAgentMessage(message, SCOPE_HANDLE), {
    kind: 'agent_tool_request',
    requestId: 'af-1',
    toolName: 'read_file',
    args: { path: 'draft.md' },
  });
  // 스코프 위조(다른 프레임의 메시지)는 통과하지 않는다
  assert.equal(readArtifactRuntimeAgentMessage(message, 'other-scope'), null);
});

void test('request_tool은 args 생략을 빈 객체로 받고, 비객체 args는 거부한다', () => {
  const base = {
    kind: ARTIFACT_RUNTIME_AGENT_MESSAGE_KIND,
    action: 'request_tool',
    scopeHandle: SCOPE_HANDLE,
    requestId: 'af-2',
    toolName: 'read_file',
  };

  assert.deepEqual(readArtifactRuntimeAgentMessage(base, SCOPE_HANDLE), {
    kind: 'agent_tool_request',
    requestId: 'af-2',
    toolName: 'read_file',
    args: {},
  });
  assert.equal(
    readArtifactRuntimeAgentMessage({ ...base, args: 'rm -rf' }, SCOPE_HANDLE),
    null,
  );
  assert.equal(
    readArtifactRuntimeAgentMessage({ ...base, args: [1, 2] }, SCOPE_HANDLE),
    null,
  );
});

void test('request_tool은 requestId/toolName이 비거나 문자열이 아니면 거부한다', () => {
  const base = {
    kind: ARTIFACT_RUNTIME_AGENT_MESSAGE_KIND,
    action: 'request_tool',
    scopeHandle: SCOPE_HANDLE,
    args: {},
  };

  assert.equal(
    readArtifactRuntimeAgentMessage(
      { ...base, requestId: '  ', toolName: 'read_file' },
      SCOPE_HANDLE,
    ),
    null,
  );
  assert.equal(
    readArtifactRuntimeAgentMessage(
      { ...base, requestId: 'af-3', toolName: 42 },
      SCOPE_HANDLE,
    ),
    null,
  );
});
