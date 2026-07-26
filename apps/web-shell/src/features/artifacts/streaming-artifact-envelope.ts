import {
  ARTIFACT_END_MARKER,
  ARTIFACT_START_PREFIX,
  isArtifactRenderer,
  type ArtifactRenderer,
} from '@geulbat/protocol/artifacts';
import { isRecord } from '../../lib/json.js';

// 생성 중(artifact_stream_delta 누적) 아티팩트 봉투의 부분 텍스트를 파싱한다.
// 헤더 줄(<!-- GEULBAT_ARTIFACT {json} -->)이 아직 다 안 왔으면 null —
// 중앙 창은 헤더가 완성된 순간부터 코드 스트림을 그리기 시작한다.
interface StreamingArtifactEnvelope {
  renderer: ArtifactRenderer;
  title: string | null;
  payloadSoFar: string;
}

const HEADER_CLOSE = '-->';

export function parseStreamingArtifactEnvelope(
  text: string,
): StreamingArtifactEnvelope | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(ARTIFACT_START_PREFIX)) {
    return null;
  }
  const headerClose = trimmed.indexOf(
    HEADER_CLOSE,
    ARTIFACT_START_PREFIX.length,
  );
  if (headerClose === -1) {
    return null;
  }
  const headerJson = trimmed
    .slice(ARTIFACT_START_PREFIX.length, headerClose)
    .trim();
  let renderer: ArtifactRenderer = 'markdown';
  let title: string | null = null;
  try {
    const parsed: unknown = JSON.parse(headerJson);
    if (!isRecord(parsed)) {
      return null;
    }
    if (isArtifactRenderer(parsed.renderer)) {
      renderer = parsed.renderer;
    }
    if (typeof parsed.title === 'string' && parsed.title.trim() !== '') {
      title = parsed.title;
    }
  } catch {
    return null;
  }

  let payloadSoFar = trimmed.slice(headerClose + HEADER_CLOSE.length);
  if (payloadSoFar.startsWith('\n')) {
    payloadSoFar = payloadSoFar.slice(1);
  }
  // 종료 마커가 이미 왔으면(커밋 직전) 마커부터는 payload가 아니다
  const endIndex = payloadSoFar.lastIndexOf(ARTIFACT_END_MARKER);
  if (endIndex !== -1) {
    payloadSoFar = payloadSoFar.slice(0, endIndex);
  }
  return { renderer, title, payloadSoFar };
}
