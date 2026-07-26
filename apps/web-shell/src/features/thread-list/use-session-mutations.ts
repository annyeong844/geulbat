import { useState } from 'react';
import type { ThreadSummary } from '@geulbat/protocol/threads';

import {
  ThreadDeleteConflictError,
  deleteThread,
  renameThread,
  setThreadPinned,
} from '../../lib/api/threads.js';

interface SessionMutationsParams {
  selectedThreadId: string | null;
  onRefresh: () => Promise<void> | void;
  // 열려 있던 세션이 삭제됐을 때 셸을 빈 세션으로 되돌린다
  onSelectedThreadDeleted: () => void;
  // 삭제 성공 후 선택/확인 상태를 정리한다 (오버레이 UI 소유)
  clearSelection: () => void;
  // 이름 변경 성공(또는 빈 입력)이면 편집 모드를 닫는다 (오버레이 UI 소유)
  closeRename: () => void;
}

interface SessionMutations {
  busy: boolean;
  notice: string | null;
  setNotice: (value: string | null) => void;
  deleteThreads: (threadIds: readonly string[]) => Promise<void>;
  submitRename: (threadId: string, draft: string) => Promise<void>;
  togglePin: (thread: ThreadSummary) => Promise<void>;
}

// 세션 목록의 부작용 액션(삭제·이름변경·고정)을 로딩/오류 상태와 함께 소유한다.
// 렌더·선택 UI 상태는 소유하지 않고, 성공 시 정리를 주입받은 콜백에 위임해
// SessionManagerOverlay의 렌더 책임과 분리한다.
export function useSessionMutations(
  params: SessionMutationsParams,
): SessionMutations {
  const {
    selectedThreadId,
    onRefresh,
    onSelectedThreadDeleted,
    clearSelection,
    closeRename,
  } = params;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const togglePin = async (thread: ThreadSummary) => {
    setBusy(true);
    setNotice(null);
    try {
      await setThreadPinned(thread.threadId, thread.pinned !== true);
      await onRefresh();
    } catch (error: unknown) {
      setNotice(
        error instanceof Error
          ? error.message
          : '고정 상태 변경에 실패했습니다.',
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteThreads = async (threadIds: readonly string[]) => {
    setBusy(true);
    setNotice(null);
    let deletedSelected = false;
    let blockedCount = 0;
    try {
      for (const threadId of threadIds) {
        try {
          await deleteThread(threadId);
          if (threadId === selectedThreadId) {
            deletedSelected = true;
          }
        } catch (error: unknown) {
          if (error instanceof ThreadDeleteConflictError) {
            blockedCount += 1;
            continue;
          }
          throw error;
        }
      }
      if (blockedCount > 0) {
        setNotice(
          `실행 중인 세션 ${blockedCount}개는 삭제할 수 없었습니다. 실행을 멈춘 뒤 다시 시도해 주세요.`,
        );
      }
      if (deletedSelected) {
        onSelectedThreadDeleted();
      }
      await onRefresh();
      clearSelection();
    } catch (error: unknown) {
      setNotice(
        error instanceof Error ? error.message : '삭제에 실패했습니다.',
      );
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async (threadId: string, draft: string) => {
    const title = draft.trim();
    if (title === '') {
      closeRename();
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await renameThread(threadId, title);
      await onRefresh();
      closeRename();
    } catch (error: unknown) {
      setNotice(
        error instanceof Error ? error.message : '이름 변경에 실패했습니다.',
      );
    } finally {
      setBusy(false);
    }
  };

  return { busy, notice, setNotice, deleteThreads, submitRename, togglePin };
}
