import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';

import { buildArtifactRewriteRunDraft } from '../features/artifacts/artifact-run-drafts.js';
import { parseStreamingArtifactEnvelope } from '../features/artifacts/streaming-artifact-envelope.js';
import { brandThreadId } from '../lib/id-brand-helpers.js';
import { commitArtifactDraftVersion } from '../lib/api/threads.js';

/**
 * 중앙 아티팩트 표면의 수명 — 무엇이 열려 있고, 어느 버전이며, 렌더인지 코드인지.
 *
 * HomeShell에서 분리했다(2026-07-25). 셸 레이아웃·세션 탐색·첨부 업로드와 달리
 * 이 묶음은 "표면에 뜬 아티팩트"라는 하나의 상태를 4개 state·6개 효과·5개
 * 핸들러가 함께 굴리는 단일 수명 주기라, 셸 본문에 섞여 있으면 어느 효과가
 * 어느 상태를 되돌리는지 추적하기 어려웠다.
 *
 * 셸 쪽으로 나가는 유일한 부작용은 중앙 표면을 편집기로 끌어오는 것이라,
 * 그것만 requestEditorSurface로 받는다 — 훅은 셸을 알지 못한다.
 */
interface ArtifactSurfaceState {
  centerArtifact: ThreadArtifactVersion | null;
  artifactSurfaceMode: 'render' | 'code' | null;
  artifactStreamToken: number | null;
  artifactExpanded: boolean;
  versionHistory: ThreadArtifactVersion[];
  setArtifactSurfaceMode: (mode: 'render' | 'code' | null) => void;
  setArtifactExpanded: Dispatch<SetStateAction<boolean>>;
  closeArtifact: () => void;
  openArtifact: (artifact: ThreadArtifactVersion) => void;
  onStreamRevealDone: () => void;
  onRewrite: () => void;
  onSelectVersion: (artifact: ThreadArtifactVersion) => void;
  onCommitDraft: (draftPayload: string) => Promise<void>;
}

