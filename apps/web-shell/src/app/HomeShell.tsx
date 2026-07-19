import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadArtifactVersion } from '@geulbat/protocol/artifacts';

import { ComputerTree } from '../features/computer-tree/ComputerTree.js';
import { ThreadList } from '../features/thread-list/ThreadList.js';
import { ThreadDeleteConfirm } from '../features/thread-list/ThreadDeleteConfirm.js';
import { Editor } from '../features/editor/Editor.js';
import { Assistant } from '../features/assistant/Assistant.js';
import { ArtifactEditorSurface } from '../features/assistant/artifact-pane/artifact-editor-surface.js';
import { buildArtifactRewriteRunDraft } from '../features/artifacts/artifact-run-drafts.js';
import { brandThreadId } from '../lib/id-brand-helpers.js';
import { Approvals } from '../features/approvals/Approvals.js';
import { ProviderAuthCard } from '../features/provider-auth/ProviderAuthCard.js';
import {
  ExtensionHub,
  type ExtensionCreatorKind,
} from '../features/plugins/ExtensionHub.js';
import type {
  AssistantComposerDraftRequest,
  ComposerAttachment,
} from '../features/assistant/AssistantComposer.js';
import {
  deleteRunAttachmentBlob,
  uploadRunAttachmentBlob,
} from '../lib/api/files.js';
import {
  commitArtifactDraftVersion,
  threadAttachmentUrl,
} from '../lib/api/threads.js';
import { getErrorMessage } from '../lib/error-message.js';
import {
  isShellCenterHidden,
  type HomeShellProps,
  type ShellLayoutModeId,
} from './home-shell.js';
import { useHomeShell } from './use-home-shell.js';
import {
  useDaemonConnection,
  type DaemonConnectionState,
} from './use-daemon-connection.js';
import { usePanelWidths } from './use-panel-widths.js';
import { HomeCenterSurface, HomeSettings } from './HomeSettings.js';

const DAEMON_STATE_LABEL: Record<DaemonConnectionState, string> = {
  connected: '데몬 연결됨',
  reconnecting: '데몬에 다시 연결하는 중…',
  disconnected: '데몬 연결 끊김',
};

type RightPaneTab = 'chat' | 'sessions';
type CenterSurface = 'editor' | 'extensions' | 'settings';

// 레이아웃 모드 — ▥ 버튼에 마우스를 올리면 미니 다이어그램 + 라벨 메뉴로
// 고른다.
const SHELL_LAYOUT_MODES = [
  { id: 'default', label: '기본 배치', hint: '탐색기 · 에디터 · 채팅' },
  { id: 'no-tree', label: '탐색기 접기', hint: '에디터 · 채팅' },
  { id: 'no-chat', label: '채팅 접기', hint: '탐색기 · 에디터' },
  { id: 'editor-only', label: '에디터만', hint: '에디터 전체 화면' },
  { id: 'chat-center', label: '채팅 가운데', hint: '탐색기 · 채팅' },
  { id: 'chat-only', label: '채팅만', hint: '채팅 전체 화면' },
] as const satisfies ReadonlyArray<{
  id: ShellLayoutModeId;
  label: string;
  hint: string;
}>;

// 미니 레이아웃 다이어그램 — 왼쪽 좁은 기둥이 탐색기, 빈 공간이 에디터,
// 진하게 칠해진 영역이 채팅이다.
function LayoutGlyph(props: { mode: ShellLayoutModeId }) {
  const { mode } = props;
  const showTree =
    mode === 'default' || mode === 'no-chat' || mode === 'chat-center';
  const showChat = mode !== 'no-chat' && mode !== 'editor-only';
  const chatX = mode === 'chat-only' ? 3 : mode === 'chat-center' ? 9.5 : 16.5;
  const chatWidth =
    mode === 'chat-only' ? 20 : mode === 'chat-center' ? 13.5 : 6.5;
  return (
    <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden>
      <rect
        x="1"
        y="1"
        width="24"
        height="16"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {showTree ? (
        <rect
          x="3"
          y="3"
          width="4.5"
          height="12"
          rx="1"
          fill="currentColor"
          fillOpacity="0.3"
        />
      ) : null}
      {showChat ? (
        <rect
          x={chatX}
          y="3"
          width={chatWidth}
          height="12"
          rx="1"
          fill="currentColor"
          fillOpacity="0.7"
        />
      ) : null}
    </svg>
  );
}

