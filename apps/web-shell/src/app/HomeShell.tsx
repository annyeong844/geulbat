import { useCallback, useEffect, useRef, useState } from 'react';

import { ComputerDirectoryPickerDialog } from '../lib/computer-directory-picker-dialog.js';
import { ComputerTree } from '../features/computer-tree/ComputerTree.js';
import { ThreadList } from '../features/thread-list/ThreadList.js';
import { ThreadDeleteConfirm } from '../features/thread-list/ThreadDeleteConfirm.js';
import { SessionManagerOverlay } from '../features/thread-list/SessionManagerOverlay.js';
import { Editor } from '../features/editor/Editor.js';
import {
  GitReviewSummaryTrigger,
  GitReviewSurface,
} from '../features/git-review/GitReviewSurface.js';
import { useGitReview } from '../features/git-review/use-git-review.js';
import { Assistant } from '../features/assistant/Assistant.js';
import { ArtifactEditorSurface } from '../features/assistant/artifact-pane/artifact-editor-surface.js';
import { Approvals } from '../features/approvals/Approvals.js';
import {
  ExtensionHub,
  type ExtensionCreatorKind,
  type ExtensionHubTab,
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
  renameThread,
  setThreadPinned,
  threadAttachmentUrl,
} from '../lib/api/threads.js';
import { getErrorMessage } from '../lib/error-message.js';
import {
  isShellCenterHidden,
  resolveShellLayoutForWidth,
  type HomeShellProps,
  type ShellLayoutModeId,
} from './home-shell.js';
import { ShellLayoutMenu } from './shell-layout-menu.js';
import { useArtifactSurface } from './use-artifact-surface.js';
import { useHomeShell } from './use-home-shell.js';
import {
  useDaemonConnection,
  type DaemonConnectionState,
} from './use-daemon-connection.js';
import { usePanelWidths } from './use-panel-widths.js';
import {
  HomeCenterSurface,
  HomeSettings,
  type SettingsSection,
} from './HomeSettings.js';

const DAEMON_STATE_LABEL: Record<DaemonConnectionState, string> = {
  connected: '데몬 연결됨',
  reconnecting: '데몬에 다시 연결하는 중…',
  disconnected: '데몬 연결 끊김',
};

type RightPaneTab = 'chat' | 'sessions';
type CenterSurface =
  | 'editor'
  | 'extensions'
  | 'review'
  | 'settings'
  | 'sessions';

