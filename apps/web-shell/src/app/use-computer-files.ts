import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConflictStaleWriteError } from '@geulbat/protocol/errors';
import type { ComputerFileScopeResponse } from '@geulbat/protocol/files';

import { ApiFetchError } from '../lib/api/client.js';
import {
  rawFileUrl,
  COMPUTER_FILE_API_SCOPE,
  FileSaveConflictError,
  manageFile,
  readFile,
  saveFile,
  type ManageFileOperation,
} from '../lib/api/files.js';
import { createLogger } from '@geulbat/structured-logger/logger';
import { baseNameOf, parentDirOf, splitExtension } from '../lib/path-name.js';
import { reportVisibleAppError } from './error-reporting.js';
import {
  useComputerFileBrowser,
  type ReportComputerFileErrorArgs,
} from './use-computer-file-browser.js';
import {
  useComputerFileBuffers,
  type ComputerFileMediaPreview,
} from './use-computer-file-buffers.js';

const logger = createLogger('computer-files');

// saveFile의 빈 versionToken은 create-only sentinel (daemon save pipeline 계약)
const CREATE_ONLY_VERSION_TOKEN = '';

import type { OpenFileTab } from '../features/editor/Editor.js';

export type { OpenFileTab };

const AUDIO_FILE_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac']);
const VIDEO_FILE_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov']);

const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'svg',
  'avif',
]);

// 텍스트일 리 없는 확장자 — read 시도 없이 바로 '미리보기 미지원' 처리
// (클릭마다 400 요청이 쌓이는 콘솔 소음/지연 방지)
const KNOWN_BINARY_EXTENSIONS = new Set([
  'zip',
  '7z',
  'rar',
  'tar',
  'gz',
  'bz2',
  'xz',
  'exe',
  'msi',
  'dll',
  'so',
  'dylib',
  'bin',
  'iso',
  'img',
  'dmg',
  'otf',
  'ttf',
  'woff',
  'woff2',
  'eot',
  'mkv',
  'avi',
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
  'mp4',
  'webm',
  'ogv',
  'mov',
  'pdf',
  'doc',
  'xls',
  'ppt',
  'pptx',
  'hwp',
  'psd',
  'ai',
  'sketch',
  'blend',
  'db',
  'sqlite',
  'dat',
  'pak',
  'class',
  'jar',
  'pyc',
  'wasm',
  'lnk',
]);

function fileExtensionOf(path: string): string {
  return splitExtension(baseNameOf(path)).ext.toLowerCase().replace(/^\./, '');
}

function isImageFileName(path: string): boolean {
  return IMAGE_FILE_EXTENSIONS.has(fileExtensionOf(path));
}

function mediaPreviewKindOf(path: string): 'audio' | 'video' | null {
  const extension = fileExtensionOf(path);
  if (AUDIO_FILE_EXTENSIONS.has(extension)) {
    return 'audio';
  }
  if (VIDEO_FILE_EXTENSIONS.has(extension)) {
    return 'video';
  }
  return null;
}

function isKnownBinaryFileName(path: string): boolean {
  return KNOWN_BINARY_EXTENSIONS.has(fileExtensionOf(path));
}

function isBinaryFileError(error: unknown): boolean {
  return (
    error instanceof ApiFetchError &&
    error.status === 400 &&
    error.message.includes('binary_file')
  );
}

function reportComputerFileError({
  logContext,
  visiblePrefix,
  error,
}: ReportComputerFileErrorArgs): string {
  return reportVisibleAppError({
    logger,
    logContext,
    visiblePrefix,
    error,
  });
}

function buildConflictCopyPath(path: string): string {
  const parent = parentDirOf(path);
  const { base, ext } = splitExtension(baseNameOf(path));
  const copyName = `${base} (충돌 사본)${ext}`;
  return parent === '' ? copyName : `${parent}/${copyName}`;
}

