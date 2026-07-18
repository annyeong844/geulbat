// 대기 중 스티어 큐 — 입력창 위에 잡혀 있다가 모델이 소비하는 순간
// 대화(사용자 말풍선)로 합류한다. 소비 전에는 🗑로 취소할 수 있고,
// ⚡ 지금 반영으로 다음 라운드를 기다리지 않고 즉시 밀어넣을 수 있다.
export interface PendingSteerItem {
  receivedSeq: number;
  text: string;
}

export function PendingSteerList(props: {
  steers: readonly PendingSteerItem[];
  onCancel: (receivedSeq: number) => void;
  onFlush?: () => void;
  flushRequested?: boolean;
}) {
  const { steers, onCancel, onFlush, flushRequested = false } = props;
  if (steers.length === 0) {
    return null;
  }

  const hint = flushRequested ? '곧 반영됩니다…' : '다음 라운드에 반영';

  return (
    <div className="pending-steer-list">
      {steers.map((steer) => (
        <div className="pending-steer-row" key={steer.receivedSeq}>
          <span className="pending-steer-glyph" aria-hidden="true">
            ⎿
          </span>
          <span className="pending-steer-text">{steer.text}</span>
          <span className="pending-steer-hint">{hint}</span>
          <button
            type="button"
            className="pending-steer-cancel"
            title="대기 중 메시지 삭제"
            aria-label="대기 중 메시지 삭제"
            onClick={() => onCancel(steer.receivedSeq)}
          >
            🗑
          </button>
        </div>
      ))}
      {onFlush !== undefined && !flushRequested ? (
        <div className="pending-steer-flush-row">
          <button
            type="button"
            className="pending-steer-flush"
            title="다음 라운드를 기다리지 않고 지금 반영"
            aria-label="지금 반영"
            onClick={() => onFlush()}
          >
            ⚡ 지금 반영
          </button>
        </div>
      ) : null}
    </div>
  );
}
