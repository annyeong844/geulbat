import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { assertThreadId as assertValidThreadId } from '@geulbat/protocol/ids';

import { readRunToolRequest } from './run-channel-control-request.js';
import type { RunChannelRuntimeContext } from './run-channel-runtime-context.js';
import { sendError, sendMessage } from './run-channel-socket.js';
import { getSocketState } from './run-channel-socket-runtime.js';
import { readWorkingDirectory } from './run-channel-start-request.js';

// run.tool — 아티팩트 프레임 발 도구 호출(back-channel 설계 §7). 활성
// run이 있으면 그 컨텍스트(runId/workingDirectory)를 재사용하고, 없으면
// run.start와 같은 경계로 부모 주입 workingDirectory를 검증해 경량
// standalone dispatch를 구성한다. 실행/감사는 composition root가 주입한
// artifactFrameToolDispatch port 뒤의 agent 계층이 소유한다.
export async function handleRunTool(
  socket: WebSocket,
  requestId: string,
  request: unknown,
  runtimeContext: RunChannelRuntimeContext,
): Promise<void> {
  const parsed = readRunToolRequest(request);
  if (!parsed.ok) {
    sendError(socket, requestId, 400, 'invalid_args', parsed.message);
    return;
  }
  const {
    threadId: rawThreadId,
    toolName,
    args: toolArgs,
    scopeHandle,
    frameRequestId,
  } = parsed.value;
  const threadId = assertValidThreadId(rawThreadId);

  const activeRun = runtimeContext.activeRuns.getRunByThreadId(threadId);
  let runId: string;
  let workingDirectory: string;
  if (activeRun !== undefined && !activeRun.aborted) {
    runId = activeRun.runId;
    workingDirectory = activeRun.workingDirectory;
  } else {
    if (runtimeContext.computerFileScope === undefined) {
      sendError(
        socket,
        requestId,
        404,
        'not_found',
        'computer file root is unavailable',
      );
      return;
    }
    const resolved = await readWorkingDirectory(
      parsed.value.workingDirectory === undefined
        ? {}
        : { workingDirectory: parsed.value.workingDirectory },
      { computerFileScope: runtimeContext.computerFileScope },
    );
    if (!resolved.ok) {
      sendError(
        socket,
        requestId,
        resolved.status,
        resolved.code,
        resolved.message,
      );
      return;
    }
    // 프레임이 준 문자열을 식별자에 섞지 않는다 — 상관은 frameRequestId가
    // 담당하고 runId는 서버가 만든다.
    runId = `artifact-frame-${randomUUID()}`;
    workingDirectory = resolved.workingDirectory;
  }

  const socketState = getSocketState(socket);
  const result = await runtimeContext.artifactFrameToolDispatch({
    threadId,
    runId,
    workingDirectory,
    approvalSessionId: socketState.approvalSessionId,
    toolName,
    toolArgs,
    scopeHandle,
    frameRequestId,
  });

  sendMessage(socket, {
    type: 'run.control',
    requestId,
    action: 'run.tool',
    ok: true,
    result,
  });
}
