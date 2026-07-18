import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConflictStaleWriteError } from '@geulbat/protocol/errors';
import type { FileTreeNode } from '@geulbat/protocol/files';

import { ApiFetchError, PreviewTooLargeError } from '../lib/api/client.js';
import {
  fetchRawFileBlob,
  rawFileUrl,
  COMPUTER_FILE_API_SCOPE,
  FileSaveConflictError,
  getComputerFileScope,
  getFileTree,
  manageFile,
  readFile,
  saveFile,
  type ManageFileOperation,
} from '../lib/api/files.js';
import { createLogger } from '@geulbat/shared-utils/logger';
import { baseNameOf, parentDirOf, splitExtension } from '../lib/path-name.js';
import { reportVisibleAppError } from './error-reporting.js';

const logger = createLogger('workspace-files');

// saveFile의 빈 versionToken은 create-only sentinel (daemon save pipeline 계약)
const CREATE_ONLY_VERSION_TOKEN = '';

import type { OpenFileTab } from '../features/editor/Editor.js';

export type { OpenFileTab };

// 파일 버퍼 하나 = 열린 탭 하나 (VSCode식 멀티 탭)
interface FileBuffer {
  path: string;
  content: string;
  versionToken: string;
  isDirty: boolean;
  lastSavedAt: number | null;
  // 오피스 문서 추출본 — 읽기 전용, 저장 불가
  extractedDocument?: 'docx' | 'xlsx' | 'hwpx';
}

interface ReportWorkspaceFileErrorArgs {
  logContext: string;
  visiblePrefix: string;
  error: unknown;
}

interface BinaryPreviewState {
  path: string;
  kind: 'image' | 'audio' | 'video' | 'unsupported';
  url?: string;
  byteSize?: number;
}

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

function reportWorkspaceFileError({
  logContext,
  visiblePrefix,
  error,
}: ReportWorkspaceFileErrorArgs): string {
  return reportVisibleAppError({
    logger,
    logContext,
    visiblePrefix,
    error,
  });
}

// lazy 트리 병합 — path 노드의 children을 새 하위 트리로 교체
function mergeSubtree(
  nodes: FileTreeNode[],
  path: string,
  children: FileTreeNode[],
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.type !== 'directory') {
      return node;
    }
    if (node.path === path) {
      return { ...node, children };
    }
    if (path.startsWith(`${node.path}/`) && node.children) {
      return { ...node, children: mergeSubtree(node.children, path, children) };
    }
    return node;
  });
}

function buildConflictCopyPath(path: string): string {
  const parent = parentDirOf(path);
  const { base, ext } = splitExtension(baseNameOf(path));
  const copyName = `${base} (충돌 사본)${ext}`;
  return parent === '' ? copyName : `${parent}/${copyName}`;
}