export function useArtifactSurface(args: {
  selectedThreadId: string | null;
  selectedFilePath: string | null;
  /** 실행 중 도착한 커밋본 — 있으면 표면이 그 버전으로 이어받는다. */
  activeArtifact: ThreadArtifactVersion | null;
  /** 생성 중 봉투 라이브 텍스트 — 헤더가 완성되는 순간부터 코드 모드로 그린다. */
  streamingArtifactText: string;
  artifacts: ThreadArtifactVersion[];
  startArtifactRun: (
    request: ReturnType<typeof buildArtifactRewriteRunDraft>,
  ) => Promise<void> | void;
  upsertThreadArtifactVersion: (artifact: ThreadArtifactVersion) => void;
  requestEditorSurface: () => void;
}): ArtifactSurfaceState {
  // 중앙 아티팩트 모드 — 아티팩트는 채팅 컬럼 인라인이 아니라 중앙 넓은
  // 화면에서 열린다. 채팅에는 참조 칩만 남고, 열린 아티팩트는 일회성
  // 패널이 아니라 편집기 헤더 토글의 상주 모드로 남는다 (스레드 전환 시 해제).
  const [centerArtifact, setCenterArtifact] =
    useState<ThreadArtifactVersion | null>(null);
  // render = 아티팩트 렌더, code = 원문 코드(코드 뷰어 필), null = 파일 편집기
  const [artifactSurfaceMode, setArtifactSurfaceMode] = useState<
    'render' | 'code' | null
  >(null);
  // 실행 중 도착한 아티팩트는 원문 모드에서 타이핑되듯 스트리밍으로 시작한다
  // — null이면(참조 칩 클릭 등) 즉시 표시, 값이 바뀔 때마다 새 스트리밍.
  const [artifactStreamToken, setArtifactStreamToken] = useState<number | null>(
    null,
  );
  // 확대 — 채팅 컬럼을 밀어내고 [탐색기 | 아티팩트]로 커진다.
  const [artifactExpanded, setArtifactExpanded] = useState(false);

  const {
    selectedThreadId,
    selectedFilePath,
    activeArtifact,
    streamingArtifactText,
    artifacts,
    startArtifactRun,
    upsertThreadArtifactVersion,
    requestEditorSurface,
  } = args;

  // 채팅 칩 클릭 → 에디터 표면의 아티팩트 렌더 모드 (즉시 표시)
  const openArtifact = useCallback(
    (artifact: ThreadArtifactVersion) => {
      setCenterArtifact(artifact);
      setArtifactSurfaceMode('render');
      setArtifactStreamToken(null);
      requestEditorSurface();
    },
    [requestEditorSurface],
  );

  // 생성 중 라이브 스트림 — artifact_stream_delta가 흘려주는 봉투 텍스트를
  // 헤더가 완성된 순간부터 중앙 창 코드 모드에 실시간으로 그린다. 커밋되면
  // 아래 activeArtifact 효과가 커밋본 렌더로 이어받는다.
  const liveArtifactStreamed = useRef(false);
  useEffect(() => {
    if (streamingArtifactText === '') {
      return;
    }
    const envelope = parseStreamingArtifactEnvelope(streamingArtifactText);
    if (envelope === null) {
      return;
    }
    liveArtifactStreamed.current = true;
    setCenterArtifact({
      artifactId: 'live-streaming',
      version: 0,
      parentVersion: null,
      baseVersion: null,
      renderer: envelope.renderer,
      payload: envelope.payloadSoFar,
      digest: '',
      contentHash: '',
      createdAt: new Date().toISOString(),
      createdByRunId: 'live-streaming',
      previewValidation: { ok: true },
      title: envelope.title,
      persistenceEpoch: 0,
      sourceRef: null,
    });
    setArtifactSurfaceMode('code');
    setArtifactStreamToken(null);
    requestEditorSurface();
  }, [streamingArtifactText, requestEditorSurface]);

  // 실행 중 도착한 아티팩트 — 라이브 스트림을 봤다면 곧장 렌더로 전환하고,
  // (스트림이 없던 경로만) 코드 뷰어에서 작성 과정을 재생한 뒤 렌더로 넘긴다.
  useEffect(() => {
    if (activeArtifact !== null) {
      setCenterArtifact(activeArtifact);
      if (liveArtifactStreamed.current) {
        liveArtifactStreamed.current = false;
        setArtifactSurfaceMode('render');
        setArtifactStreamToken(null);
      } else {
        setArtifactSurfaceMode('code');
        setArtifactStreamToken((prev) => (prev ?? 0) + 1);
      }
    }
  }, [activeArtifact]);

  const onStreamRevealDone = useCallback(() => {
    setArtifactSurfaceMode((prev) => (prev === 'code' ? 'render' : prev));
  }, []);

  // 아티팩트 모드가 내려가면 확대 상태도 함께 풀린다
  useEffect(() => {
    if (artifactSurfaceMode === null) {
      setArtifactExpanded(false);
    }
  }, [artifactSurfaceMode]);

  // 스레드를 옮기면 이전 스레드의 아티팩트 모드는 새 스레드가 그려지기 전에
  // 해제한다. paint 뒤에 지우면 먼저 보인 새 스레드의 참조 칩 클릭까지
  // 뒤늦은 reset이 덮을 수 있다.
  useLayoutEffect(() => {
    setCenterArtifact(null);
    setArtifactSurfaceMode(null);
    setArtifactStreamToken(null);
  }, [selectedThreadId]);

  // 파일을 열면(트리/탭) 아티팩트는 표면에서 내려가고 파일이 보인다 —
  // 헤더의 아티팩트 필은 남아 있어 언제든 되돌아올 수 있다.
  useEffect(() => {
    setArtifactSurfaceMode(null);
  }, [selectedFilePath]);

  // 버전 스테퍼 데이터 — 같은 artifactId의 버전들을 오름차순으로 모은다.
  // centerArtifact가 목록에 아직 없으면(스트리밍 직후 등) 함께 합친다.
  const versionHistory = useMemo(() => {
    if (centerArtifact === null) {
      return [];
    }
    const byVersion = new Map<number, ThreadArtifactVersion>();
    for (const candidate of artifacts) {
      if (candidate.artifactId === centerArtifact.artifactId) {
        byVersion.set(candidate.version, candidate);
      }
    }
    byVersion.set(centerArtifact.version, centerArtifact);
    return [...byVersion.values()].sort((left, right) => {
      return left.version - right.version;
    });
  }, [centerArtifact, artifacts]);

  // draft → 버전 커밋 — 같은 artifactId의 latestVersion+1로 append하고,
  // 성공하면 로컬 아티팩트 목록과 표면을 새 버전으로 갱신한다. 409는
  // 에디터 표면이 메시지로 보여주도록 다시 던진다.
  const onCommitDraft = useCallback(
    async (draftPayload: string) => {
      if (centerArtifact === null || selectedThreadId === null) {
        return;
      }
      const baseVersion =
        versionHistory.at(-1)?.version ?? centerArtifact.version;
      const committed = await commitArtifactDraftVersion(
        selectedThreadId,
        centerArtifact.artifactId,
        { baseVersion, payload: draftPayload },
      );
      upsertThreadArtifactVersion(committed.artifact);
      setCenterArtifact(committed.artifact);
      setArtifactStreamToken(null);
    },
    [
      centerArtifact,
      versionHistory,
      selectedThreadId,
      upsertThreadArtifactVersion,
    ],
  );

  // 스테퍼로 버전 이동 — 표면 아티팩트만 바꾸고 모드는 유지한다
  const onSelectVersion = useCallback((artifact: ThreadArtifactVersion) => {
    setCenterArtifact(artifact);
    setArtifactStreamToken(null);
  }, []);

  // ♻ 다시 만들기 — 부분 수정/전체 재작성 라우팅은 모델이 스스로 판단
  const onRewrite = useCallback(() => {
    if (centerArtifact === null || selectedThreadId === null) {
      return;
    }
    // 누르는 순간 코드 화면으로 자동 진입 — 새 버전 스트림이 도착하면
    // 라이브로 덮이고, 커밋되면 렌더(인터프리팅) 화면으로 자동 복귀한다.
    setArtifactSurfaceMode('code');
    setArtifactStreamToken(null);
    requestEditorSurface();
    void startArtifactRun(
      buildArtifactRewriteRunDraft({
        artifact: centerArtifact,
        threadId: brandThreadId(selectedThreadId),
      }),
    );
  }, [
    centerArtifact,
    selectedThreadId,
    requestEditorSurface,
    startArtifactRun,
  ]);

  const closeArtifact = useCallback(() => {
    setArtifactSurfaceMode(null);
    setCenterArtifact(null);
  }, []);

  return {
    centerArtifact,
    artifactSurfaceMode,
    artifactStreamToken,
    artifactExpanded,
    versionHistory,
    setArtifactSurfaceMode,
    setArtifactExpanded,
    closeArtifact,
    openArtifact,
    onStreamRevealDone,
    onRewrite,
    onSelectVersion,
    onCommitDraft,
  };
}