export function HomeShell(props: HomeShellProps) {
  const {
    leftPanelView,
    centerPanelView,
    rightPanelView,
    workingDirectory,
    selectWorkingDirectory,
    chooseWorkingDirectory,
    directoryPreferences,
    toggleFavoriteDirectory,
    chooseBrowseDirectory,
    refreshComputerFileScope,
    recentFiles,
    openFile,
    removeRecentFile,
    fileMutationGeneration,
    upsertThreadArtifactVersion,
  } = useHomeShell(props);
  const daemon = useDaemonConnection({
    onRecovered: () => {
      void refreshComputerFileScope();
    },
  });
  const { leftWidth, rightWidth, startResize } = usePanelWidths();
  const requestEditorSurface = useCallback(() => {
    setCenterSurface('editor');
  }, []);
  // 중앙 아티팩트 표면의 수명 전체 — 열림/버전/렌더·코드 모드/확대
  const artifactSurface = useArtifactSurface({
    selectedThreadId: leftPanelView.threadList.selectedThreadId,
    selectedFilePath: centerPanelView.editor.filePath,
    activeArtifact: rightPanelView.assistant.artifacts.activeVersion,
    streamingArtifactText: rightPanelView.streamingArtifactText,
    artifacts: rightPanelView.assistant.artifacts.versions,
    startArtifactRun: rightPanelView.assistant.artifacts.onStartRun,
    upsertThreadArtifactVersion,
    requestEditorSurface,
  });
  const [layoutMode, setLayoutMode] = useState<ShellLayoutModeId>('default');
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined'
      ? Number.POSITIVE_INFINITY
      : window.innerWidth,
  );
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  // ↖으로 세션 관리를 열 때 중앙이 숨는 모드였다면, 그 모드를 기억했다가 닫을
  // 때 되돌린다. null이면 레이아웃을 건드리지 않았다는 뜻(복원하지 않음).
  const [preSessionLayout, setPreSessionLayout] =
    useState<ShellLayoutModeId | null>(null);
  const [rightTab, setRightTab] = useState<RightPaneTab>('chat');
  const [centerSurface, setCenterSurface] = useState<CenterSurface>('editor');
  const [extensionInitialTab, setExtensionInitialTab] =
    useState<ExtensionHubTab>('plugins');
  const [settingsInitialSection, setSettingsInitialSection] =
    useState<SettingsSection>('providers');
  const [browseDirectoryPickerOpen, setBrowseDirectoryPickerOpen] =
    useState(false);
  const [composerDraftRequest, setComposerDraftRequest] =
    useState<AssistantComposerDraftRequest | null>(null);
  const composerDraftSequence = useRef(0);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const extensionsTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreCenterTriggerFocus = useRef<Exclude<
    CenterSurface,
    'editor' | 'review' | 'sessions'
  > | null>(null);
  const [runSettlementGeneration, setRunSettlementGeneration] = useState(0);
  const runBusy =
    rightPanelView.assistant.runState.isRunning ||
    rightPanelView.assistant.runState.isStarting === true ||
    rightPanelView.assistant.runState.isSettling === true;
  const previousRunBusyRef = useRef(runBusy);
  useEffect(() => {
    if (previousRunBusyRef.current && !runBusy) {
      setRunSettlementGeneration((current) => current + 1);
    }
    previousRunBusyRef.current = runBusy;
  }, [runBusy]);
  const gitReview = useGitReview({
    workingDirectory,
    reviewOpen: centerSurface === 'review',
    refreshGeneration: fileMutationGeneration + runSettlementGeneration,
  });
  // 채팅 모드에서는 중앙(에디터)이 내려가고 채팅이 그 자리를 차지한다
  const artifactSurfaceOpen =
    artifactSurface.artifactSurfaceMode !== null &&
    artifactSurface.centerArtifact !== null;
  const effectiveLayoutMode = resolveShellLayoutForWidth({
    preferredMode: layoutMode,
    viewportWidth,
    leftWidth,
    rightWidth,
    artifactSurfaceOpen,
  });
  const centerHidden = isShellCenterHidden(
    effectiveLayoutMode,
    artifactSurfaceOpen,
  );
  const leftCollapsed =
    effectiveLayoutMode === 'no-tree' ||
    effectiveLayoutMode === 'editor-only' ||
    effectiveLayoutMode === 'chat-only';
  const rightCollapsed =
    !centerHidden &&
    (centerSurface === 'review' ||
      effectiveLayoutMode === 'no-chat' ||
      effectiveLayoutMode === 'editor-only' ||
      artifactSurface.artifactExpanded);

  // 세션 관리 화면 열기/닫기 — 중앙이 숨는 모드에서 열면 탐색기 접기로 나오고,
  // 닫을 때 정확히 그 모드로 되돌린다. 다른 경로로 연 경우엔 레이아웃 무변경.
  const openSessionManager = () => {
    // 이미 열려 있으면 no-op — 저장해 둔 복원 레이아웃을 덮어쓰지 않는다.
    if (centerSurface === 'sessions') {
      return;
    }
    if (centerHidden) {
      setPreSessionLayout(layoutMode);
      setLayoutMode('no-tree');
    } else {
      setPreSessionLayout(null);
    }
    setCenterSurface('sessions');
  };
  const closeSessionManager = () => {
    setCenterSurface('editor');
    if (preSessionLayout !== null) {
      setLayoutMode(preSessionLayout);
      setPreSessionLayout(null);
    }
  };

  const openBrowseDirectoryPicker = () => {
    if (leftPanelView.computerTree.browseEnabled) {
      setBrowseDirectoryPickerOpen(true);
      return;
    }
    void chooseBrowseDirectory();
  };

  const isDaemonReadOnly = daemon.state === 'disconnected';

  const { setArtifactExpanded } = artifactSurface;
  const openGitReview = useCallback(() => {
    setCenterSurface('review');
    setArtifactExpanded(false);
    setLayoutMode((current) => (current === 'chat-only' ? 'default' : current));
  }, [setArtifactExpanded]);
  const openComposerCenterSurface = useCallback(
    (surface: Extract<CenterSurface, 'extensions' | 'settings'>) => {
      setCenterSurface(surface);
      setArtifactExpanded(false);
      setLayoutMode((current) =>
        current === 'chat-only' ? 'default' : current,
      );
    },
    [setArtifactExpanded],
  );
  const openSkills = useCallback(() => {
    setExtensionInitialTab('skills');
    openComposerCenterSurface('extensions');
  }, [openComposerCenterSurface]);
  const openMcpSettings = useCallback(() => {
    setSettingsInitialSection('mcp');
    openComposerCenterSurface('settings');
  }, [openComposerCenterSurface]);
  const startCreator = useCallback(
    (kind: ExtensionCreatorKind) => {
      composerDraftSequence.current += 1;
      setComposerDraftRequest({
        requestId: composerDraftSequence.current,
        text: kind === 'plugin' ? '@plugin_creator' : '@skill_creator',
      });
      setRightTab('chat');
      setCenterSurface('editor');
      setArtifactExpanded(false);
      setLayoutMode((current) =>
        current === 'no-chat' || current === 'editor-only'
          ? 'default'
          : current,
      );
    },
    [setArtifactExpanded],
  );

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
        className={`shell layout-${effectiveLayoutMode}`}
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
            <ComputerTree
              {...leftPanelView.computerTree}
              favoriteDirectories={directoryPreferences.favorites}
            />
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
                onClick={() => {
                  setExtensionInitialTab('plugins');
                  setCenterSurface((current) =>
                    current === 'extensions' ? 'editor' : 'extensions',
                  );
                }}
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
                onClick={() => {
                  setSettingsInitialSection('providers');
                  setCenterSurface((current) =>
                    current === 'settings' ? 'editor' : 'settings',
                  );
                }}
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
                : centerSurface === 'review'
                  ? ' review-open'
                  : ''
          }${artifactSurface.artifactExpanded ? ' artifact-expanded' : ''}${centerHidden ? ' center-hidden' : ''}`}
          aria-label={
            centerSurface === 'settings'
              ? '설정'
              : centerSurface === 'extensions'
                ? '플러그인과 스킬'
                : centerSurface === 'review'
                  ? 'Git 변경 검토'
                  : artifactSurface.artifactSurfaceMode !== null &&
                      artifactSurface.centerArtifact !== null
                    ? '아티팩트'
                    : '편집기'
          }
        >
          {rightCollapsed && centerSurface !== 'review' ? (
            <span className="panel-reopen right">
              <ShellLayoutMenu
                mode={effectiveLayoutMode}
                onSelect={setLayoutMode}
                buttonClassName="panel-reopen-button"
              />
            </span>
          ) : null}
          <HomeCenterSurface
            settingsOpen={centerSurface === 'settings'}
            extensionsOpen={centerSurface === 'extensions'}
            sessionsOpen={centerSurface === 'sessions'}
            reviewOpen={centerSurface === 'review'}
            sessions={
              <SessionManagerOverlay
                threads={leftPanelView.threadList.threads}
                selectedThreadId={leftPanelView.threadList.selectedThreadId}
                onClose={closeSessionManager}
                onSelect={async (threadId) => {
                  await leftPanelView.threadList.onSelect(threadId);
                  setRightTab('chat');
                  closeSessionManager();
                }}
                onRefresh={leftPanelView.threadList.onLoad}
                onSelectedThreadDeleted={leftPanelView.onNewSession}
                onNewSession={() => {
                  leftPanelView.onNewSession();
                  setRightTab('chat');
                  closeSessionManager();
                }}
              />
            }
            editor={
              <Editor
                {...centerPanelView.editor}
                readOnly={isDaemonReadOnly || centerSurface !== 'editor'}
                recentFiles={recentFiles}
                onOpenFolder={openBrowseDirectoryPicker}
                onOpenRecentFile={openFile}
                onRemoveRecentFile={removeRecentFile}
                gitReviewTrigger={
                  <GitReviewSummaryTrigger
                    summary={gitReview.changedSummary}
                    disabled={isDaemonReadOnly}
                    onOpen={openGitReview}
                  />
                }
                {...(artifactSurface.centerArtifact !== null
                  ? {
                      artifactPill: {
                        label:
                          artifactSurface.centerArtifact.title ?? '아티팩트',
                        active: artifactSurface.artifactSurfaceMode !== null,
                        onOpen: () =>
                          artifactSurface.setArtifactSurfaceMode('render'),
                        onExit: () =>
                          artifactSurface.setArtifactSurfaceMode(null),
                      },
                      artifactSurface: (
                        <ArtifactEditorSurface
                          artifact={artifactSurface.centerArtifact}
                          threadId={selectedThreadId}
                          planningWorkflowSnapshot={
                            rightPanelView.assistant.workflow.planningWorkflow
                              ?.snapshot ?? null
                          }
                          isRunning={
                            rightPanelView.assistant.runState.isRunning
                          }
                          mode={artifactSurface.artifactSurfaceMode ?? 'render'}
                          onSelectMode={artifactSurface.setArtifactSurfaceMode}
                          streamToken={artifactSurface.artifactStreamToken}
                          onStreamRevealDone={
                            artifactSurface.onStreamRevealDone
                          }
                          onRewrite={artifactSurface.onRewrite}
                          expanded={artifactSurface.artifactExpanded}
                          onToggleExpand={() =>
                            artifactSurface.setArtifactExpanded((prev) => !prev)
                          }
                          versionHistory={artifactSurface.versionHistory}
                          onSelectVersion={artifactSurface.onSelectVersion}
                          onCommitDraft={artifactSurface.onCommitDraft}
                          onClose={artifactSurface.closeArtifact}
                        />
                      ),
                    }
                  : {})}
              />
            }
            extensions={
              <ExtensionHub
                initialTab={extensionInitialTab}
                disabled={isDaemonReadOnly}
                onStartCreator={startCreator}
                onClose={() => {
                  restoreCenterTriggerFocus.current = 'extensions';
                  setCenterSurface('editor');
                }}
              />
            }
            review={
              <GitReviewSurface
                controller={gitReview}
                onClose={() => setCenterSurface('editor')}
              />
            }
            settings={
              <HomeSettings
                initialSection={settingsInitialSection}
                providerAuthCard={centerPanelView.providerAuthCard}
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
            <div className="assistant-header-tabs">
              {/* 탭이 아닌 것은 tablist 밖에 둔다 — 새 세션과 레이아웃은
                  선택지가 아니라 동작이므로, 같은 role 안에 넣으면 보조기술이
                  "탭 1/4"처럼 잘못 읽는다. */}
              <div className="assistant-header-tabgroup" role="tablist">
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
              </div>
              <button
                type="button"
                className="rail-icon-button"
                title="새 세션"
                aria-label="새 세션"
                onClick={() => {
                  leftPanelView.onNewSession();
                  setRightTab('chat');
                }}
              >
                <span className="rail-action-icon new-session" aria-hidden />
              </button>
              <ShellLayoutMenu
                mode={effectiveLayoutMode}
                onSelect={setLayoutMode}
                buttonClassName="rail-icon-button layout-cycle"
              />
            </div>
          </div>
          <div className="assistant-body">
            {rightTab === 'sessions' ? (
              <div className="sessions-pane">
                <div className="sessions-pane-inner">
                  <ThreadList
                    {...leftPanelView.threadList}
                    onSelect={async (threadId) => {
                      await leftPanelView.threadList.onSelect(threadId);
                      setRightTab('chat');
                    }}
                    onOpenManager={openSessionManager}
                    onRenameRequest={async (threadId, title) => {
                      await renameThread(threadId, title);
                      await leftPanelView.threadList.onLoad();
                    }}
                    onTogglePin={async (threadId, pinned) => {
                      await setThreadPinned(threadId, pinned);
                      await leftPanelView.threadList.onLoad();
                    }}
                  />
                  {leftPanelView.threadDeleteConfirm ? (
                    <ThreadDeleteConfirm
                      {...leftPanelView.threadDeleteConfirm}
                    />
                  ) : null}
                </div>
              </div>
            ) : (
              <Assistant
                {...rightPanelView.assistant}
                artifacts={{
                  ...rightPanelView.assistant.artifacts,
                  onOpen: artifactSurface.openArtifact,
                }}
                workspace={{
                  workingDirectory,
                  browseEnabled: leftPanelView.computerTree.browseEnabled,
                  browsePath: leftPanelView.computerTree.browsePath,
                  browseStartPath: leftPanelView.computerTree.browseStartPath,
                  browseShortcuts: leftPanelView.computerTree.browseShortcuts,
                  recentDirectories: directoryPreferences.recents,
                  favoriteDirectories: directoryPreferences.favorites,
                  onToggleFavoriteDirectory: toggleFavoriteDirectory,
                  onSelectWorkingDirectory: selectWorkingDirectory,
                  onChooseWorkingDirectory: chooseWorkingDirectory,
                }}
                attachments={{
                  onUploadFiles: handleUploadFiles,
                  onDiscardUploadedAttachment: handleDiscardUploadedAttachment,
                  imageUrl: attachmentImageUrl,
                }}
                workflow={{
                  ...rightPanelView.assistant.workflow,
                  approvalPanel: (
                    <Approvals {...rightPanelView.approvalPanel} />
                  ),
                }}
                composerSurface={{
                  ...rightPanelView.assistant.composerSurface,
                  draftRequest: composerDraftRequest,
                  onOpenSkills: openSkills,
                  onOpenMcpSettings: openMcpSettings,
                  imageProviderConnected: {
                    grok_oauth:
                      props.providerAuthStatuses.grok_oauth?.ready === true,
                    openai_codex_direct:
                      props.providerAuthStatuses.openai_codex_direct?.ready ===
                      true,
                  },
                }}
              />
            )}
          </div>
        </aside>
      </div>
      {browseDirectoryPickerOpen ? (
        <ComputerDirectoryPickerDialog
          title="폴더 열기"
          confirmLabel="이 폴더 열기"
          initialPath={
            leftPanelView.computerTree.browsePath ||
            leftPanelView.computerTree.browseStartPath
          }
          browsePath={leftPanelView.computerTree.browsePath}
          browseStartPath={leftPanelView.computerTree.browseStartPath}
          browseShortcuts={leftPanelView.computerTree.browseShortcuts}
          onSelect={(path) => {
            leftPanelView.computerTree.onNavigateInto(path);
            setBrowseDirectoryPickerOpen(false);
          }}
          onClose={() => setBrowseDirectoryPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}
