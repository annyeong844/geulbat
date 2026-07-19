import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { RunToolResultPayload } from '@geulbat/protocol/run-channel';

import { buildCanonicalArtifactSourceRef } from '../../artifacts/artifact-source-ref.js';
import { buildHtmlArtifactRuntimePayload } from '../../artifacts/runtime-preview/html/document.js';
import {
  buildVisualizeWidgetDocument,
  buildVisualizeWidgetStreamDocument,
  VISUALIZE_STREAM_UPDATE_MESSAGE_KIND,
} from '../../artifacts/runtime-preview/visualize/document.js';
import { readVisualizeStreamViewFromArgsText } from './visualize-widget-view.js';
import { ArtifactRuntimeFrame } from '../runtime-frame/artifact-runtime-frame.js';
import type { ArtifactRuntimeAgentToolIntent } from '../runtime-frame/artifact-runtime-frame-message-handler.js';
import { MIN_INLINE_ARTIFACT_RUNTIME_FRAME_HEIGHT } from '../runtime-frame/artifact-runtime-frame-messages.js';
import type { VisualizeWidgetView } from './visualize-widget-view.js';

// visualize tool_call을 채팅 턴 안에 인라인으로 그리는 위젯. 아티팩트
// 런타임 프레임을 그대로 재사용하되 sourceRef에 artifactId가 없으므로
// persistence scope가 null이 되어 저장 경로는 구조적으로 닫힌다.
// 위젯의 sendPrompt는 back-channel 의도로 올라와 onWidgetPrompt(부모가
// 신뢰 컨텍스트를 쥔 기존 전송 경로)로 번역된다.
// 위젯 발 도구 호출(run.tool)을 신뢰 컨텍스트를 쥔 컨트롤러로 번역하는 콜백.
// 트랜스크립트 렌더 트리를 따라 내려가는 공용 계약.
export type WidgetToolRequestHandler = (
  request: ArtifactRuntimeAgentToolIntent,
) => Promise<RunToolResultPayload>;

// 점진 렌더를 이미 한 번 끝까지 재생한 위젯 내용 — 리마운트(스크롤 가상화,
// 라이브→정착 전환 등)마다 스트리밍을 다시 재생하면 렉과 깜빡임이 생기므로,
// 같은 내용은 다음부터 즉시 렌더한다.
const playedVisualizeStreams = new Set<string>();
const visualizeFrameHeights = new Map<string, number>();
let activeVisualizeStreamFrame: {
  streamKey: string;
  height: number;
} | null = null;

function buildVisualizeStreamKey(view: {
  mode: 'svg' | 'html';
  code: string;
}): string {
  return `${view.mode}::${view.code}`;
}

function VisualizeRuntimePlaceholder(props: { initialFrameHeight?: number }) {
  const height = Math.max(
    MIN_INLINE_ARTIFACT_RUNTIME_FRAME_HEIGHT,
    props.initialFrameHeight ?? MIN_INLINE_ARTIFACT_RUNTIME_FRAME_HEIGHT,
  );
  return (
    <div aria-hidden="true" className="visualize-widget" style={{ height }} />
  );
}

// 스크롤 중 새 iframe 부트만 미룬다. 한 번 부트한 프레임을 다시
// placeholder로 바꾸면 같은 위젯이 보이는 작은 스크롤에도 문서 전체가
// 재로드되므로, 컴포넌트 수명 안에서는 부트 상태를 단조롭게 유지한다.
function useVisualizeRuntimeBoot(canBootRuntime: boolean): boolean {
  const hasBootedRef = useRef(canBootRuntime);
  if (canBootRuntime) {
    hasBootedRef.current = true;
  }
  return hasBootedRef.current;
}

// 실데이터 스트리밍이 끝까지 그린 내용을 재생 완료로 표시한다 — 완성본
// 위젯이 클라이언트측 점진 렌더를 반복하지 않는다.
export function markVisualizeStreamPlayed(view: {
  mode: 'svg' | 'html';
  code: string;
}): void {
  const streamKey = buildVisualizeStreamKey(view);
  playedVisualizeStreams.add(streamKey);
  if (activeVisualizeStreamFrame?.streamKey === streamKey) {
    visualizeFrameHeights.set(streamKey, activeVisualizeStreamFrame.height);
  }
}

