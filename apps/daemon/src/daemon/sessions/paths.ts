import { join } from 'node:path';
import { joinWorkspaceGeulbatPath } from '../files/geulbat-internal-paths.js';
import { assertSessionThreadId as assertValidThreadId } from './contract.js';

function sessionsDir(workspaceRoot: string): string {
  return joinWorkspaceGeulbatPath(workspaceRoot, 'sessions');
}

export function threadFilePath(
  workspaceRoot: string,
  threadId: string,
): string {
  return join(
    sessionsDir(workspaceRoot),
    `${assertValidThreadId(threadId)}.jsonl`,
  );
}

export function indexFilePath(workspaceRoot: string): string {
  return join(sessionsDir(workspaceRoot), 'index.json');
}

export function summaryFilePath(
  workspaceRoot: string,
  threadId: string,
): string {
  return join(
    sessionsDir(workspaceRoot),
    `${assertValidThreadId(threadId)}.summary.md`,
  );
}

export function artifactStoreFilePath(
  workspaceRoot: string,
  threadId: string,
): string {
  return join(
    sessionsDir(workspaceRoot),
    `${assertValidThreadId(threadId)}.artifacts.json`,
  );
}

// 스레드 스코프 media 파일 디렉터리(video-generation-open §4.6) — 스냅샷에
// 인라인하지 않는 생성 바이트(<sha256>.<ext>)가 여기 산다. 스레드 삭제와
// 수명을 같이한다(delete-thread가 동반 정리).
//
// 무거운 생성 출력(이미지·동영상)은 가벼운 세션 텍스트 상태(sessions/)와
// 섞지 않고 전용 트리에 둔다(사용자 결정 2026-07-13):
//   .geulbat/media/<threadId>/<sha256>.<ext>
export function threadMediaDirPath(
  workspaceRoot: string,
  threadId: string,
): string {
  return joinWorkspaceGeulbatPath(
    workspaceRoot,
    'media',
    assertValidThreadId(threadId),
  );
}