export function useComputerFiles(options?: {
  initialComputerFileScope?: ComputerFileScopeResponse;
}) {
  const {
    tree,
    treeError,
    browseEnabled,
    browsePath,
    browseStartPath,
    browseShortcuts,
    refreshComputerFileScope,
    loadTree,
    loadSubtree,
    navigateUp,
    navigateInto,
    reportTreeError,
  } = useComputerFileBrowser({
    initialComputerFileScope: options?.initialComputerFileScope,
    reportError: reportComputerFileError,
  });
  const {
    activePath,
    activeTextBuffer,
    binaryPreview,
    recentFilePaths,
    openFiles,
    hasBuffer,
    openTextBuffer,
    replaceTextBuffer,
    openMediaBuffer: openMediaFileBuffer,
    activateBuffer,
    closeBuffer,
    patchTextBuffer,
    removeRecentFile,
    removeManagedPath,
    remapManagedPath,
  } = useComputerFileBuffers();
  const [saveConflict, setSaveConflict] =
    useState<ConflictStaleWriteError | null>(null);
  const [saving, setSaving] = useState(false);
  const [openingFile, setOpeningFile] = useState(false);
  const [mutationGeneration, setMutationGeneration] = useState(0);
  const openRequestSeqRef = useRef(0);
  const [editorError, setEditorError] = useState<string | null>(null);

  useEffect(
    () => () => {
      openRequestSeqRef.current += 1;
    },
    [],
  );

  const openMediaBuffer = useCallback(
    (path: string, media: ComputerFileMediaPreview) => {
      openMediaFileBuffer(path, media);
      setSaveConflict(null);
      setEditorError(null);
    },
    [openMediaFileBuffer],
  );

  const openUnsupportedPreview = useCallback(
    (path: string) => {
      openRequestSeqRef.current += 1;
      openMediaBuffer(path, { kind: 'unsupported' });
      setOpeningFile(false);
    },
    [openMediaBuffer],
  );

  // binary_file 거부 파일 — 브라우저가 직접 렌더할 수 있는 이미지/미디어만
  // raw 바이트 미리보기로 열고, 그 외는 안내 카드로 둔다.
  const openBinaryPreview = useCallback(
    async (path: string, requestSeq: number) => {
      const kind = isImageFileName(path) ? 'image' : mediaPreviewKindOf(path);
      if (kind === null) {
        if (requestSeq !== openRequestSeqRef.current) {
          return;
        }
        openMediaBuffer(path, { kind: 'unsupported' });
        return;
      }
      // 브라우저가 직접 렌더할 수 있는 바이너리는 전체 다운로드 없이 raw URL을
      // 사용한다. 이미지도 큰 파일을 blob으로 복제하지 않고, 미디어의 Range
      // 요청과 같은 데몬 경계를 통과한다.
      if (requestSeq !== openRequestSeqRef.current) {
        return;
      }
      openMediaBuffer(path, {
        kind,
        url: rawFileUrl(COMPUTER_FILE_API_SCOPE, path),
      });
    },
    [openMediaBuffer],
  );

  const openComputerFile = useCallback(
    async (path: string) => {
      const requestSeq = (openRequestSeqRef.current += 1);
      // 이미 열린 탭이면 다시 읽지 않고 활성화만 — dirty buffer 보존
      if (hasBuffer(path)) {
        activateBuffer(path);
        setSaveConflict(null);
        setEditorError(null);
        setOpeningFile(false);
        return;
      }
      if (isImageFileName(path) || mediaPreviewKindOf(path) !== null) {
        setOpeningFile(true);
        try {
          await openBinaryPreview(path, requestSeq);
        } finally {
          if (requestSeq === openRequestSeqRef.current) {
            setOpeningFile(false);
          }
        }
        return;
      }
      if (isKnownBinaryFileName(path)) {
        openUnsupportedPreview(path);
        return;
      }
      setOpeningFile(true);
      try {
        const res = await readFile(COMPUTER_FILE_API_SCOPE, path);
        if (requestSeq !== openRequestSeqRef.current) {
          return;
        }
        openTextBuffer({
          path,
          content: res.content,
          versionToken: res.versionToken,
          isDirty: false,
          lastSavedAt: null,
          ...(res.extractedDocument !== undefined
            ? { extractedDocument: res.extractedDocument }
            : {}),
        });
        setSaveConflict(null);
        setEditorError(null);
      } catch (err: unknown) {
        if (requestSeq !== openRequestSeqRef.current) {
          return;
        }
        if (isBinaryFileError(err)) {
          await openBinaryPreview(path, requestSeq);
          return;
        }
        setEditorError(
          reportComputerFileError({
            logContext: 'openFile failed',
            visiblePrefix: `${path} 파일을 열지 못했습니다.`,
            error: err,
          }),
        );
      } finally {
        if (requestSeq === openRequestSeqRef.current) {
          setOpeningFile(false);
        }
      }
    },
    [
      activateBuffer,
      hasBuffer,
      openBinaryPreview,
      openTextBuffer,
      openUnsupportedPreview,
    ],
  );

  const openFile = useCallback(
    async (path: string) => {
      await openComputerFile(path);
    },
    [openComputerFile],
  );

  const activateTab = useCallback(
    (path: string) => {
      activateBuffer(path);
      setSaveConflict(null);
      setEditorError(null);
    },
    [activateBuffer],
  );

  const closeTab = useCallback(
    (path: string) => {
      closeBuffer(path);
      setSaveConflict(null);
      setEditorError(null);
    },
    [closeBuffer],
  );

  const handleContentChange = useCallback(
    (content: string) => {
      if (!activePath) {
        return;
      }
      patchTextBuffer(activePath, { content, isDirty: true });
      setSaveConflict(null);
      setEditorError(null);
    },
    [activePath, patchTextBuffer],
  );

  const handleSave = useCallback(async () => {
    if (!activeTextBuffer || saving) {
      return;
    }

    setSaving(true);
    setSaveConflict(null);
    setEditorError(null);
    try {
      const res = await saveFile(
        COMPUTER_FILE_API_SCOPE,
        activeTextBuffer.path,
        activeTextBuffer.content,
        activeTextBuffer.versionToken,
      );
      patchTextBuffer(activeTextBuffer.path, {
        versionToken: res.versionToken,
        isDirty: false,
        lastSavedAt: Date.now(),
      });
      setMutationGeneration((current) => current + 1);
    } catch (err: unknown) {
      if (err instanceof FileSaveConflictError) {
        setSaveConflict(err.conflict);
        return;
      }
      setEditorError(
        reportComputerFileError({
          logContext: 'save failed',
          visiblePrefix: `${activeTextBuffer.path} 저장에 실패했습니다.`,
          error: err,
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [activeTextBuffer, patchTextBuffer, saving]);

  // 새 파일 생성 — daemon save의 create-only sentinel 사용 (§3.1.2 새 파일)
  const createFile = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        const res = await saveFile(
          COMPUTER_FILE_API_SCOPE,
          path,
          '',
          CREATE_ONLY_VERSION_TOKEN,
        );
        await loadTree();
        openTextBuffer({
          path,
          content: '',
          versionToken: res.versionToken,
          isDirty: false,
          lastSavedAt: null,
        });
        setSaveConflict(null);
        setEditorError(null);
        setMutationGeneration((current) => current + 1);
        return true;
      } catch (err: unknown) {
        reportTreeError({
          logContext: 'createFile failed',
          visiblePrefix: `${path} 파일을 만들지 못했습니다.`,
          error: err,
        });
        return false;
      }
    },
    [loadTree, openTextBuffer, reportTreeError],
  );

  // 트리 편집 ops — 열린 버퍼(탭)도 새 경로/삭제에 맞춰 정리한다
  const manageEntry = useCallback(
    async (
      operation: ManageFileOperation,
      path: string,
      destination?: string,
    ): Promise<boolean> => {
      try {
        await manageFile(COMPUTER_FILE_API_SCOPE, operation, path, destination);
        if (operation === 'delete') {
          removeManagedPath(path);
        }
        if (
          (operation === 'rename' || operation === 'move') &&
          destination !== undefined
        ) {
          remapManagedPath(path, destination);
        }
        await loadTree();
        setMutationGeneration((current) => current + 1);
        return true;
      } catch (err: unknown) {
        reportTreeError({
          logContext: `manage ${operation} failed`,
          visiblePrefix: `${path} ${operation} 작업에 실패했습니다.`,
          error: err,
        });
        return false;
      }
    },
    [loadTree, remapManagedPath, removeManagedPath, reportTreeError],
  );

  const handleConflictReload = useCallback(async () => {
    if (!activePath) {
      return;
    }
    setOpeningFile(true);
    try {
      const res = await readFile(COMPUTER_FILE_API_SCOPE, activePath);
      replaceTextBuffer({
        path: activePath,
        content: res.content,
        versionToken: res.versionToken,
        isDirty: false,
        lastSavedAt: null,
      });
      setSaveConflict(null);
      setEditorError(null);
    } catch (err: unknown) {
      setEditorError(
        reportComputerFileError({
          logContext: 'conflict reload failed',
          visiblePrefix: `${activePath} 파일을 다시 불러오지 못했습니다.`,
          error: err,
        }),
      );
    } finally {
      setOpeningFile(false);
    }
  }, [activePath, replaceTextBuffer]);

  // "본문에 삽입" (§3.1.3) — plain editor에서는 caret을 알 수 없으므로
  // 문서 끝 append 전 confirm (§10.18 no-caret 규칙)
  const insertFileIntoActiveBuffer = useCallback(
    async (path: string) => {
      if (!activeTextBuffer) {
        setEditorError('본문에 삽입하려면 먼저 문서를 열어야 합니다.');
        return;
      }
      try {
        const res = await readFile(COMPUTER_FILE_API_SCOPE, path);
        if (
          !window.confirm(
            `${activeTextBuffer.path} 문서 끝에 ${path} 내용을 추가할까요?`,
          )
        ) {
          return;
        }
        patchTextBuffer(activeTextBuffer.path, {
          content: `${activeTextBuffer.content}\n\n${res.content}`,
          isDirty: true,
        });
      } catch (err: unknown) {
        setEditorError(
          reportComputerFileError({
            logContext: 'insert into buffer failed',
            visiblePrefix: `${path} 내용을 삽입하지 못했습니다.`,
            error: err,
          }),
        );
      }
    },
    [activeTextBuffer, patchTextBuffer],
  );

  // 현재 daemon-visible 내용을 buffer 교체 없이 조회 (§3.6.5 현재 파일 확인하기)
  const inspectCurrentFile = useCallback(async (): Promise<string | null> => {
    if (!activePath) {
      return null;
    }
    try {
      const res = await readFile(COMPUTER_FILE_API_SCOPE, activePath);
      return res.content;
    } catch (err: unknown) {
      setEditorError(
        reportComputerFileError({
          logContext: 'inspect current file failed',
          visiblePrefix: `${activePath}의 현재 내용을 확인하지 못했습니다.`,
          error: err,
        }),
      );
      return null;
    }
  }, [activePath]);

  // 충돌 시 unsaved buffer를 새 파일로 저장 — 원본은 daemon state 유지,
  // force overwrite는 제공하지 않는다 (§3.6.5 / §10.20)
  const handleConflictSaveAsCopy = useCallback(async () => {
    if (!activeTextBuffer || !saveConflict || saving) {
      return;
    }

    const copyPath = buildConflictCopyPath(activeTextBuffer.path);
    setSaving(true);
    setEditorError(null);
    try {
      const res = await saveFile(
        COMPUTER_FILE_API_SCOPE,
        copyPath,
        activeTextBuffer.content,
        CREATE_ONLY_VERSION_TOKEN,
      );
      await loadTree();
      openTextBuffer({
        path: copyPath,
        content: activeTextBuffer.content,
        versionToken: res.versionToken,
        isDirty: false,
        lastSavedAt: Date.now(),
      });
      setSaveConflict(null);
      setMutationGeneration((current) => current + 1);
    } catch (err: unknown) {
      setEditorError(
        reportComputerFileError({
          logContext: 'conflict save-as-copy failed',
          visiblePrefix: `${copyPath}로 사본 저장에 실패했습니다.`,
          error: err,
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [activeTextBuffer, loadTree, openTextBuffer, saveConflict, saving]);

  return {
    tree,
    treeError,
    binaryPreview,
    extractedDocument: activeTextBuffer?.extractedDocument ?? null,
    browseEnabled,
    browseShortcuts,
    browsePath,
    browseStartPath,
    refreshComputerFileScope,
    navigateUp,
    navigateInto,
    selectedFile: activePath,
    recentFiles: recentFilePaths,
    removeRecentFile,
    fileContent: activeTextBuffer?.content ?? '',
    isDirty: activeTextBuffer?.isDirty ?? false,
    saveConflict,
    editorError,
    saving,
    openingFile,
    lastSavedAt: activeTextBuffer?.lastSavedAt ?? null,
    mutationGeneration,
    openFiles,
    loadTree,
    loadSubtree,
    openFile,
    activateTab,
    closeTab,
    createFile,
    manageEntry,
    insertFileIntoActiveBuffer,
    handleContentChange,
    handleSave,
    handleConflictReload,
    handleConflictSaveAsCopy,
    inspectCurrentFile,
  };
}