export function useWorkspaceFiles(options?: {
  initialComputerFileScope?: Awaited<ReturnType<typeof getComputerFileScope>>;
}) {
  const [computerFileScope, setComputerFileScope] = useState<
    Awaited<ReturnType<typeof getComputerFileScope>> | undefined
  >(options?.initialComputerFileScope);
  const [computerFileScopeError, setComputerFileScopeError] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (options?.initialComputerFileScope !== undefined) {
      return;
    }
    let active = true;
    void getComputerFileScope()
      .then((scope) => {
        if (active) {
          setComputerFileScope(scope);
          setComputerFileScopeError(null);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setComputerFileScopeError(
            reportWorkspaceFileError({
              logContext: 'computer file scope failed',
              visiblePrefix: '컴퓨터 파일 범위를 불러오지 못했습니다.',
              error,
            }),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [options?.initialComputerFileScope]);
  const browseEnabled = computerFileScope?.available === true;
  const browseStartPath = browseEnabled
    ? (computerFileScope.browseStartPath ?? '')
    : '';
  const browseShortcuts = browseEnabled
    ? computerFileScope.browseShortcuts
    : [];
  const [browsePath, setBrowsePath] = useState(browseStartPath);
  // projects 목록이 비동기로 늦게 도착한다 — 사용자가 아직 이동하지
  // 않았다면 시작 위치(홈)를 뒤늦게라도 반영
  const browseTouchedRef = useRef(false);
  useEffect(() => {
    if (
      browseEnabled &&
      !browseTouchedRef.current &&
      browseStartPath !== '' &&
      browsePath === ''
    ) {
      browseEpochRef.current += 1;
      setBrowsePath(browseStartPath);
    }
  }, [browseEnabled, browsePath, browseStartPath]);
  // 탐색 위치가 바뀌면 이전 위치 기준으로 날아간 트리 응답은 무효 —
  // 늦게 도착한 subtree/tree 응답이 새 트리를 덮어쓰는 race 방지
  const browseEpochRef = useRef(0);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<FileBuffer[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] =
    useState<ConflictStaleWriteError | null>(null);
  const [saving, setSaving] = useState(false);
  const [openingFile, setOpeningFile] = useState(false);
  // 텍스트가 아닌 파일 미리보기 — 이미지/미디어는 raw로 렌더, 그 외는 안내
  const [binaryPreview, setBinaryPreview] = useState<BinaryPreviewState | null>(
    null,
  );
  const openRequestSeqRef = useRef(0);
  const replaceBinaryPreview = useCallback(
    (next: BinaryPreviewState | null) => {
      setBinaryPreview((prev) => {
        if (prev?.url) {
          URL.revokeObjectURL(prev.url);
        }
        return next;
      });
    },
    [],
  );
  const [editorError, setEditorError] = useState<string | null>(null);

  const activeBuffer = buffers.find((buffer) => buffer.path === activePath);

  const upsertBuffer = useCallback((next: FileBuffer) => {
    setBuffers((prev) => {
      const index = prev.findIndex((buffer) => buffer.path === next.path);
      if (index < 0) {
        return [...prev, next];
      }
      const copy = [...prev];
      copy[index] = next;
      return copy;
    });
  }, []);

  const patchBuffer = useCallback(
    (path: string, patch: Partial<FileBuffer>) => {
      setBuffers((prev) =>
        prev.map((buffer) =>
          buffer.path === path ? { ...buffer, ...patch } : buffer,
        ),
      );
    },
    [],
  );

  const loadTree = useCallback(async () => {
    const epoch = browseEpochRef.current;
    try {
      // 얕게 먼저 그리고(넓은 root에서도 빠른 첫 페인트) 하위는 lazy 로딩
      if (computerFileScope?.available !== true) {
        return;
      }
      const res = await getFileTree(COMPUTER_FILE_API_SCOPE, {
        depth: 1,
        ...(browsePath !== '' ? { path: browsePath } : {}),
      });
      if (epoch !== browseEpochRef.current) {
        return;
      }
      setTree(res.tree);
      setTreeError(null);
    } catch (err: unknown) {
      setTreeError(
        reportWorkspaceFileError({
          logContext: 'loadTree failed',
          visiblePrefix: '파일 목록을 불러오지 못했습니다.',
          error: err,
        }),
      );
    }
  }, [browsePath, computerFileScope]);

  // 탐색 위치 이동 (↑ 상위 / 폴더로 진입)
  const navigateUp = useCallback(() => {
    if (!browseEnabled) {
      return;
    }
    browseTouchedRef.current = true;
    browseEpochRef.current += 1;
    setBrowsePath((prev) => parentDirOf(prev));
  }, [browseEnabled]);

  const navigateInto = useCallback(
    (path: string) => {
      if (!browseEnabled) {
        return;
      }
      browseTouchedRef.current = true;
      browseEpochRef.current += 1;
      setBrowsePath(path);
    },
    [browseEnabled],
  );

  // 폴더 펼침 시 하위 트리 lazy 로딩 (넓은 boundary root 대응)
  const loadSubtree = useCallback(async (path: string) => {
    const epoch = browseEpochRef.current;
    try {
      // depth 1 — 넓은 root(9p 마운트)에서 대형 폴더의 손자까지
      // 프리페치하면 병합/렌더가 수 초씩 걸린다. 펼칠 때마다 한 층씩.
      const res = await getFileTree(COMPUTER_FILE_API_SCOPE, {
        path,
        depth: 1,
      });
      if (epoch !== browseEpochRef.current) {
        return;
      }
      setTree((prev) => mergeSubtree(prev, path, res.tree));
    } catch (err: unknown) {
      setTreeError(
        reportWorkspaceFileError({
          logContext: 'loadSubtree failed',
          visiblePrefix: `${path} 하위 목록을 불러오지 못했습니다.`,
          error: err,
        }),
      );
    }
  }, []);

  const openUnsupportedPreview = useCallback(
    (path: string) => {
      openRequestSeqRef.current += 1;
      replaceBinaryPreview({ path, kind: 'unsupported' });
      setActivePath(null);
      setEditorError(null);
      setOpeningFile(false);
    },
    [replaceBinaryPreview],
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
        replaceBinaryPreview({ path, kind: 'unsupported' });
        setActivePath(null);
        setEditorError(null);
        return;
      }
      if (kind === 'audio' || kind === 'video') {
        // 미디어는 전체 다운로드 없이 스트리밍 URL 직접 — 대용량도 즉시
        // 재생되고 구간 탐색은 Range 요청으로 처리된다
        if (requestSeq !== openRequestSeqRef.current) {
          return;
        }
        replaceBinaryPreview({
          path,
          kind,
          url: rawFileUrl(COMPUTER_FILE_API_SCOPE, path),
        });
        setActivePath(null);
        setEditorError(null);
        return;
      }
      try {
        const blob = await fetchRawFileBlob(COMPUTER_FILE_API_SCOPE, path);
        const url = URL.createObjectURL(blob);
        if (requestSeq !== openRequestSeqRef.current) {
          URL.revokeObjectURL(url);
          return;
        }
        replaceBinaryPreview({
          path,
          kind,
          url,
          byteSize: blob.size,
        });
        setActivePath(null);
        setEditorError(null);
      } catch (err: unknown) {
        if (requestSeq !== openRequestSeqRef.current) {
          return;
        }
        if (err instanceof PreviewTooLargeError) {
          replaceBinaryPreview({ path, kind: 'unsupported' });
          setActivePath(null);
          setEditorError(null);
          return;
        }
        setEditorError(
          reportWorkspaceFileError({
            logContext: 'openBinaryPreview failed',
            visiblePrefix: `${path} 미리보기를 불러오지 못했습니다.`,
            error: err,
          }),
        );
      }
    },
    [replaceBinaryPreview],
  );

  const openComputerFile = useCallback(
    async (path: string) => {
      const requestSeq = (openRequestSeqRef.current += 1);
      // 이미 열린 탭이면 다시 읽지 않고 활성화만 — dirty buffer 보존
      const existing = buffers.find((buffer) => buffer.path === path);
      if (existing) {
        setActivePath(path);
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
        upsertBuffer({
          path,
          content: res.content,
          versionToken: res.versionToken,
          isDirty: false,
          lastSavedAt: null,
          ...(res.extractedDocument !== undefined
            ? { extractedDocument: res.extractedDocument }
            : {}),
        });
        setActivePath(path);
        replaceBinaryPreview(null);
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
          reportWorkspaceFileError({
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
      buffers,
      openBinaryPreview,
      openUnsupportedPreview,
      replaceBinaryPreview,
      upsertBuffer,
    ],
  );

  const openFile = useCallback(
    async (path: string) => {
      await openComputerFile(path);
    },
    [openComputerFile],
  );

  const openProjectFile = openFile;

  const activateTab = useCallback((path: string) => {
    setActivePath(path);
    setSaveConflict(null);
    setEditorError(null);
  }, []);

  const closeTab = useCallback(
    (path: string) => {
      setBuffers((prev) => {
        const index = prev.findIndex((buffer) => buffer.path === path);
        if (index < 0) {
          return prev;
        }
        const next = prev.filter((buffer) => buffer.path !== path);
        if (activePath === path) {
          const neighbor = next[Math.min(index, next.length - 1)];
          setActivePath(neighbor ? neighbor.path : null);
        }
        return next;
      });
      setSaveConflict(null);
      setEditorError(null);
    },
    [activePath],
  );

  const handleContentChange = useCallback(
    (content: string) => {
      if (!activePath) {
        return;
      }
      patchBuffer(activePath, { content, isDirty: true });
      setSaveConflict(null);
      setEditorError(null);
    },
    [activePath, patchBuffer],
  );

  const handleSave = useCallback(async () => {
    if (!activeBuffer || saving) {
      return;
    }

    setSaving(true);
    setSaveConflict(null);
    setEditorError(null);
    try {
      const res = await saveFile(
        COMPUTER_FILE_API_SCOPE,
        activeBuffer.path,
        activeBuffer.content,
        activeBuffer.versionToken,
      );
      patchBuffer(activeBuffer.path, {
        versionToken: res.versionToken,
        isDirty: false,
        lastSavedAt: Date.now(),
      });
    } catch (err: unknown) {
      if (err instanceof FileSaveConflictError) {
        setSaveConflict(err.conflict);
        return;
      }
      setEditorError(
        reportWorkspaceFileError({
          logContext: 'save failed',
          visiblePrefix: `${activeBuffer.path} 저장에 실패했습니다.`,
          error: err,
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [activeBuffer, patchBuffer, saving]);

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
        upsertBuffer({
          path,
          content: '',
          versionToken: res.versionToken,
          isDirty: false,
          lastSavedAt: null,
        });
        setActivePath(path);
        setSaveConflict(null);
        setEditorError(null);
        return true;
      } catch (err: unknown) {
        setTreeError(
          reportWorkspaceFileError({
            logContext: 'createFile failed',
            visiblePrefix: `${path} 파일을 만들지 못했습니다.`,
            error: err,
          }),
        );
        return false;
      }
    },
    [loadTree, upsertBuffer],
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
          setBuffers((prev) =>
            prev.filter(
              (buffer) =>
                buffer.path !== path && !buffer.path.startsWith(`${path}/`),
            ),
          );
          setActivePath((prev) =>
            prev !== null && (prev === path || prev.startsWith(`${path}/`))
              ? null
              : prev,
          );
        }
        if (
          (operation === 'rename' || operation === 'move') &&
          destination !== undefined
        ) {
          const remap = (bufferPath: string): string =>
            bufferPath === path
              ? destination
              : bufferPath.startsWith(`${path}/`)
                ? `${destination}${bufferPath.slice(path.length)}`
                : bufferPath;
          setBuffers((prev) =>
            prev.map((buffer) => ({ ...buffer, path: remap(buffer.path) })),
          );
          setActivePath((prev) => (prev === null ? prev : remap(prev)));
        }
        await loadTree();
        return true;
      } catch (err: unknown) {
        setTreeError(
          reportWorkspaceFileError({
            logContext: `manage ${operation} failed`,
            visiblePrefix: `${path} ${operation} 작업에 실패했습니다.`,
            error: err,
          }),
        );
        return false;
      }
    },
    [loadTree],
  );

  const handleConflictReload = useCallback(async () => {
    if (!activePath) {
      return;
    }
    setOpeningFile(true);
    try {
      const res = await readFile(COMPUTER_FILE_API_SCOPE, activePath);
      upsertBuffer({
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
        reportWorkspaceFileError({
          logContext: 'conflict reload failed',
          visiblePrefix: `${activePath} 파일을 다시 불러오지 못했습니다.`,
          error: err,
        }),
      );
    } finally {
      setOpeningFile(false);
    }
  }, [activePath, upsertBuffer]);

  // "본문에 삽입" (§3.1.3) — plain editor에서는 caret을 알 수 없으므로
  // 문서 끝 append 전 confirm (§10.18 no-caret 규칙)
  const insertFileIntoActiveBuffer = useCallback(
    async (path: string) => {
      if (!activeBuffer) {
        setEditorError('본문에 삽입하려면 먼저 문서를 열어야 합니다.');
        return;
      }
      try {
        const res = await readFile(COMPUTER_FILE_API_SCOPE, path);
        if (
          !window.confirm(
            `${activeBuffer.path} 문서 끝에 ${path} 내용을 추가할까요?`,
          )
        ) {
          return;
        }
        patchBuffer(activeBuffer.path, {
          content: `${activeBuffer.content}\n\n${res.content}`,
          isDirty: true,
        });
      } catch (err: unknown) {
        setEditorError(
          reportWorkspaceFileError({
            logContext: 'insert into buffer failed',
            visiblePrefix: `${path} 내용을 삽입하지 못했습니다.`,
            error: err,
          }),
        );
      }
    },
    [activeBuffer, patchBuffer],
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
        reportWorkspaceFileError({
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
    if (!activeBuffer || !saveConflict || saving) {
      return;
    }

    const copyPath = buildConflictCopyPath(activeBuffer.path);
    setSaving(true);
    setEditorError(null);
    try {
      const res = await saveFile(
        COMPUTER_FILE_API_SCOPE,
        copyPath,
        activeBuffer.content,
        CREATE_ONLY_VERSION_TOKEN,
      );
      await loadTree();
      upsertBuffer({
        path: copyPath,
        content: activeBuffer.content,
        versionToken: res.versionToken,
        isDirty: false,
        lastSavedAt: Date.now(),
      });
      setActivePath(copyPath);
      setSaveConflict(null);
    } catch (err: unknown) {
      setEditorError(
        reportWorkspaceFileError({
          logContext: 'conflict save-as-copy failed',
          visiblePrefix: `${copyPath}로 사본 저장에 실패했습니다.`,
          error: err,
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [activeBuffer, loadTree, saveConflict, saving, upsertBuffer]);

  return {
    tree,
    treeError: treeError ?? computerFileScopeError,
    binaryPreview,
    extractedDocument: activeBuffer?.extractedDocument ?? null,
    browseEnabled,
    browseShortcuts,
    browsePath,
    browseStartPath,
    navigateUp,
    navigateInto,
    selectedFile: activePath,
    fileContent: activeBuffer?.content ?? '',
    isDirty: activeBuffer?.isDirty ?? false,
    saveConflict,
    editorError,
    saving,
    openingFile,
    lastSavedAt: activeBuffer?.lastSavedAt ?? null,
    openFiles: buffers.map(
      (buffer): OpenFileTab => ({
        path: buffer.path,
        isDirty: buffer.isDirty,
      }),
    ),
    loadTree,
    loadSubtree,
    openFile,
    openProjectFile,
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
