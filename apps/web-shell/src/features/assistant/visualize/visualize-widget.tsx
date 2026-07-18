import { useCallback, useEffect, useMemo } from 'react';

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

// 실데이터 스트리밍이 끝까지 그린 내용을 재생 완료로 표시한다 — 완성본
// 위젯이 클라이언트측 점진 렌더를 반복하지 않는다.
export function markVisualizeStreamPlayed(view: {
  mode: 'svg' | 'html';
  code: string;
}): void {
  playedVisualizeStreams.add(`${view.mode}::${view.code}`);
}

// 실데이터 토큰 스트리밍 위젯 — tool_call_delta로 누적되는 인자 텍스트에서
// code 프리픽스를 뽑아, 고정 수신 문서에 postMessage로 밀어 넣는다.
// 프레임 문서는 제목이 바뀌지 않는 한 리로드되지 않는다.
export function VisualizeStreamingWidget(props: { argsText: string }) {
  const view = readVisualizeStreamViewFromArgsText(props.argsText);
  const title = view?.title ?? null;
  const runtimePayload = useMemo(
    () =>
      buildHtmlArtifactRuntimePayload(
        buildVisualizeWidgetStreamDocument({ title }),
      ),
    [title],
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
      />
    </div>
  );
}

export function VisualizeWidget(props: {
  view: VisualizeWidgetView;
  onWidgetPrompt?: (prompt: string) => Promise<void> | void;
  // 위젯 발 도구 호출 — 부모(컨트롤러)가 신뢰 threadId/workingDirectory를
  // 주입해 run.tool로 번역한다.
  onWidgetToolRequest?: WidgetToolRequestHandler;
}) {
  const { view, onWidgetPrompt, onWidgetToolRequest } = props;
  const streamKey = `${view.mode}::${view.code}`;
  // 마운트 시점에 이미 재생된 내용인지 고정 — 마운트 중에는 값이 바뀌지
  // 않아 iframe이 다시 로드되지 않고, 언마운트 시 재생 완료로 기록된다.
  const instant = useMemo(
    () => playedVisualizeStreams.has(streamKey),
    [streamKey],
  );
  useEffect(() => {
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

  return (
    <div className="visualize-widget">
      <ArtifactRuntimeFrame
        renderer="html5"
        title={view.title ?? 'visualize widget'}
        sandbox="allow-scripts allow-forms allow-same-origin"
        runtimePayload={runtimePayload}
        sourceRef={sourceRef}
        variant="inline"
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
