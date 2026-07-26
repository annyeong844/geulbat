import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

import type { ManageFileOperation } from '../../lib/api/files.js';
import { baseNameOf, parentDirOf } from '../../lib/path-name.js';

type CreateKind = 'file' | 'folder';

interface CreatingState {
  directory: string;
  kind: CreateKind;
}

interface UseTreeMutationsArgs {
  onCreateFile: (path: string) => Promise<boolean>;
  onManageEntry: (
    operation: ManageFileOperation,
    path: string,
    destination?: string,
  ) => Promise<boolean>;
  // 커밋 성공을 사용자에게 알린다 (토스트는 트리 셸이 소유).
  showToast: (message: string) => void;
  // 변형 시작 시 열려 있던 컨텍스트 메뉴를 닫는다 (다른 관심사).
  closeContextMenu: () => void;
  // 생성 대상 폴더를 펼쳐 새 항목이 보이게 한다 (펼침 상태는 다른 관심사).
  expandDirectory: (directory: string) => void;
}

interface TreeMutations {
  creating: CreatingState | null;
  createName: string;
  setCreateName: (name: string) => void;
  renamingPath: string | null;
  renameValue: string;
  setRenameValue: (value: string) => void;
  confirmDeletePath: string | null;
  setConfirmDeletePath: (path: string | null) => void;
  editInputRef: RefObject<HTMLInputElement | null>;
  startCreate: (directory: string, kind: CreateKind) => void;
  commitCreate: () => Promise<void>;
  cancelCreate: () => void;
  startRename: (path: string) => void;
  commitRename: () => Promise<void>;
  cancelRename: () => void;
  requestDelete: (path: string) => void;
  commitDelete: () => Promise<void>;
}

// 트리 파일 변형(생성/이름변경/삭제)의 편집 상태와 커밋 로직을 한곳에 모은다.
// daemon mutation은 onCreateFile/onManageEntry로 위임하고, 컨텍스트 메뉴 닫기·
// 폴더 펼침·토스트처럼 다른 관심사가 소유한 부수효과는 콜백으로 주입받는다.
export function useTreeMutations({
  onCreateFile,
  onManageEntry,
  showToast,
  closeContextMenu,
  expandDirectory,
}: UseTreeMutationsArgs): TreeMutations {
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [createName, setCreateName] = useState('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(
    null,
  );
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (creating !== null || renamingPath !== null) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [creating, renamingPath]);

  const startCreate = useCallback(
    (directory: string, kind: CreateKind) => {
      setCreating({ directory, kind });
      setCreateName('');
      closeContextMenu();
      if (directory !== '') {
        expandDirectory(directory);
      }
    },
    [closeContextMenu, expandDirectory],
  );

  const commitCreate = useCallback(async () => {
    const pending = creating;
    const name = createName.trim();
    setCreating(null);
    if (!pending || !name) {
      return;
    }
    const path =
      pending.directory === '' ? name : `${pending.directory}/${name}`;
    const created =
      pending.kind === 'file'
        ? await onCreateFile(path)
        : await onManageEntry('mkdir', path);
    if (created) {
      showToast(
        pending.kind === 'file'
          ? `${name} 파일을 만들었습니다.`
          : `${name} 폴더를 만들었습니다.`,
      );
    }
  }, [createName, creating, onCreateFile, onManageEntry, showToast]);

  const cancelCreate = useCallback(() => setCreating(null), []);

  const startRename = useCallback(
    (path: string) => {
      setRenamingPath(path);
      setRenameValue(baseNameOf(path));
      closeContextMenu();
    },
    [closeContextMenu],
  );

  const commitRename = useCallback(async () => {
    const path = renamingPath;
    const nextName = renameValue.trim();
    setRenamingPath(null);
    if (!path || !nextName || nextName === baseNameOf(path)) {
      return;
    }
    const parent = parentDirOf(path);
    const destination = parent === '' ? nextName : `${parent}/${nextName}`;
    const renamed = await onManageEntry('rename', path, destination);
    if (renamed) {
      showToast(`${nextName}(으)로 이름을 바꿨습니다.`);
    }
  }, [onManageEntry, renameValue, renamingPath, showToast]);

  const cancelRename = useCallback(() => setRenamingPath(null), []);

  const requestDelete = useCallback(
    (path: string) => {
      setConfirmDeletePath(path);
      closeContextMenu();
    },
    [closeContextMenu],
  );

  const commitDelete = useCallback(async () => {
    const path = confirmDeletePath;
    setConfirmDeletePath(null);
    if (!path) {
      return;
    }
    const deleted = await onManageEntry('delete', path);
    if (deleted) {
      showToast(`${baseNameOf(path)}을(를) 삭제했습니다.`);
    }
  }, [confirmDeletePath, onManageEntry, showToast]);

  return {
    creating,
    createName,
    setCreateName,
    renamingPath,
    renameValue,
    setRenameValue,
    confirmDeletePath,
    setConfirmDeletePath,
    editInputRef,
    startCreate,
    commitCreate,
    cancelCreate,
    startRename,
    commitRename,
    cancelRename,
    requestDelete,
    commitDelete,
  };
}
