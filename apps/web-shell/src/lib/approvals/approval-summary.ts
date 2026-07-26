import type { ApprovalRequired } from '@geulbat/protocol/run-approval';
import {
  isWellKnownApprovalClass,
  type WellKnownApprovalClass,
} from '@geulbat/protocol/run-approval';

interface ApprovalSummary {
  // 대화체 한 줄 요약 — "폴더를 만들려고 해요" (승인 카드 전용)
  title: string;
  // 명사형 짧은 라벨 — "폴더 만들기" (채팅 속 기록 줄 전용, 카드 제목과
  // 문장이 겹쳐 "요청이 두 개?"로 읽히지 않게 어휘를 분리한다)
  label: string;
  // 대상(경로·명령 등) — 카드가 mono로 조용히 그린다
  detail: string | null;
}

// Computer 파일 변경 클래스는 ':computer' 접미사가 붙는다
// (approval-runtime-policy). 요약은 접미사를 벗긴 기본 클래스로 매칭한다.
const COMPUTER_CLASS_SUFFIX = ':computer';

export function buildApprovalSummary(
  pending: ApprovalRequired,
): ApprovalSummary {
  const baseClass = pending.approvalClass.endsWith(COMPUTER_CLASS_SUFFIX)
    ? pending.approvalClass.slice(0, -COMPUTER_CLASS_SUFFIX.length)
    : pending.approvalClass;
  if (!isWellKnownApprovalClass(baseClass)) {
    return {
      title: `${pending.toolName} 도구를 쓰려고 해요`,
      label: pending.toolName,
      detail: readStringArg(pending.argumentsPreview, 'path'),
    };
  }

  return buildWellKnownApprovalSummary(pending, baseClass);
}

function buildWellKnownApprovalSummary(
  pending: ApprovalRequired,
  approvalClass: WellKnownApprovalClass,
): ApprovalSummary {
  const args = pending.argumentsPreview;
  const path = readStringArg(args, 'path');
  const destination = readStringArg(args, 'destination');

  switch (approvalClass) {
    case 'write_file':
      return {
        title: '파일을 쓰려고 해요',
        label: '파일 쓰기',
        detail: path,
      };
    case 'apply_patch':
      return {
        title: '파일을 고치려고 해요',
        label: '파일 수정',
        detail: readApplyPatchTarget(readStringArg(args, 'patch') ?? ''),
      };
    case 'manage_files:create':
      return {
        title: '파일을 만들려고 해요',
        label: '파일 만들기',
        detail: path,
      };
    case 'manage_files:rename':
      return {
        title: '이름을 바꾸려고 해요',
        label: '이름 변경',
        detail: path && destination ? `${path} → ${destination}` : path,
      };
    case 'manage_files:move':
      return {
        title: '파일을 옮기려고 해요',
        label: '파일 이동',
        detail: path && destination ? `${path} → ${destination}` : path,
      };
    case 'manage_files:mkdir':
      return {
        title: '폴더를 만들려고 해요',
        label: '폴더 만들기',
        detail: path,
      };
    case 'manage_files:delete':
      return {
        title: '삭제하려고 해요',
        label: '삭제',
        detail: path,
      };
    case 'manage_files':
      return {
        title: '파일을 정리하려고 해요',
        label: '파일 정리',
        detail: path,
      };
    case 'refresh_memory_index':
      return {
        title: '메모리 색인을 다시 만들려고 해요',
        label: '메모리 색인 재구성',
        detail: null,
      };
    case 'exec_command':
      return {
        title: '명령을 실행하려고 해요',
        label: '명령 실행',
        detail: readStringArg(args, 'cmd'),
      };
  }
}

function readStringArg(
  args: ApprovalRequired['argumentsPreview'],
  key: string,
): string | null {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readApplyPatchTarget(patch: string): string | null {
  const targetPrefixes = [
    '*** Add File: ',
    '*** Update File: ',
    '*** Delete File: ',
  ];
  for (const line of patch.split('\n')) {
    for (const prefix of targetPrefixes) {
      if (line.startsWith(prefix)) {
        const target = line.slice(prefix.length).trim();
        return target.length > 0 ? target : null;
      }
    }
  }
  return null;
}
