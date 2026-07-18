import type { RunToolResultPayload } from '@geulbat/protocol/run-channel';

import type {
  GeneratedBinaryExportSnapshot,
  GeneratedTextExportSnapshot,
} from '../../artifacts/artifact-types.js';
import type { ArtifactRuntimePersistenceBridgeResponder } from '../runtime-persistence/artifact-runtime-persistence-types.js';
import { tryConsumeArtifactBackchannelBudget } from './artifact-backchannel-rate-limit.js';
import { createArtifactRuntimeHostBootMessage } from './artifact-runtime-host.js';
import { createArtifactRuntimeAgentToolResultMessage } from './artifact-runtime-frame-agent-messages.js';
import { readArtifactRuntimeFrameMessage } from './artifact-runtime-frame-messages.js';

export interface ArtifactRuntimeAgentPromptIntent {
  text: string;
  displayText: string | null;
}

export interface ArtifactRuntimeAgentInterjectIntent {
  text: string;
}

export interface ArtifactRuntimeAgentToolIntent {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  scopeHandle: string;
}

interface ArtifactRuntimeFrameMessageHandlerArgs {
  iframeRef: { current: HTMLIFrameElement | null };
  runtimeDocument: string;
  runtimeHostOrigin: string;
  scopeHandle: string;
  // 프레임 높이 하한 — 카드/인라인 variant가 서로 다른 값을 주입한다
  minFrameHeight?: number;
  bridgeResponder: ArtifactRuntimePersistenceBridgeResponder;
  markHostReady: () => void;
  setFrameHeight: (height: number) => void;
  onGeneratedTextExportSnapshotChange?: (
    snapshot: GeneratedTextExportSnapshot | null,
  ) => void;
  onGeneratedBinaryExportSnapshotChange?: (
    snapshot: GeneratedBinaryExportSnapshot | null,
  ) => void;
  // back-channel 의도 — 핸들러는 run 채널을 직접 만지지 않고 의도만 위로
  // 올린다 (신뢰 컨텍스트 주입은 assistant 피처의 몫).
  onAgentPromptRequest?: (intent: ArtifactRuntimeAgentPromptIntent) => void;
  onAgentInterjectRequest?: (
    intent: ArtifactRuntimeAgentInterjectIntent,
  ) => void;
  // 도구 호출 의도 — 부모가 신뢰 컨텍스트를 주입해 run.tool로 번역하고,
  // 결과는 이 핸들러가 requestId 상관 회신으로 프레임에 되돌린다.
  onAgentToolRequest?: (
    intent: ArtifactRuntimeAgentToolIntent,
  ) => Promise<RunToolResultPayload>;
}

