import { randomUUID } from 'node:crypto';

import {
  buildCommandHostJournalPath,
  openSpawnJournal,
  type JournalTerminalDescriptor,
  type SpawnJournal,
} from './journal.js';
import type { SessionEntry } from './session-core.js';

// §5.1 — 저널은 stateRoot당 하나다. 워커는 stateRoot 하나만 서빙하지만 인라인
// 코어는 여러 워크스페이스를 서빙하므로 지연 생성으로 대칭을 맞춘다. 이 인스턴스가
// 연 저널을 추적해 종료·quiescence 판정의 근거로 삼는다.
interface JournalRegistry {
  journalFor(stateRoot: string): Promise<SpawnJournal>;
  // §6.3 — 저널 append/fdatasync 진행 중이면 종료하지 않는다.
  hasPendingCriticalIo(): boolean;
  closeAll(): Promise<void>;
}

export function createJournalRegistry(): JournalRegistry {
  const instanceId = randomUUID();
  const journalPromises = new Map<string, Promise<SpawnJournal>>();
  const openJournals = new Set<SpawnJournal>();

  function journalFor(stateRoot: string): Promise<SpawnJournal> {
    const existing = journalPromises.get(stateRoot);
    if (existing !== undefined) {
      return existing;
    }
    const created = openSpawnJournal({
      path: buildCommandHostJournalPath(stateRoot),
      workerInstanceId: instanceId,
    }).then((journal) => {
      openJournals.add(journal);
      return journal;
    });
    journalPromises.set(stateRoot, created);
    void created.catch(() => {
      // 실패한 약속을 남기면 영구히 재시도가 막힌다.
      journalPromises.delete(stateRoot);
    });
    return created;
  }

  return {
    journalFor,
    hasPendingCriticalIo(): boolean {
      for (const journal of openJournals) {
        if (journal.pendingCriticalIo() > 0) {
          return true;
        }
      }
      return false;
    },
    async closeAll(): Promise<void> {
      for (const journal of [...openJournals]) {
        await journal.close();
      }
      openJournals.clear();
      journalPromises.clear();
    },
  };
}

// closed 행을 엔트리의 저널에 쓴다 — 레지스트리 상태가 아니라 entry.journal에
// 작용한다. 유실은 치명적이지 않다(기동 복구가 metadata reconcile로 정리, §5.2).
export async function appendClosedRow(
  entry: SessionEntry,
  phase: 'finished' | 'discarded',
  terminal?: JournalTerminalDescriptor,
): Promise<void> {
  if (entry.journalClosed) {
    return;
  }
  entry.journalClosed = true;
  await entry.journal
    .appendClosed({
      sessionId: entry.sessionId,
      phase,
      ...(terminal === undefined ? {} : { terminal }),
      ...(entry.terminalMetaDirty ? { terminalMetaDirty: true } : {}),
    })
    .catch(() => undefined);
}
