import { sessionManagerStyles as styles } from './thread-list-styles.js';

interface Props {
  count: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

// 대량 삭제 확인 팝업 — 화면 가운데 다이얼로그. 순수 표현 컴포넌트로,
// 세션 상태는 소유하지 않고 개수·진행중 여부와 두 콜백만 받는다.
export function SessionDeleteDialog({
  count,
  busy,
  onCancel,
  onConfirm,
}: Props) {
  return (
    <>
      <button
        type="button"
        className="video-settings-backdrop"
        aria-label="삭제 취소"
        onClick={onCancel}
      />
      <div
        className="video-settings-card session-confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-label="세션 삭제 확인"
      >
        <strong className="session-confirm-title">
          {count}개 세션을 삭제할까요?
        </strong>
        <p className="session-confirm-body">
          삭제한 세션은 되돌릴 수 없습니다.
        </p>
        <div className="session-confirm-actions">
          <button
            type="button"
            style={styles.headerButton}
            disabled={busy}
            onClick={onCancel}
          >
            취소
          </button>
          <button
            type="button"
            style={styles.dangerButton}
            disabled={busy || count === 0}
            onClick={onConfirm}
          >
            {busy ? '삭제 중…' : '삭제'}
          </button>
        </div>
      </div>
    </>
  );
}