export function handleArtifactRuntimeFrameMessageEvent(
  event: MessageEvent<unknown>,
  args: ArtifactRuntimeFrameMessageHandlerArgs,
): Promise<void> | void {
  const frameWindow = args.iframeRef.current?.contentWindow;
  if (event.source !== frameWindow || event.origin !== args.runtimeHostOrigin) {
    return;
  }

  const frameMessage =
    args.minFrameHeight !== undefined
      ? readArtifactRuntimeFrameMessage(
          event.data,
          args.scopeHandle,
          args.minFrameHeight,
        )
      : readArtifactRuntimeFrameMessage(event.data, args.scopeHandle);
  if (frameMessage) {
    switch (frameMessage.kind) {
      case 'host_ready':
        args.markHostReady();
        postRuntimeBootMessage({
          target: event.source,
          runtimeDocument: args.runtimeDocument,
          runtimeHostOrigin: args.runtimeHostOrigin,
        });
        break;
      case 'host_resize':
        args.setFrameHeight(frameMessage.height);
        break;
      case 'generated_binary_export_snapshot':
        args.onGeneratedBinaryExportSnapshotChange?.(frameMessage.snapshot);
        break;
      case 'generated_text_export_snapshot':
        args.onGeneratedTextExportSnapshotChange?.(frameMessage.snapshot);
        break;
      case 'agent_prompt_request':
        // 예산 초과 프롬프트류는 조용히 드롭 — 프레임에 회신 채널 의무가
        // 없는 fire-and-forget 의도이고, 거부 회신 자체가 난사 증폭이 된다.
        if (!tryConsumeArtifactBackchannelBudget(args.scopeHandle, 'prompt')) {
          break;
        }
        args.onAgentPromptRequest?.({
          text: frameMessage.text,
          displayText: frameMessage.displayText,
        });
        break;
      case 'agent_interject_request':
        if (!tryConsumeArtifactBackchannelBudget(args.scopeHandle, 'prompt')) {
          break;
        }
        args.onAgentInterjectRequest?.({ text: frameMessage.text });
        break;
      case 'agent_tool_request':
        // 도구 호출은 pending Promise가 걸려 있다 — 드롭 대신 rate_limited
        // 데이터 응답으로 settle시킨다.
        if (!tryConsumeArtifactBackchannelBudget(args.scopeHandle, 'tool')) {
          return respondWithAgentToolResult(event, args, {
            requestId: frameMessage.requestId,
            result: {
              ok: false,
              errorCode: 'rate_limited',
              error: 'artifact frame tool budget exhausted; retry later',
            },
          });
        }
        return respondToAgentToolRequest(event, args, {
          requestId: frameMessage.requestId,
          toolName: frameMessage.toolName,
          args: frameMessage.args,
          scopeHandle: args.scopeHandle,
        });
    }
    return;
  }

  return args.bridgeResponder
    .handleMessage(event.source, event.data)
    .then((response) => {
      const currentFrameWindow = args.iframeRef.current?.contentWindow;
      if (
        !response ||
        event.source !== currentFrameWindow ||
        !isPostMessageTarget(event.source)
      ) {
        return;
      }
      event.source.postMessage(response, args.runtimeHostOrigin);
    });
}

// 결과는 항상 회신한다 — 핸들러 미배선/실패를 조용히 삼키면 프레임의
// pending Promise가 영원히 매달린다.
async function respondToAgentToolRequest(
  event: MessageEvent<unknown>,
  args: ArtifactRuntimeFrameMessageHandlerArgs,
  intent: ArtifactRuntimeAgentToolIntent,
): Promise<void> {
  const onAgentToolRequest = args.onAgentToolRequest;
  let result: RunToolResultPayload;
  if (onAgentToolRequest === undefined) {
    result = {
      ok: false,
      errorCode: 'unavailable',
      error: 'tool channel is not wired for this artifact frame',
    };
  } else {
    try {
      result = await onAgentToolRequest(intent);
    } catch (error: unknown) {
      result = {
        ok: false,
        errorCode: 'internal',
        error: error instanceof Error ? error.message : 'tool request failed',
      };
    }
  }
  respondWithAgentToolResult(event, args, {
    requestId: intent.requestId,
    result,
  });
}

function respondWithAgentToolResult(
  event: MessageEvent<unknown>,
  args: ArtifactRuntimeFrameMessageHandlerArgs,
  reply: { requestId: string; result: RunToolResultPayload },
): void {
  const currentFrameWindow = args.iframeRef.current?.contentWindow;
  if (
    event.source !== currentFrameWindow ||
    !isPostMessageTarget(event.source)
  ) {
    return;
  }
  event.source.postMessage(
    createArtifactRuntimeAgentToolResultMessage(reply),
    args.runtimeHostOrigin,
  );
}

function postRuntimeBootMessage(args: {
  target: MessageEventSource | null;
  runtimeDocument: string;
  runtimeHostOrigin: string;
}) {
  if (!isPostMessageTarget(args.target)) {
    return;
  }
  args.target.postMessage(
    createArtifactRuntimeHostBootMessage(args.runtimeDocument),
    args.runtimeHostOrigin,
  );
}

function isPostMessageTarget(
  value: MessageEventSource | null,
): value is MessageEventSource & {
  postMessage: (message: unknown, targetOrigin: string) => void;
} {
  return value !== null && 'postMessage' in value;
}