// 레이아웃 선택 팝오버 — 호버/포커스에 뜨고, 클릭 즉시 적용된다.
function ShellLayoutMenu(props: {
  mode: ShellLayoutModeId;
  onSelect: (mode: ShellLayoutModeId) => void;
  buttonClassName: string;
}) {
  const active =
    SHELL_LAYOUT_MODES.find((mode) => mode.id === props.mode) ??
    SHELL_LAYOUT_MODES[0];
  return (
    <span className="layout-menu-anchor">
      <button
        type="button"
        className={props.buttonClassName}
        title={`레이아웃 — 지금: ${active.label}`}
        aria-label="레이아웃 선택"
        aria-haspopup="true"
      >
        <LayoutGlyph mode={active.id} />
      </button>
      <span className="layout-menu" role="menu" aria-label="레이아웃 모드">
        {SHELL_LAYOUT_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            role="menuitemradio"
            aria-checked={mode.id === props.mode}
            className={`layout-menu-item${mode.id === props.mode ? ' active' : ''}`}
            title={mode.hint}
            onClick={(event) => {
              // 곧 inert가 될 패널 안에서 포커스가 갇히지 않도록 먼저 놓는다
              event.currentTarget.blur();
              props.onSelect(mode.id);
            }}
          >
            <LayoutGlyph mode={mode.id} />
            <span className="layout-menu-item-copy">
              <span className="layout-menu-item-label">{mode.label}</span>
              <span className="layout-menu-item-hint">{mode.hint}</span>
            </span>
          </button>
        ))}
      </span>
    </span>
  );
}