// 실데이터 토큰 스트리밍 위젯 — tool_call_delta로 누적되는 인자 텍스트에서
// code 프리픽스를 뽑아, 고정 수신 문서에 postMessage로 밀어 넣는다.
// 프레임 문서는 제목과 무관하게 한 번만 부트한다.
export function VisualizeStreamingWidget(props: {
  argsText: string;
  deferRuntimeBoot?: boolean;
}) {
  const { argsText, deferRuntimeBoot = false } = props;
  const view = readVisualizeStreamViewFromArgsText(argsText);
  const renderRuntime = useVisualizeRuntimeBoot(
    view !== null && !deferRuntimeBoot,
  );
  const runtimePayload = useMemo(
    () =>
      buildHtmlArtifactRuntimePayload(
        buildVisualizeWidgetStreamDocument({ title: null }),
      ),
    [],
  );
  const sourceRef = useMemo(
    () =>
      buildCanonicalArtifactSourceRef({
        workingDirectory: '',
        threadId: null,
        runId: null,
        filePath: null,
      }),
    [],
  );
  const code = view?.code ?? '';
  const streamKey = view === null ? null : buildVisualizeStreamKey(view);
  const initialFrameHeight =
    streamKey === null
      ? undefined
      : (visualizeFrameHeights.get(streamKey) ??
        (activeVisualizeStreamFrame?.streamKey === streamKey
          ? activeVisualizeStreamFrame.height
          : undefined));
  const handleFrameHeightChange = useCallback(
    (height: number) => {
      if (streamKey !== null) {
        activeVisualizeStreamFrame = { streamKey, height };
      }
    },
    [streamKey],
  );
  const frameBroadcast = useMemo(
    () =>
      code === ''
        ? null
        : {
            seq: code.length,
            message: {
              kind: VISUALIZE_STREAM_UPDATE_MESSAGE_KIND,
              code,
              done: false,
            },
          },
    [code],
  );

  if (view === null) {
    return null;
  }
  if (!renderRuntime) {
    return (
      <VisualizeRuntimePlaceholder
        {...(initialFrameHeight !== undefined ? { initialFrameHeight } : {})}
      />
    );
  }
  return (
    <div className="visualize-widget">
      <ArtifactRuntimeFrame
        renderer="html5"
        title={view.title ?? 'visualize widget'}
        sandbox="allow-scripts allow-forms allow-same-origin"
        runtimePayload={runtimePayload}
        sourceRef={sourceRef}
        variant="inline"
        frameBroadcast={frameBroadcast}
        onFrameHeightChange={handleFrameHeightChange}
        {...(initialFrameHeight !== undefined ? { initialFrameHeight } : {})}
      />
    </div>
  );
}

export function VisualizeWidget(props: {
  view: VisualizeWidgetView;
  playback?: 'auto' | 'instant';
  deferRuntimeBoot?: boolean;
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  // 위젯 발 도구 호출 — 부모(컨트롤러)가 신뢰 threadId/workingDirectory를
  // 주입해 run.tool로 번역한다.
  onWidgetToolRequest?: WidgetToolRequestHandler;
}) {
  const {
    view,
    playback = 'auto',
    deferRuntimeBoot = false,
    onWidgetPrompt,
    onWidgetToolRequest,
  } = props;
  const renderRuntime = useVisualizeRuntimeBoot(!deferRuntimeBoot);
  const streamKey = buildVisualizeStreamKey(view);
  // 마운트 시점에 이미 재생된 내용인지 고정 — 마운트 중에는 값이 바뀌지
  // 않아 iframe이 다시 로드되지 않고, 언마운트 시 재생 완료로 기록된다.
  const instant = useMemo(
    () => playback === 'instant' || playedVisualizeStreams.has(streamKey),
    [playback, streamKey],
  );
  useEffect(() => {
    if (activeVisualizeStreamFrame?.streamKey === streamKey) {
      activeVisualizeStreamFrame = null;
    }
    return () => {
      playedVisualizeStreams.add(streamKey);
    };
  }, [streamKey]);
  // view 객체 identity가 아니라 내용 기준으로 고정 — 트랜스크립트가 다시
  // 그려져도 위젯 문서 빌드가 반복되지 않는다
  const runtimePayload = useMemo(
    () =>
      buildHtmlArtifactRuntimePayload(
        buildVisualizeWidgetDocument(
          {
            mode: view.mode,
            code: view.code,
            title: view.title,
          },
          { instant },
        ),
      ),
    [view.code, view.mode, view.title, instant],
  );
  const sourceRef = useMemo(
    () =>
      buildCanonicalArtifactSourceRef({
        workingDirectory: '',
        threadId: null,
        runId: null,
        filePath: null,
      }),
    [],
  );
  const handleAgentPromptRequest = useCallback(
    (intent: { text: string }) => {
      void onWidgetPrompt?.(intent.text);
    },
    [onWidgetPrompt],
  );
  const initialFrameHeight =
    visualizeFrameHeights.get(streamKey) ??
    (activeVisualizeStreamFrame?.streamKey === streamKey
      ? activeVisualizeStreamFrame.height
      : undefined);
  const handleFrameHeightChange = useCallback(
    (height: number) => {
      visualizeFrameHeights.set(streamKey, height);
    },
    [streamKey],
  );

  if (!renderRuntime) {
    return (
      <VisualizeRuntimePlaceholder
        {...(initialFrameHeight !== undefined ? { initialFrameHeight } : {})}
      />
    );
  }

  return (
    <div className="visualize-widget">
      <ArtifactRuntimeFrame
        renderer="html5"
        title={view.title ?? 'visualize widget'}
        sandbox="allow-scripts allow-forms allow-same-origin"
        runtimePayload={runtimePayload}
        sourceRef={sourceRef}
        variant="inline"
        onFrameHeightChange={handleFrameHeightChange}
        {...(initialFrameHeight !== undefined ? { initialFrameHeight } : {})}
        {...(onWidgetPrompt !== undefined
          ? {
              onAgentPromptRequest: handleAgentPromptRequest,
              // 위젯은 활성 run 존재 여부를 모른다 — interject 의도도 같은
              // 전송 경로로 올리면 실행 중일 때는 스티어로, 아닐 때는 새
              // 턴으로 합류한다 (컨트롤러 sendPrompt의 기존 분기).
              onAgentInterjectRequest: handleAgentPromptRequest,
            }
          : {})}
        {...(onWidgetToolRequest !== undefined
          ? { onAgentToolRequest: onWidgetToolRequest }
          : {})}
      />
    </div>
  );
}