export function HomeShell(props: HomeShellProps) {
  const {
    leftPanelView,
    centerPanelView,
    rightPanelView,
    workingDirectory,
    chooseWorkingDirectory,
    upsertThreadArtifactVersion,
  } = useHomeShell(props);
  const daemon = useDaemonConnection();
  const { leftWidth, rightWidth, startResize } = usePanelWidths();
  const [layoutMode, setLayoutMode] = useState<ShellLayoutModeId>('default');
  const [rightTab, setRightTab] = useState<RightPaneTab>('chat');
  const [centerSurface, setCenterSurface] = useState<CenterSurface>('editor');
  const [composerDraftRequest, setComposerDraftRequest] =
    useState<AssistantComposerDraftRequest | null>(null);
  const composerDraftSequence = useRef(0);
  // 중앙 아티팩트 모드 — 아티팩트는 채팅 컬럼 인라인이 아니라 중앙 넓은
  // 화면에서 열린다. 채팅에는 참조 칩만 남고, 열린 아티팩트는 일회성
  // 패널이 아니라 편집기 헤더 토글(리치 에디터 | 아티팩트 | 코드 뷰어)의
  // 상주 모드로 남는다 (스레드 전환 시 해제).
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
  // 확대 — 채팅 컬럼을 밀어내고 [탐색기 | 아티팩트]로 커진다. 축소하면
  // 원래 레이아웃으로 복귀.
  const [artifactExpanded, setArtifactExpanded] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const extensionsTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreCenterTriggerFocus = useRef<Exclude<
    CenterSurface,
    'editor'
  > | null>(null);
  // 채팅 모드에서는 중앙(에디터)이 내려가고 채팅이 그 자리를 차지한다
  const centerHidden = isShellCenterHidden(
    layoutMode,
    artifactSurfaceMode !== null && centerArtifact !== null,
  );
  const leftCollapsed =
    layoutMode === 'no-tree' ||
    layoutMode === 'editor-only' ||
    layoutMode === 'chat-only';
  const rightCollapsed =
    !centerHidden &&
    (layoutMode === 'no-chat' ||
      layoutMode === 'editor-only' ||
      artifactExpanded);

  const isDaemonReadOnly = daemon.state === 'disconnected';

  const startCreator = useCallback((kind: ExtensionCreatorKind) => {
    composerDraftSequence.current += 1;
    setComposerDraftRequest({
      requestId: composerDraftSequence.current,
      text: kind === 'plugin' ? '@plugin_creator' : '@skill_creator',
    });
    setRightTab('chat');
    setCenterSurface('editor');
    setArtifactExpanded(false);
    setLayoutMode((current) =>
      current === 'no-chat' || current === 'editor-only' ? 'default' : current,
    );
  }, []);

  useEffect(() => {
    if (centerSurface === 'editor' && restoreCenterTriggerFocus.current) {
      const target = restoreCenterTriggerFocus.current;
      restoreCenterTriggerFocus.current = null;
      if (target === 'extensions') {
        extensionsTriggerRef.current?.focus();
      } else {
        settingsTriggerRef.current?.focus();
      }
    }
  }, [centerSurface]);

  // + 메뉴의 파일/이미지 업로드 — 어시스턴트 첨부. 바이트를 ref로 올려두고
  // 전송 시 run 요청에 실린다(모델이 이미지/파일 내용을 직접 본다).
  const [uploadError, setUploadError] = useState<string | null>(null);
  const handleUploadFiles = useCallback(
    async (files: FileList): Promise<ComposerAttachment[]> => {
      setUploadError(null);
      const results = await Promise.all(
        Array.from(files, async (file) => {
          try {
            const contentRef = await uploadRunAttachmentBlob(file);
            return {
              attachment: {
                name: file.name,
                contentRef,
                ...(file.type ? { mimeType: file.type } : {}),
                // 이미지는 전송 전 미리보기 썸네일을 칩에 보여준다
                ...(file.type.startsWith('image/')
                  ? { previewUrl: URL.createObjectURL(file) }
                  : {}),
              } satisfies ComposerAttachment,
            };
          } catch (error: unknown) {
            return { failure: `${file.name}: ${getErrorMessage(error)}` };
          }
        }),
      );
      const uploaded: ComposerAttachment[] = [];
      const failures: string[] = [];
      for (const result of results) {
        if ('attachment' in result) {
          uploaded.push(result.attachment);
        } else {
          failures.push(result.failure);
        }
      }
      if (failures.length > 0) {
        setUploadError(`업로드 실패 — ${failures.join(' · ')}`);
      }
      return uploaded;
    },
    [],
  );
  const handleDiscardUploadedAttachment = useCallback((contentRef: string) => {
    void deleteRunAttachmentBlob(contentRef).catch(() => undefined);
  }, []);
  // 지난 메시지의 이미지 첨부 렌더링 — 선택된 스레드의 첨부 스토어에서 서빙
  const selectedThreadId = leftPanelView.threadList.selectedThreadId;

  // 채팅 칩 클릭 → 에디터 표면의 아티팩트 렌더 모드 (즉시 표시)
  const handleOpenArtifact = useCallback((artifact: ThreadArtifactVersion) => {
    setCenterArtifact(artifact);
    setArtifactSurfaceMode('render');
    setArtifactStreamToken(null);
    setCenterSurface('editor');
  }, []);
  // 실행 중 도착한 아티팩트 — 코드 뷰어에서 코드가 작성되는 과정을 먼저
  // 보여주고(스트리밍), 끝나면 렌더 모드로 자동 전환한다.
  const activeArtifact = rightPanelView.assistant.activeArtifact ?? null;
  useEffect(() => {
    if (activeArtifact !== null) {
      setCenterArtifact(activeArtifact);
      setArtifactSurfaceMode('code');
      setArtifactStreamToken((prev) => (prev ?? 0) + 1);
    }
  }, [activeArtifact]);
  const handleArtifactStreamRevealDone = useCallback(() => {
    setArtifactSurfaceMode((prev) => (prev === 'code' ? 'render' : prev));
  }, []);
  // 아티팩트 모드가 내려가면 확대 상태도 함께 풀린다
  useEffect(() => {
    if (artifactSurfaceMode === null) {
      setArtifactExpanded(false);
    }
  }, [artifactSurfaceMode]);
  // 스레드를 옮기면 이전 스레드의 아티팩트 모드는 해제된다
  useEffect(() => {
    setCenterArtifact(null);
    setArtifactSurfaceMode(null);
    setArtifactStreamToken(null);
  }, [selectedThreadId]);
  // 파일을 열면(트리/탭) 아티팩트는 표면에서 내려가고 파일이 보인다 —
  // 헤더의 아티팩트 필은 남아 있어 언제든 되돌아올 수 있다.
  const selectedFilePath = centerPanelView.editor.filePath;
  useEffect(() => {
    setArtifactSurfaceMode(null);
  }, [selectedFilePath]);
  // 버전 스테퍼 데이터 — 같은 artifactId의 버전들을 오름차순으로 모은다.
  // centerArtifact가 목록에 아직 없으면(스트리밍 직후 등) 함께 합친다.
  const centerArtifactVersionHistory = useMemo(() => {
    if (centerArtifact === null) {
      return [];
    }
    const byVersion = new Map<number, ThreadArtifactVersion>();
    for (const candidate of rightPanelView.assistant.artifacts) {
      if (candidate.artifactId === centerArtifact.artifactId) {
        byVersion.set(candidate.version, candidate);
      }
    }
    byVersion.set(centerArtifact.version, centerArtifact);
    return [...byVersion.values()].sort((left, right) => {
      return left.version - right.version;
    });
  }, [centerArtifact, rightPanelView.assistant.artifacts]);

  // draft → 버전 커밋 — 같은 artifactId의 latestVersion+1로 append하고,
  // 성공하면 로컬 아티팩트 목록과 표면을 새 버전으로 갱신한다. 409는
  // 에디터 표면이 메시지로 보여주도록 다시 던진다.
  const handleCommitArtifactDraft = useCallback(
    async (draftPayload: string) => {
      if (centerArtifact === null || selectedThreadId === null) {
        return;
      }
      const baseVersion =
        centerArtifactVersionHistory.at(-1)?.version ?? centerArtifact.version;
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
      centerArtifactVersionHistory,
      selectedThreadId,
      upsertThreadArtifactVersion,
    ],
  );

  // 스테퍼로 버전 이동 — 표면 아티팩트만 바꾸고 모드는 유지한다
  const handleSelectArtifactVersion = useCallback(
    (artifact: ThreadArtifactVersion) => {
      setCenterArtifact(artifact);
      setArtifactStreamToken(null);
    },
    [],
  );

  // ♻ 다시 만들기 — 부분 수정/전체 재작성 라우팅은 모델이 스스로 판단
  const handleArtifactRewrite = useCallback(() => {
    if (centerArtifact === null || selectedThreadId === null) {
      return;
    }
    void rightPanelView.assistant.onStartArtifactRun(
      buildArtifactRewriteRunDraft({
        artifact: centerArtifact,
        threadId: brandThreadId(selectedThreadId),
      }),
    );
  }, [centerArtifact, selectedThreadId, rightPanelView.assistant]);
  const attachmentImageUrl = useCallback(
    (attachmentId: string): string | null =>
      selectedThreadId
        ? threadAttachmentUrl(selectedThreadId, attachmentId)
        : null,
    [selectedThreadId],
  );

  const gridColumns = [
    leftCollapsed ? '0px' : `${leftWidth}px`,
    leftCollapsed ? '0px' : '6px',
    centerHidden ? '0px' : '1fr',
    centerHidden || rightCollapsed ? '0px' : '6px',
    centerHidden ? '1fr' : rightCollapsed ? '0px' : `${rightWidth}px`,
  ].join(' ');

  return (
    <div className="shell-root">
      {isDaemonReadOnly ? (
        <div className="disconnect-banner" role="alert" aria-live="assertive">
          <span>데몬과 연결이 끊어졌습니다. 편집이 일시 중단됩니다.</span>
          <button type="button" onClick={daemon.reconnect}>
            재연결 시도
          </button>
        </div>
      ) : null}
      {uploadError !== null ? (
        <div className="disconnect-banner" role="alert" aria-live="assertive">
          <span>{uploadError}</span>
          <button type="button" onClick={() => setUploadError(null)}>
            닫기
          </button>
        </div>
      ) : null}
      <div
        className={`shell layout-${layoutMode}`}
        style={{ gridTemplateColumns: gridColumns }}
      >
        {/* ─── 좌측 — 파일 관리 (§2.2) ─── */}
        <aside
          className={`rail${leftCollapsed ? ' collapsed' : ''}`}
          aria-label="파일 관리"
          aria-hidden={leftCollapsed}
          inert={leftCollapsed}
        >
          <div className="rail-header">
            <span className="rail-brand">글밭</span>
          </div>
          <div className="rail-scroll">
            <ComputerTree {...leftPanelView.computerTree} />
          </div>
          <div className="rail-bottom">
            <div className="rail-bottom-actions">
              <button
                ref={extensionsTriggerRef}
                type="button"
                className={`settings-entry${
                  centerSurface === 'extensions' ? ' active' : ''
                }`}
                aria-pressed={centerSurface === 'extensions'}
                onClick={() =>
                  setCenterSurface((current) =>
                    current === 'extensions' ? 'editor' : 'extensions',
                  )
                }
              >
                <span className="settings-entry-icon" aria-hidden="true">
                  ◇
                </span>
                <span>플러그인</span>
              </button>
              <button
                ref={settingsTriggerRef}
                type="button"
                className={`settings-entry${
                  centerSurface === 'settings' ? ' active' : ''
                }`}
                aria-pressed={centerSurface === 'settings'}
                onClick={() =>
                  setCenterSurface((current) =>
                    current === 'settings' ? 'editor' : 'settings',
                  )
                }
              >
                <span className="settings-entry-icon" aria-hidden="true">
                  ⚙
                </span>
                <span>설정</span>
              </button>
            </div>
          </div>
        </aside>

        <div
          className="shell-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="파일 패널 폭 조절"
          onPointerDown={(event) => startResize('left', event)}
        />

        {/* ─── 중앙 — 편집기 (§2.3) ─── */}
        <main
          aria-hidden={centerHidden}
          inert={centerHidden}
          className={`manuscript${
            centerSurface === 'settings'
              ? ' settings-open'
              : centerSurface === 'extensions'
                ? ' extensions-open'
                : ''
          }${artifactExpanded ? ' artifact-expanded' : ''}${centerHidden ? ' center-hidden' : ''}`}
          aria-label={
            centerSurface === 'settings'
              ? '설정'
              : centerSurface === 'extensions'
                ? '플러그인과 스킬'
                : artifactSurfaceMode !== null && centerArtifact !== null
                  ? '아티팩트'
                  : '편집기'
          }
        >
          {rightCollapsed ? (
            <span className="panel-reopen right">
              <ShellLayoutMenu
                mode={layoutMode}
                onSelect={setLayoutMode}
                buttonClassName="panel-reopen-button"
              />
            </span>
          ) : null}
          <HomeCenterSurface
            settingsOpen={centerSurface === 'settings'}
            extensionsOpen={centerSurface === 'extensions'}
            editor={
              <Editor
                {...centerPanelView.editor}
                readOnly={isDaemonReadOnly || centerSurface !== 'editor'}
                {...(centerArtifact !== null
                  ? {
                      artifactPill: {
                        label: centerArtifact.title ?? '아티팩트',
                        active: artifactSurfaceMode !== null,
                        onOpen: () => setArtifactSurfaceMode('render'),
                        onExit: () => setArtifactSurfaceMode(null),
                      },
                      artifactSurface: (
                        <ArtifactEditorSurface
                          artifact={centerArtifact}
                          threadId={selectedThreadId}
                          isRunning={rightPanelView.assistant.isRunning}
                          mode={artifactSurfaceMode ?? 'render'}
                          onSelectMode={setArtifactSurfaceMode}
                          streamToken={artifactStreamToken}
                          onStreamRevealDone={handleArtifactStreamRevealDone}
                          onRewrite={handleArtifactRewrite}
                          expanded={artifactExpanded}
                          onToggleExpand={() =>
                            setArtifactExpanded((prev) => !prev)
                          }
                          versionHistory={centerArtifactVersionHistory}
                          onSelectVersion={handleSelectArtifactVersion}
                          onCommitDraft={handleCommitArtifactDraft}
                        />
                      ),
                    }
                  : {})}
              />
            }
            extensions={
              <ExtensionHub
                disabled={isDaemonReadOnly}
                onStartCreator={startCreator}
                onClose={() => {
                  restoreCenterTriggerFocus.current = 'extensions';
                  setCenterSurface('editor');
                }}
              />
            }
            settings={
              <HomeSettings
                mcpDisabled={isDaemonReadOnly}
                onClose={() => {
                  restoreCenterTriggerFocus.current = 'settings';
                  setCenterSurface('editor');
                }}
              />
            }
          />
        </main>

        <div
          className="shell-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="어시스턴트 폭 조절"
          onPointerDown={(event) => startResize('right', event)}
        />

        {/* ─── 우측 — 어시스턴트 (§2.4) ─── */}
        <aside
          className={`assistant-pane${rightCollapsed ? ' collapsed' : ''}`}
          aria-label="어시스턴트"
          aria-hidden={rightCollapsed}
          inert={rightCollapsed}
        >
          <div className="assistant-header">
            <div className="assistant-title">
              {/* 어시스턴트 앞 점이 데몬 연결 상태를 알린다 — 누르면 재연결 */}
              <button
                type="button"
                className={`assistant-title-dot ${daemon.state}`}
                onClick={daemon.reconnect}
                aria-label={`${DAEMON_STATE_LABEL[daemon.state]}. 다시 연결`}
                title={`${DAEMON_STATE_LABEL[daemon.state]} · 누르면 다시 연결을 시도합니다`}
              />
              <span>어시스턴트</span>
            </div>
            <div className="assistant-header-tabs" role="tablist">
              <button
                type="button"
                className="rail-icon-button"
                title="새 세션"
                aria-label="새 세션"
                onClick={() => {
                  leftPanelView.threadList.onNewSession();
                  setRightTab('chat');
                }}
              >
                +
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === 'chat'}
                className={`pref-toggle${rightTab === 'chat' ? ' active' : ''}`}
                onClick={() => setRightTab('chat')}
              >
                채팅
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rightTab === 'sessions'}
                className={`pref-toggle${rightTab === 'sessions' ? ' active' : ''}`}
                onClick={() => setRightTab('sessions')}
              >
                세션
              </button>
              <ShellLayoutMenu
                mode={layoutMode}
                onSelect={setLayoutMode}
                buttonClassName="rail-icon-button layout-cycle"
              />
            </div>
          </div>
          <div className="assistant-body">
            {rightTab === 'sessions' ? (
              <div className="sessions-pane">
                <ThreadList
                  {...leftPanelView.threadList}
                  onSelect={async (threadId) => {
                    await leftPanelView.threadList.onSelect(threadId);
                    setRightTab('chat');
                  }}
                />
                {leftPanelView.threadDeleteConfirm ? (
                  <ThreadDeleteConfirm {...leftPanelView.threadDeleteConfirm} />
                ) : null}
              </div>
            ) : (
              <>
                <details className="rail-tools">
                  <summary>AI 제공자 연결</summary>
                  <ProviderAuthCard {...rightPanelView.providerAuthCard} />
                </details>
                <Assistant
                  {...rightPanelView.assistant}
                  workingDirectory={workingDirectory}
                  browseStartPath={leftPanelView.computerTree.browseStartPath}
                  onChooseWorkingDirectory={chooseWorkingDirectory}
                  composerDraftRequest={composerDraftRequest}
                  onOpenArtifact={handleOpenArtifact}
                  onUploadFiles={handleUploadFiles}
                  onDiscardUploadedAttachment={handleDiscardUploadedAttachment}
                  attachmentImageUrl={attachmentImageUrl}
                  imageProviderConnected={{
                    grok_oauth:
                      props.providerAuthStatuses.grok_oauth?.ready === true,
                    openai_codex_direct:
                      props.providerAuthStatuses.openai_codex_direct?.ready ===
                      true,
                  }}
                  approvalPanel={
                    <Approvals {...rightPanelView.approvalPanel} />
                  }
                />
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
